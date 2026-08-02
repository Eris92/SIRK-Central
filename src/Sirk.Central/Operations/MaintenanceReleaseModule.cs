using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;

namespace Sirk.Central.Operations;

internal sealed record MaintenancePolicy(bool AutomaticUpdates, string Channel, int RetainBackups, string MaintenanceWindow, DateTimeOffset UpdatedAtUtc, string UpdatedBy);
internal sealed record UpdateRequest(string? Version, string? Channel, bool DryRun, string Confirmation);
internal sealed record UpdateJob(string Id, string State, string Version, string Channel, bool DryRun, DateTimeOffset CreatedAtUtc, string RequestedBy, string? Error);
internal sealed record OperationsState(int Schema, MaintenancePolicy Policy, Dictionary<string, UpdateJob> Jobs);
internal sealed record PortalReleaseMetadata(
    int SchemaVersion,
    string ApplicationId,
    string Version,
    string Channel,
    string PackageUrl,
    string Sha256,
    string Architecture,
    DateTimeOffset? PublishedAtUtc,
    string Commit,
    string? KeyId,
    string? Signature);

internal sealed class OperationsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object _sync = new();
    private readonly string _path;
    private OperationsState _state;

    public OperationsStore(IOptions<SecurityOptions> options)
    {
        Directory.CreateDirectory(options.Value.DataRoot);
        _path = Path.Combine(options.Value.DataRoot, "operations.net10.json");
        _state = Load() ?? new OperationsState(1,
            new MaintenancePolicy(false, "stable", 10, "Sun 02:00-04:00", DateTimeOffset.UtcNow, "system"), []);
        if (_state.Schema != 1) throw new InvalidDataException("Operations store schema is unsupported.");
    }

    public MaintenancePolicy Policy() { lock (_sync) return _state.Policy; }
    public IReadOnlyList<UpdateJob> Jobs() { lock (_sync) return _state.Jobs.Values.OrderByDescending(x => x.CreatedAtUtc).ToArray(); }

    public MaintenancePolicy SavePolicy(MaintenancePolicy input, string actor)
    {
        var channel = NormalizeChannel(input.Channel);
        if (input.RetainBackups is < 2 or > 100) throw new InvalidDataException("RetainBackups must be 2-100.");
        var window = NormalizeText(input.MaintenanceWindow, 80);
        lock (_sync)
        {
            var value = new MaintenancePolicy(input.AutomaticUpdates, channel, input.RetainBackups, window, DateTimeOffset.UtcNow, actor);
            _state = _state with { Policy = value };
            Persist();
            return value;
        }
    }

    public UpdateJob Queue(UpdateRequest input, string actor)
    {
        if (!string.Equals(input.Confirmation, "UPDATE SIRK CENTRAL", StringComparison.Ordinal))
            throw new InvalidDataException("Update confirmation phrase is invalid.");
        var channel = NormalizeChannel(input.Channel ?? _state.Policy.Channel);
        var version = string.IsNullOrWhiteSpace(input.Version) ? "latest" : NormalizeVersion(input.Version);
        lock (_sync)
        {
            if (_state.Jobs.Values.Any(x => x.State is "queued" or "running"))
                throw new InvalidOperationException("Another update job is already active.");
            var job = new UpdateJob("upd-" + Guid.NewGuid().ToString("N"), "queued", version, channel, input.DryRun, DateTimeOffset.UtcNow, actor, null);
            _state.Jobs[job.Id] = job;
            Persist();
            return job;
        }
    }

    public UpdateJob Complete(string id, bool success, string? error)
    {
        lock (_sync)
        {
            if (!_state.Jobs.TryGetValue(id, out var job)) throw new KeyNotFoundException("Update job was not found.");
            job = job with { State = success ? "completed" : "failed", Error = success ? null : NormalizeText(error, 500) };
            _state.Jobs[id] = job;
            Persist();
            return job;
        }
    }

    private OperationsState? Load()
    {
        if (!File.Exists(_path)) return null;
        using var stream = File.OpenRead(_path);
        return JsonSerializer.Deserialize<OperationsState>(stream, JsonOptions);
    }

    private void Persist()
    {
        var temporary = $"{_path}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, _state, JsonOptions);
                stream.Flush(true);
            }
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(temporary, _path, true);
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(_path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        finally { File.Delete(temporary); }
    }

    private static string NormalizeChannel(string? value) => (value ?? string.Empty).Trim().ToLowerInvariant() switch
    { "stable" => "stable", "dev" => "dev", _ => throw new InvalidDataException("Channel must be stable or dev.") };

    private static string NormalizeVersion(string? value)
    {
        var result = (value ?? string.Empty).Trim();
        if (result.Length is < 1 or > 80 || result.Any(ch => !(char.IsAsciiLetterOrDigit(ch) || ch is '.' or '+' or '_' or '-')))
            throw new InvalidDataException("Version is invalid.");
        return result;
    }

    private static string NormalizeText(string? value, int max)
    {
        var result = (value ?? string.Empty).Trim();
        if (result.Length > max) throw new InvalidDataException("Text is too long.");
        return new string(result.Select(ch => char.IsControl(ch) ? ' ' : ch).ToArray());
    }
}

internal sealed class PortalReleaseCatalog : IDisposable
{
    private static readonly HashSet<string> TrustedHosts = new(StringComparer.OrdinalIgnoreCase)
    { "api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com" };
    private readonly HttpClient _client;
    private readonly object _sync = new();
    private readonly Dictionary<string, (DateTimeOffset Expires, PortalReleaseMetadata Value)> _cache = [];
    private readonly byte[]? _publicKey;
    private readonly bool _requireSignature;

    public PortalReleaseCatalog(IOptions<SecurityOptions> options, IHostEnvironment environment)
    {
        _client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(15) };
        _client.DefaultRequestHeaders.UserAgent.ParseAdd("SIRK-Central/.NET10");
        _client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        _client.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
        _requireSignature = options.Value.RequireSignedReleases && !environment.IsDevelopment();
        _publicKey = LoadPublicKey(options.Value.ReleaseSigningPublicKeyFile, _requireSignature);
    }

    public async Task<PortalReleaseMetadata> LatestAsync(string channel, CancellationToken cancellationToken)
    {
        channel = channel == "stable" ? "stable" : "dev";
        lock (_sync) if (_cache.TryGetValue(channel, out var cached) && cached.Expires > DateTimeOffset.UtcNow) return cached.Value;
        using var response = await GetTrustedAsync(new Uri("https://api.github.com/repos/Eris92/SIRK-Portal/releases?per_page=30"), cancellationToken);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        if (document.RootElement.ValueKind != JsonValueKind.Array) throw new InvalidDataException("GitHub releases response is invalid.");
        Uri? metadataUri = null;
        foreach (var release in document.RootElement.EnumerateArray())
        {
            if (release.TryGetProperty("draft", out var draft) && draft.GetBoolean()) continue;
            if (channel == "stable" && release.TryGetProperty("prerelease", out var pre) && pre.GetBoolean()) continue;
            if (!release.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Array) continue;
            foreach (var asset in assets.EnumerateArray())
            {
                var name = asset.GetProperty("name").GetString() ?? string.Empty;
                if (!name.StartsWith("SIRK-Portal-", StringComparison.OrdinalIgnoreCase) || !name.EndsWith("-release.json", StringComparison.OrdinalIgnoreCase)) continue;
                var url = asset.GetProperty("browser_download_url").GetString();
                if (url is not null) metadataUri = ValidateTrustedUri(url);
                break;
            }
            if (metadataUri is not null) break;
        }
        if (metadataUri is null) throw new KeyNotFoundException("No matching SIRK Portal release was found.");
        using var metadataResponse = await GetTrustedAsync(metadataUri, cancellationToken);
        var metadata = await metadataResponse.Content.ReadFromJsonAsync<PortalReleaseMetadata>(cancellationToken: cancellationToken)
            ?? throw new InvalidDataException("Portal release metadata is empty.");
        metadata = Validate(metadata, channel, _publicKey, _requireSignature);
        lock (_sync) _cache[channel] = (DateTimeOffset.UtcNow.AddMinutes(5), metadata);
        return metadata;
    }

    private async Task<HttpResponseMessage> GetTrustedAsync(Uri uri, CancellationToken cancellationToken)
    {
        for (var redirect = 0; redirect <= 3; redirect++)
        {
            ValidateTrustedUri(uri.ToString());
            var response = await _client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if ((int)response.StatusCode is >= 300 and < 400 && response.Headers.Location is not null)
            {
                var next = response.Headers.Location.IsAbsoluteUri ? response.Headers.Location : new Uri(uri, response.Headers.Location);
                response.Dispose();
                uri = ValidateTrustedUri(next.ToString());
                continue;
            }
            response.EnsureSuccessStatusCode();
            if (response.Content.Headers.ContentLength is > 2_097_152)
            {
                response.Dispose();
                throw new InvalidDataException("Release response is too large.");
            }
            return response;
        }
        throw new HttpRequestException("GitHub redirect limit exceeded.");
    }

    internal static PortalReleaseMetadata Validate(
        PortalReleaseMetadata value,
        string requestedChannel,
        byte[]? publicKey = null,
        bool requireSignature = false)
    {
        if (value.SchemaVersion != 1 || value.ApplicationId != "sirk-portal") throw new InvalidDataException("Portal release metadata schema is invalid.");
        if (value.Architecture != "win-x64") throw new InvalidDataException("Portal release architecture is invalid.");
        if (string.IsNullOrWhiteSpace(value.Version) || value.Version.Length > 80 || value.Version.Any(ch => !(char.IsAsciiLetterOrDigit(ch) || ch is '.' or '+' or '_' or '-')))
            throw new InvalidDataException("Portal release version is invalid.");
        if (string.IsNullOrWhiteSpace(value.Sha256) || value.Sha256.Length != 64 || value.Sha256.Any(ch => !Uri.IsHexDigit(ch)))
            throw new InvalidDataException("Portal release SHA-256 is invalid.");
        var packageUri = ValidateTrustedUri(value.PackageUrl);
        if (!packageUri.AbsolutePath.EndsWith("-win-x64.zip", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Portal package asset is invalid.");
        var channel = value.Channel == "stable" ? "stable" : "dev";
        if (requestedChannel == "stable" && channel != "stable")
            throw new InvalidDataException("Stable release metadata has a non-stable channel.");
        var commit = value.Commit ?? string.Empty;
        if (commit.Length > 80) commit = commit[..80];
        var normalized = value with { Channel = channel, Sha256 = value.Sha256.ToUpperInvariant(), Commit = commit };
        VerifySignature(normalized, publicKey, requireSignature);
        return normalized;
    }

    private static void VerifySignature(PortalReleaseMetadata value, byte[]? publicKey, bool required)
    {
        if (publicKey is null)
        {
            if (required) throw new InvalidDataException("Release signing public key is not configured.");
            return;
        }
        if (string.IsNullOrWhiteSpace(value.KeyId) || value.KeyId.Length > 80 ||
            value.KeyId.Any(ch => !(char.IsAsciiLetterOrDigit(ch) || ch is '.' or '_' or '-')))
            throw new InvalidDataException("Release signing key ID is invalid.");
        byte[] signature;
        try { signature = Convert.FromBase64String(value.Signature ?? string.Empty); }
        catch (FormatException exception) { throw new InvalidDataException("Release signature is not valid Base64.", exception); }
        if (signature.Length is < 64 or > 80) throw new InvalidDataException("Release ECDSA signature length is invalid.");
        var data = Encoding.UTF8.GetBytes(CanonicalPayload(value));
        try
        {
            using var ecdsa = ECDsa.Create();
            ecdsa.ImportSubjectPublicKeyInfo(publicKey, out var bytesRead);
            if (bytesRead != publicKey.Length || ecdsa.KeySize != 256)
                throw new InvalidDataException("Release signing key must be an ECDSA P-256 SubjectPublicKeyInfo key.");
            if (!ecdsa.VerifyData(data, signature, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence))
                throw new InvalidDataException("Release metadata signature verification failed.");
        }
        catch (CryptographicException exception)
        {
            throw new InvalidDataException("Release signing public key or signature is invalid.", exception);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(signature);
            CryptographicOperations.ZeroMemory(data);
        }
    }

    internal static string CanonicalPayload(PortalReleaseMetadata value) => string.Join('\n',
        value.SchemaVersion.ToString(System.Globalization.CultureInfo.InvariantCulture),
        value.ApplicationId,
        value.Version,
        value.Channel,
        value.PackageUrl,
        value.Sha256.ToUpperInvariant(),
        value.Architecture,
        value.Commit ?? string.Empty);

    private static byte[]? LoadPublicKey(string path, bool required)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            if (required) throw new InvalidOperationException("Production startup refused: ReleaseSigningPublicKeyFile is required.");
            return null;
        }
        var fullPath = Path.GetFullPath(path);
        var info = new FileInfo(fullPath);
        if (!info.Exists || info.Length is <= 0 or > 4096)
            throw new InvalidDataException("Release signing public key file is missing, empty or too large.");
        try
        {
            var key = Convert.FromBase64String(File.ReadAllText(fullPath).Trim());
            using var ecdsa = ECDsa.Create();
            ecdsa.ImportSubjectPublicKeyInfo(key, out var bytesRead);
            if (bytesRead != key.Length || ecdsa.KeySize != 256)
                throw new InvalidDataException("Release signing key must be ECDSA P-256 SubjectPublicKeyInfo.");
            return key;
        }
        catch (FormatException exception)
        {
            throw new InvalidDataException("Release signing public key is not valid Base64.", exception);
        }
        catch (CryptographicException exception)
        {
            throw new InvalidDataException("Release signing public key is invalid.", exception);
        }
    }

    private static Uri ValidateTrustedUri(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps || !TrustedHosts.Contains(uri.Host) || !string.IsNullOrEmpty(uri.UserInfo))
            throw new InvalidDataException("Release URL is not trusted.");
        return uri;
    }

    public void Dispose()
    {
        _client.Dispose();
        if (_publicKey is not null) CryptographicOperations.ZeroMemory(_publicKey);
    }
}

internal sealed class OperationsMiddleware
{
    private readonly OperationsStore _store;
    private readonly PortalReleaseCatalog _catalog;

    public OperationsMiddleware(IOptions<SecurityOptions> options, IHostEnvironment environment)
    {
        _store = new OperationsStore(options);
        _catalog = new PortalReleaseCatalog(options, environment);
    }

    public async Task<bool> TryHandleAsync(HttpContext context)
    {
        if (!context.Request.Path.StartsWithSegments("/api/v1/operations", out var remainder)) return false;
        if (context.User.Identity?.IsAuthenticated != true || !(context.User.IsInRole(SirkRoles.BreakGlass) || context.User.IsInRole(SirkRoles.Admin) || context.User.IsInRole(SirkRoles.SecAdmin)))
        {
            context.Response.StatusCode = context.User.Identity?.IsAuthenticated == true ? 403 : 401;
            return true;
        }
        try
        {
            if (HttpMethods.IsGet(context.Request.Method) && remainder == "/maintenance")
            {
                await context.Response.WriteAsJsonAsync(new { policy = _store.Policy(), jobs = _store.Jobs() }, context.RequestAborted); return true;
            }
            if (HttpMethods.IsPut(context.Request.Method) && remainder == "/maintenance/policy")
            {
                await ValidateCsrf(context);
                var request = await context.Request.ReadFromJsonAsync<MaintenancePolicy>(cancellationToken: context.RequestAborted) ?? throw new InvalidDataException("Request body is required.");
                await context.Response.WriteAsJsonAsync(_store.SavePolicy(request, Actor(context)), context.RequestAborted); return true;
            }
            if (HttpMethods.IsPost(context.Request.Method) && remainder == "/updates")
            {
                await ValidateCsrf(context);
                var request = await context.Request.ReadFromJsonAsync<UpdateRequest>(cancellationToken: context.RequestAborted) ?? throw new InvalidDataException("Request body is required.");
                context.Response.StatusCode = 202;
                await context.Response.WriteAsJsonAsync(_store.Queue(request, Actor(context)), context.RequestAborted); return true;
            }
            if (HttpMethods.IsGet(context.Request.Method) && remainder == "/portal-releases/latest")
            {
                var channel = context.Request.Query["channel"] == "stable" ? "stable" : "dev";
                await context.Response.WriteAsJsonAsync(new { release = await _catalog.LatestAsync(channel, context.RequestAborted) }, context.RequestAborted); return true;
            }
            context.Response.StatusCode = 404; return true;
        }
        catch (AntiforgeryValidationException) { context.Response.StatusCode = 400; await context.Response.WriteAsJsonAsync(new { code = "CSRF_VALIDATION_FAILED" }); return true; }
        catch (KeyNotFoundException ex) { context.Response.StatusCode = 404; await context.Response.WriteAsJsonAsync(new { error = ex.Message }); return true; }
        catch (Exception ex) when (ex is InvalidDataException or InvalidOperationException) { context.Response.StatusCode = 409; await context.Response.WriteAsJsonAsync(new { error = ex.Message }); return true; }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException) { context.Response.StatusCode = 502; await context.Response.WriteAsJsonAsync(new { code = "PORTAL_RELEASE_LOOKUP_FAILED", error = ex.Message }); return true; }
    }

    private static Task ValidateCsrf(HttpContext context) => context.RequestServices.GetRequiredService<IAntiforgery>().ValidateRequestAsync(context);
    private static string Actor(HttpContext context) => context.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value ?? "unknown";
}
