using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;
using Sirk.Central.Updates;

var root = Path.Combine(Path.GetTempPath(), "sirk-central-update-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    var security = Options.Create(new SecurityOptions
    {
        DataRoot = Path.Combine(root, "security")
    });
    var configuration = new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Sirk:AgentUpdates:PublicBaseUrl"] = "https://central.example.test"
        })
        .Build();

    var tickets = new AgentUpdateTicketService(security, configuration);
    var request = new AgentUpdateTicketRequest("device-001", "win-x64", "stable", "0.1.1.10");
    var discover = tickets.CreateDiscover("portal-001", request);

    var first = tickets.ValidateAndConsume(discover.Ticket, "discover");
    Require(first is not null, "discover ticket must validate once");
    Require(tickets.ValidateAndConsume(discover.Ticket, "discover") is null,
        "discover ticket replay must be rejected");
    Require(tickets.ValidateAndConsume(discover.Ticket + "x", "discover") is null,
        "tampered discover ticket must be rejected");

    var descriptor = new PlatformReleaseDescriptor(
        1,
        "sirk-agent",
        "SIRK Agent",
        "0.1.1.11",
        "win-x64",
        "stable",
        "SIRK-Agent-0.1.1.11-net10-win-x64-framework-dependent.zip",
        1234,
        new string('a', 64),
        new string('b', 40),
        new DateTimeOffset(2026, 8, 8, 5, 0, 0, TimeSpan.Zero),
        new UpdateSignature("ES256", "test", "x"));
    var canonicalDescriptor = Encoding.UTF8.GetString(
        CanonicalUpdateJson.SerializeWithoutTopLevelSignature(descriptor));
    Require(
        canonicalDescriptor.Contains(
            "\"publishedAtUtc\":\"2026-08-08T05:00:00\\u002B00:00\"",
            StringComparison.Ordinal),
        "signed release timestamp canonical form must preserve System.Text.Json escaping");

    var cached = new CachedPlatformUpdate(
        "sirk-agent",
        "0.1.1.11",
        "win-x64",
        "stable",
        new string('a', 64),
        1234,
        Path.Combine(root, "package.zip"),
        descriptor);
    var download = tickets.CreateDownload(first!, cached);
    var downloadFirst = tickets.ValidateAndConsume(download.Ticket, "download");
    Require(downloadFirst is { Version: "0.1.1.11" }, "download ticket must be bound to version");
    Require(downloadFirst?.Sha256 == new string('a', 64), "download ticket must be bound to SHA256");
    Require(tickets.ValidateAndConsume(download.Ticket, "download") is null,
        "download ticket replay must be rejected");

    Require(PlatformUpdateVersion.IsValid("0.1.1.999"), "0.1.1.X must be accepted");
    Require(!PlatformUpdateVersion.IsValid("1.0.0"), "1.0.0 must be rejected by the pre-1.0 gate");
    Require(!PlatformUpdateVersion.IsValid("0.2.0.1"), "non-canonical pre-1.0 version must be rejected");
    Require(PlatformUpdateVersion.Compare("0.1.1.11", "0.1.1.10") > 0, "upgrade ordering is invalid");
    Require(PlatformUpdateVersion.Compare("0.1.1.9", "0.1.1.10") < 0, "rollback ordering is invalid");

    try
    {
        _ = PlatformUpdateDefinitions.Get("sirk-updater");
        throw new InvalidOperationException("SIRK Updater must not be distributed through the Central product cache.");
    }
    catch (KeyNotFoundException)
    {
        // Expected: Updater is the transaction executor, not a cached SIRK product payload.
    }

    Console.WriteLine("SIRK_CENTRAL_AGENT_UPDATE_CONTRACT_OK");

    if (string.Equals(
            Environment.GetEnvironmentVariable("SIRK_REAL_RELEASE_E2E"),
            "1",
            StringComparison.Ordinal))
    {
        await RunRealReleaseE2EAsync(root);
    }

    return 0;
}
finally
{
    try { Directory.Delete(root, recursive: true); } catch { }
}

static async Task RunRealReleaseE2EAsync(string root)
{
    var token = Environment.GetEnvironmentVariable("SIRK_REAL_RELEASE_GITHUB_TOKEN")?.Trim();
    Require(!string.IsNullOrWhiteSpace(token) && token.Length >= 20,
        "real-release E2E requires a GitHub read token");

    var trustedKeysPath = Environment.GetEnvironmentVariable("SIRK_REAL_RELEASE_TRUSTED_KEYS");
    Require(!string.IsNullOrWhiteSpace(trustedKeysPath) && File.Exists(trustedKeysPath),
        "real-release E2E requires a public release trust keyring");

    var exportRoot = Environment.GetEnvironmentVariable("SIRK_REAL_RELEASE_EXPORT_DIR")?.Trim();
    var exportApplicationId = Environment.GetEnvironmentVariable("SIRK_REAL_RELEASE_EXPORT_APPLICATION_ID")?.Trim();
    var exportRuntime = Environment.GetEnvironmentVariable("SIRK_REAL_RELEASE_EXPORT_RUNTIME")?.Trim();
    var exportChannel = Environment.GetEnvironmentVariable("SIRK_REAL_RELEASE_EXPORT_CHANNEL")?.Trim();
    if (!string.IsNullOrWhiteSpace(exportRoot))
    {
        Require(!string.IsNullOrWhiteSpace(exportApplicationId),
            "real-release export requires an application id");
        Require(!string.IsNullOrWhiteSpace(exportRuntime),
            "real-release export requires a runtime");
        Require(exportChannel is "stable" or "preview",
            "real-release export requires stable or preview channel");
        exportRoot = Path.GetFullPath(exportRoot);
        Directory.CreateDirectory(exportRoot);
    }

    var realRoot = Path.Combine(root, "real-release");
    var tokenPath = Path.Combine(realRoot, "github-token");
    var cacheRoot = Path.Combine(realRoot, "cache");
    Directory.CreateDirectory(realRoot);
    await File.WriteAllTextAsync(tokenPath, token!);

    try
    {
        var security = Options.Create(new SecurityOptions
        {
            DataRoot = Path.Combine(realRoot, "security"),
            ReleaseSigningPublicKeyFile = trustedKeysPath!,
            RequireSignedReleases = true
        });
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Sirk:Updates:GitHubTokenFile"] = tokenPath,
                ["Sirk:Updates:CacheRoot"] = cacheRoot,
                ["Sirk:Updates:MetadataTtlSeconds"] = "300",
                ["Sirk:Updates:Retention"] = "3"
            })
            .Build();
        var cache = new PlatformUpdateCache(
            new SingleHttpClientFactory(),
            security,
            configuration,
            NullLogger<PlatformUpdateCache>.Instance);

        var scopes = new (string ApplicationId, string Runtime, string Channel, string MinimumVersion)[]
        {
            ("sirk-agent", "win-x64", "preview", "0.1.1.38"),
            ("sirk-portal", "win-x64", "preview", "0.1.1.3"),
            ("sirk-portal", "linux-x64", "preview", "0.1.1.3"),
            ("sirk-central", "linux-x64", "preview", "0.1.1.1"),
            ("sirk-central", "linux-x64", "stable", "0.1.1.2")
        };

        var verified = new List<CachedPlatformUpdate>();
        var exportCompleted = false;
        foreach (var scope in scopes)
        {
            Console.WriteLine($"SIRK_REAL_RELEASE_SCOPE_BEGIN {scope.ApplicationId}/{scope.Runtime}/{scope.Channel}");
            CachedPlatformUpdate? latest;
            try
            {
                latest = await cache.GetLatestAsync(
                    scope.ApplicationId,
                    scope.Runtime,
                    scope.Channel,
                    CancellationToken.None);
            }
            catch (Exception error)
            {
                throw new InvalidOperationException(
                    $"real signed release cache verification failed: {scope.ApplicationId}/{scope.Runtime}/{scope.Channel}",
                    error);
            }

            Require(latest is not null,
                $"real signed release was not discovered: {scope.ApplicationId}/{scope.Runtime}/{scope.Channel}");
            Require(PlatformUpdateVersion.Compare(latest!.Version, scope.MinimumVersion) >= 0,
                $"real signed release is older than the accepted baseline: {scope.ApplicationId}/{scope.Runtime}/{scope.Channel}");
            Require(latest.ApplicationId == scope.ApplicationId &&
                    latest.Runtime == scope.Runtime &&
                    latest.Channel == scope.Channel,
                $"real signed release scope mismatch: {scope.ApplicationId}/{scope.Runtime}/{scope.Channel}");
            Require(latest.Descriptor.ApplicationId == scope.ApplicationId &&
                    latest.Descriptor.Runtime == scope.Runtime &&
                    latest.Descriptor.Channel == scope.Channel &&
                    latest.Descriptor.Version == latest.Version,
                $"real signed descriptor mismatch: {scope.ApplicationId}/{scope.Runtime}/{scope.Channel}");

            var package = cache.GetPackage(
                scope.ApplicationId,
                latest.Version,
                scope.Runtime,
                scope.Channel,
                latest.Sha256);
            Require(File.Exists(package.PackagePath),
                $"verified cache package is missing: {scope.ApplicationId}/{scope.Runtime}/{scope.Channel}");
            Require(new FileInfo(package.PackagePath).Length == package.Size,
                $"verified cache package size mismatch: {scope.ApplicationId}/{scope.Runtime}/{scope.Channel}");

            var second = await cache.GetLatestAsync(
                scope.ApplicationId,
                scope.Runtime,
                scope.Channel,
                CancellationToken.None);
            Require(second is not null &&
                    second.Version == latest.Version &&
                    second.Sha256 == latest.Sha256 &&
                    second.PackagePath == latest.PackagePath,
                $"second discovery did not reuse immutable cache: {scope.ApplicationId}/{scope.Runtime}/{scope.Channel}");

            var status = cache.Status(scope.ApplicationId, scope.Runtime, scope.Channel);
            Require(status.LatestVersion == latest.Version &&
                    status.CachedVersions.Contains(latest.Version, StringComparer.Ordinal),
                $"verified cache status mismatch: {scope.ApplicationId}/{scope.Runtime}/{scope.Channel}");
            verified.Add(latest);

            if (!string.IsNullOrWhiteSpace(exportRoot) &&
                string.Equals(scope.ApplicationId, exportApplicationId, StringComparison.Ordinal) &&
                string.Equals(scope.Runtime, exportRuntime, StringComparison.Ordinal) &&
                string.Equals(scope.Channel, exportChannel, StringComparison.Ordinal))
            {
                await ExportVerifiedReleaseAsync(exportRoot!, package);
                exportCompleted = true;
            }

            Console.WriteLine($"SIRK_REAL_RELEASE_SCOPE_OK {scope.ApplicationId}/{scope.Runtime}/{scope.Channel} {latest.Version}");
        }

        if (!string.IsNullOrWhiteSpace(exportRoot))
            Require(exportCompleted, "requested real-release export scope was not found");

        File.Delete(tokenPath);
        foreach (var release in verified)
        {
            var offline = await cache.GetLatestAsync(
                release.ApplicationId,
                release.Runtime,
                release.Channel,
                CancellationToken.None);
            Require(offline is not null &&
                    offline.Version == release.Version &&
                    offline.Sha256 == release.Sha256,
                $"verified cache was not reusable without GitHub access: {release.ApplicationId}/{release.Runtime}/{release.Channel}");
        }

        Console.WriteLine("SIRK_REAL_SIGNED_RELEASE_CACHE_E2E_OK");
    }
    finally
    {
        if (File.Exists(tokenPath)) File.Delete(tokenPath);
    }
}

static async Task ExportVerifiedReleaseAsync(string exportRoot, CachedPlatformUpdate release)
{
    var packageName = $"{release.ApplicationId}-{release.Version}-{release.Runtime}.zip";
    var packagePath = Path.Combine(exportRoot, packageName);
    File.Copy(release.PackagePath, packagePath, overwrite: true);
    var metadataPath = Path.Combine(exportRoot, "release.json");
    await File.WriteAllTextAsync(
        metadataPath,
        JsonSerializer.Serialize(new
        {
            applicationId = release.ApplicationId,
            version = release.Version,
            runtime = release.Runtime,
            channel = release.Channel,
            sha256 = release.Sha256,
            size = release.Size,
            commit = release.Descriptor.Commit,
            packagePath
        }, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }),
        new UTF8Encoding(false));
    Console.WriteLine($"SIRK_REAL_RELEASE_EXPORTED {release.ApplicationId}/{release.Runtime}/{release.Channel} {release.Version} {packagePath}");
}

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

sealed class SingleHttpClientFactory : IHttpClientFactory
{
    private readonly HttpClient _client = new();

    public HttpClient CreateClient(string name) => _client;
}
