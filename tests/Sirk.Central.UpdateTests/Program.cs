using System.IO.Compression;
using System.Net.Http.Headers;
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

        var scopes = new (string ApplicationId, string Runtime, string MinimumVersion)[]
        {
            ("sirk-agent", "win-x64", "0.1.1.36"),
            ("sirk-portal", "win-x64", "0.1.1.2"),
            ("sirk-portal", "linux-x64", "0.1.1.2"),
            ("sirk-central", "linux-x64", "0.1.1.1")
        };

        var verified = new List<CachedPlatformUpdate>();
        foreach (var scope in scopes)
        {
            Console.WriteLine($"SIRK_REAL_RELEASE_SCOPE_BEGIN {scope.ApplicationId}/{scope.Runtime}");
            CachedPlatformUpdate? latest;
            try
            {
                latest = await cache.GetLatestAsync(
                    scope.ApplicationId,
                    scope.Runtime,
                    "preview",
                    CancellationToken.None);
            }
            catch (Exception error)
            {
                if (scope.ApplicationId == "sirk-agent")
                    await DiagnoseAgentArchiveAsync(token!, realRoot, scope.MinimumVersion);
                throw new InvalidOperationException(
                    $"real signed release cache verification failed: {scope.ApplicationId}/{scope.Runtime}",
                    error);
            }

            Require(latest is not null,
                $"real signed release was not discovered: {scope.ApplicationId}/{scope.Runtime}");
            Require(PlatformUpdateVersion.Compare(latest!.Version, scope.MinimumVersion) >= 0,
                $"real signed release is older than the accepted baseline: {scope.ApplicationId}/{scope.Runtime}");
            Require(latest.ApplicationId == scope.ApplicationId &&
                    latest.Runtime == scope.Runtime &&
                    latest.Channel == "preview",
                $"real signed release scope mismatch: {scope.ApplicationId}/{scope.Runtime}");
            Require(latest.Descriptor.ApplicationId == scope.ApplicationId &&
                    latest.Descriptor.Runtime == scope.Runtime &&
                    latest.Descriptor.Channel == "preview" &&
                    latest.Descriptor.Version == latest.Version,
                $"real signed descriptor mismatch: {scope.ApplicationId}/{scope.Runtime}");

            var package = cache.GetPackage(
                scope.ApplicationId,
                latest.Version,
                scope.Runtime,
                "preview",
                latest.Sha256);
            Require(File.Exists(package.PackagePath),
                $"verified cache package is missing: {scope.ApplicationId}/{scope.Runtime}");
            Require(new FileInfo(package.PackagePath).Length == package.Size,
                $"verified cache package size mismatch: {scope.ApplicationId}/{scope.Runtime}");

            var second = await cache.GetLatestAsync(
                scope.ApplicationId,
                scope.Runtime,
                "preview",
                CancellationToken.None);
            Require(second is not null &&
                    second.Version == latest.Version &&
                    second.Sha256 == latest.Sha256 &&
                    second.PackagePath == latest.PackagePath,
                $"second discovery did not reuse immutable cache: {scope.ApplicationId}/{scope.Runtime}");

            var status = cache.Status(scope.ApplicationId, scope.Runtime, "preview");
            Require(status.LatestVersion == latest.Version &&
                    status.CachedVersions.Contains(latest.Version, StringComparer.Ordinal),
                $"verified cache status mismatch: {scope.ApplicationId}/{scope.Runtime}");
            verified.Add(latest);
            Console.WriteLine($"SIRK_REAL_RELEASE_SCOPE_OK {scope.ApplicationId}/{scope.Runtime} {latest.Version}");
        }

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
                $"verified cache was not reusable without GitHub access: {release.ApplicationId}/{release.Runtime}");
        }

        Console.WriteLine("SIRK_REAL_SIGNED_RELEASE_CACHE_E2E_OK");
    }
    finally
    {
        if (File.Exists(tokenPath)) File.Delete(tokenPath);
    }
}

static async Task DiagnoseAgentArchiveAsync(string token, string root, string version)
{
    using var client = new HttpClient();
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("SIRK-Central-UpdateDiagnostic/1");
    client.DefaultRequestHeaders.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");

    using var releaseResponse = await client.GetAsync(
        $"https://api.github.com/repos/Eris92/SIRK-Agent/releases/tags/v{version}");
    releaseResponse.EnsureSuccessStatusCode();
    using var release = JsonDocument.Parse(await releaseResponse.Content.ReadAsStreamAsync());
    var assetName = $"SIRK-Agent-{version}-net10-win-x64-framework-dependent.zip";
    var assetUrl = release.RootElement.GetProperty("assets")
        .EnumerateArray()
        .Single(asset => asset.GetProperty("name").GetString() == assetName)
        .GetProperty("url")
        .GetString()!;

    using var packageRequest = new HttpRequestMessage(HttpMethod.Get, assetUrl);
    packageRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
    packageRequest.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
    packageRequest.Headers.UserAgent.ParseAdd("SIRK-Central-UpdateDiagnostic/1");
    packageRequest.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");
    using var packageResponse = await client.SendAsync(packageRequest, HttpCompletionOption.ResponseHeadersRead);
    packageResponse.EnsureSuccessStatusCode();
    var packagePath = Path.Combine(root, "agent-diagnostic.zip");
    await using (var output = File.Create(packagePath))
        await packageResponse.Content.CopyToAsync(output);

    using var archive = ZipFile.OpenRead(packagePath);
    var entries = archive.Entries.ToDictionary(
        entry => entry.FullName.Replace('\\', '/'),
        entry => entry,
        StringComparer.OrdinalIgnoreCase);
    var manifestEntry = entries["update-manifest.json"];
    PlatformPackageManifest manifest;
    await using (var input = manifestEntry.Open())
        manifest = (await JsonSerializer.DeserializeAsync<PlatformPackageManifest>(input))!;

    Console.WriteLine($"SIRK_AGENT_ARCHIVE_DIAG entries={entries.Count} manifestFiles={manifest.Files.Count}");
    foreach (var file in manifest.Files)
    {
        var path = file.Path.Replace('\\', '/');
        if (!entries.TryGetValue(path, out var entry))
        {
            Console.WriteLine($"SIRK_AGENT_ARCHIVE_DIAG_MISSING path={path}");
            return;
        }
        if (entry.Length != file.Size)
        {
            Console.WriteLine($"SIRK_AGENT_ARCHIVE_DIAG_SIZE path={path} manifest={file.Size} zip={entry.Length}");
            return;
        }
        if (entry.Length > 80L * 1024 * 1024)
        {
            Console.WriteLine($"SIRK_AGENT_ARCHIVE_DIAG_OVERSIZE path={path} zip={entry.Length}");
            return;
        }
    }
    Console.WriteLine("SIRK_AGENT_ARCHIVE_DIAG_NO_PATH_OR_SIZE_MISMATCH");
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
