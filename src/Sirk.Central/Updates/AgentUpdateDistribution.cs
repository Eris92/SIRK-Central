using System.Collections.Concurrent;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using Sirk.Central.Portals;
using Sirk.Central.Security;

namespace Sirk.Central.Updates;

internal sealed record AgentUpdateTicketRequest(string DeviceId, string Runtime, string Channel, string CurrentVersion);
internal sealed record AgentUpdateTicketResponse(string CentralBaseUrl, string Ticket, DateTimeOffset ExpiresAtUtc);
internal sealed record AgentUpdateLatestResponse(
    string Version,
    string Runtime,
    string Channel,
    long Size,
    string Sha256,
    AgentReleaseDescriptor Descriptor,
    string DownloadTicket,
    DateTimeOffset DownloadTicketExpiresAtUtc);
internal sealed record AgentUpdateCacheStatus(
    string CacheRoot,
    DateTimeOffset? LastSourceCheckUtc,
    string? SourceEtag,
    string? LatestVersion,
    string? LastError,
    IReadOnlyList<string> CachedVersions);

internal sealed record AgentReleaseDescriptor(
    [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
    [property: JsonPropertyName("product")] string Product,
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("runtime")] string Runtime,
    [property: JsonPropertyName("channel")] string Channel,
    [property: JsonPropertyName("assetName")] string AssetName,
    [property: JsonPropertyName("size")] long Size,
    [property: JsonPropertyName("sha256")] string Sha256,
    [property: JsonPropertyName("publishedAtUtc")] DateTimeOffset PublishedAtUtc,
    [property: JsonPropertyName("signature")] UpdateSignature Signature);
internal sealed record UpdateSignature(
    [property: JsonPropertyName("algorithm")] string Algorithm,
    [property: JsonPropertyName("keyId")] string KeyId,
    [property: JsonPropertyName("value")] string Value);
internal sealed record AgentPackageManifest(
    [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
    [property: JsonPropertyName("product")] string Product,
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("runtime")] string Runtime,
    [property: JsonPropertyName("files")] IReadOnlyList<AgentPackageManifestFile> Files,
    [property: JsonPropertyName("signature")] UpdateSignature Signature);
internal sealed record AgentPackageManifestFile(
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("sha256")] string Sha256);
internal sealed record TrustedKeyDocument(IReadOnlyList<TrustedKeyEntry> Keys);
internal sealed record TrustedKeyEntry(string KeyId, string PublicKeyPem);
internal sealed record AgentUpdateSourceState(
    string? Etag,
    DateTimeOffset CheckedAtUtc,
    string? LatestVersion,
    string? LastError);
internal sealed record CachedAgentUpdate(
    string Version,
    string Runtime,
    string Channel,
    string Sha256,
    long Size,
    string PackagePath,
    AgentReleaseDescriptor Descriptor);
internal sealed record AgentUpdateTicketPayload(
    int SchemaVersion,
    string Scope,
    string PortalId,
    string DeviceId,
    string Runtime,
    string Channel,
    string CurrentVersion,
    string? Version,
    string? Sha256,
    long IssuedAtUnixSeconds,
    long ExpiresAtUnixSeconds,
    string Nonce);

internal static class AgentUpdateVersion
{
    private static readonly Regex Pattern = new("^0\\.1\\.1\\.[0-9]+$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
    public static bool IsValid(string? value) => !string.IsNullOrWhiteSpace(value) && Pattern.IsMatch(value);
    public static int Compare(string left, string right)
    {
        if (!IsValid(left) || !IsValid(right)) throw new InvalidDataException("Agent update version must use 0.1.1.X.");
        return Version.Parse(left).CompareTo(Version.Parse(right));
    }
}

internal sealed class AgentUpdateTicketService
{
    private static readonly ConcurrentDictionary<string, long> ConsumedNonces = new(StringComparer.Ordinal);
    private static readonly object SecretSync = new();
    private readonly byte[] _secret;
    private readonly string _centralBaseUrl;

    public AgentUpdateTicketService(IOptions<SecurityOptions> security, IConfiguration configuration)
    {
        var root = Path.Combine(security.Value.DataRoot, "agent-updates");
        Directory.CreateDirectory(root);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var secretPath = Path.Combine(root, "delegation-ticket.key");
        _secret = LoadOrCreateSecret(secretPath);
        _centralBaseUrl = (configuration["Sirk:AgentUpdates:PublicBaseUrl"] ?? "https://central.sirkportal.com").TrimEnd('/');
        if (!Uri.TryCreate(_centralBaseUrl, UriKind.Absolute, out var baseUri) || baseUri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(baseUri.UserInfo))
            throw new InvalidDataException("Sirk:AgentUpdates:PublicBaseUrl must be an HTTPS URL.");
    }

    public AgentUpdateTicketResponse CreateDiscover(string portalId, AgentUpdateTicketRequest request)
    {
        ValidateRequest(request);
        var expires = DateTimeOffset.UtcNow.AddMinutes(5);
        var payload = CreatePayload("discover", portalId, request.DeviceId, request.Runtime, request.Channel,
            request.CurrentVersion, null, null, expires);
        return new AgentUpdateTicketResponse(_centralBaseUrl, Encode(payload), expires);
    }

    public (string Ticket, DateTimeOffset ExpiresAtUtc) CreateDownload(AgentUpdateTicketPayload discover, CachedAgentUpdate update)
    {
        var expires = DateTimeOffset.UtcNow.AddMinutes(10);
        var payload = CreatePayload("download", discover.PortalId, discover.DeviceId, discover.Runtime, discover.Channel,
            discover.CurrentVersion, update.Version, update.Sha256, expires);
        return (Encode(payload), expires);
    }

    public AgentUpdateTicketPayload? ValidateAndConsume(string? token, string expectedScope)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        var parts = token.Split('.', 2);
        if (parts.Length != 2) return null;
        byte[] payloadBytes;
        byte[] supplied;
        try
        {
            payloadBytes = Base64UrlDecode(parts[0]);
            supplied = Base64UrlDecode(parts[1]);
        }
        catch (FormatException) { return null; }
        if (payloadBytes.Length is <= 0 or > 4096 || supplied.Length != 32) return null;
        var expected = HMACSHA256.HashData(_secret, payloadBytes);
        try
        {
            if (!CryptographicOperations.FixedTimeEquals(expected, supplied)) return null;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(expected);
            CryptographicOperations.ZeroMemory(supplied);
        }

        AgentUpdateTicketPayload? payload;
        try { payload = JsonSerializer.Deserialize<AgentUpdateTicketPayload>(payloadBytes, JsonDefaults.Options); }
        catch (JsonException) { return null; }
        if (payload is null || payload.SchemaVersion != 1 || payload.Scope != expectedScope ||
            string.IsNullOrWhiteSpace(payload.PortalId) || string.IsNullOrWhiteSpace(payload.DeviceId) ||
            payload.Runtime != "win-x64" || payload.Channel is not ("stable" or "preview") ||
            !AgentUpdateVersion.IsValid(payload.CurrentVersion) || payload.Nonce.Length is < 20 or > 80)
            return null;
        if (expectedScope == "download" && (!AgentUpdateVersion.IsValid(payload.Version) || !IsSha256(payload.Sha256))) return null;
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (payload.IssuedAtUnixSeconds > now + 60 || payload.ExpiresAtUnixSeconds < now ||
            payload.ExpiresAtUnixSeconds - payload.IssuedAtUnixSeconds is <= 0 or > 900)
            return null;
        CleanupNonces(now);
        return ConsumedNonces.TryAdd(payload.Nonce, payload.ExpiresAtUnixSeconds) ? payload : null;
    }

    private AgentUpdateTicketPayload CreatePayload(
        string scope,
        string portalId,
        string deviceId,
        string runtime,
        string channel,
        string currentVersion,
        string? version,
        string? sha256,
        DateTimeOffset expires)
    {
        var now = DateTimeOffset.UtcNow;
        return new AgentUpdateTicketPayload(1, scope, portalId, deviceId, runtime, channel, currentVersion,
            version, sha256, now.ToUnixTimeSeconds(), expires.ToUnixTimeSeconds(), Base64Url(RandomNumberGenerator.GetBytes(24)));
    }

    private string Encode(AgentUpdateTicketPayload payload)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(payload, JsonDefaults.Options);
        var signature = HMACSHA256.HashData(_secret, body);
        try { return Base64Url(body) + "." + Base64Url(signature); }
        finally { CryptographicOperations.ZeroMemory(signature); }
    }

    private static void ValidateRequest(AgentUpdateTicketRequest request)
    {
        if (request.DeviceId is null || request.DeviceId.Length is < 3 or > 128 ||
            request.DeviceId.Any(ch => !(char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_' or '.')))
            throw new InvalidDataException("Agent device id is invalid.");
        if (request.Runtime != "win-x64") throw new InvalidDataException("Only win-x64 updates are supported.");
        if (request.Channel is not ("stable" or "preview")) throw new InvalidDataException("Agent update channel is invalid.");
        if (!AgentUpdateVersion.IsValid(request.CurrentVersion)) throw new InvalidDataException("Current Agent version must use 0.1.1.X.");
    }

    private static byte[] LoadOrCreateSecret(string path)
    {
        lock (SecretSync)
        {
            if (!File.Exists(path))
            {
                var value = RandomNumberGenerator.GetBytes(32);
                var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
                File.WriteAllBytes(temporary, value);
                if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                try { File.Move(temporary, path, overwrite: false); }
                catch (IOException) when (File.Exists(path)) { File.Delete(temporary); }
                finally { File.Delete(temporary); }
            }
            var secret = File.ReadAllBytes(path);
            if (secret.Length != 32) throw new InvalidDataException("Agent update delegation secret is invalid.");
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            return secret;
        }
    }

    private static void CleanupNonces(long now)
    {
        if (ConsumedNonces.Count < 256) return;
        foreach (var item in ConsumedNonces)
            if (item.Value < now) ConsumedNonces.TryRemove(item.Key, out _);
    }

    private static bool IsSha256(string? value) => value is { Length: 64 } && value.All(Uri.IsHexDigit);
    private static string Base64Url(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] Base64UrlDecode(string value)
    {
        var normalized = value.Replace('-', '+').Replace('_', '/');
        normalized += new string('=', (4 - normalized.Length % 4) % 4);
        return Convert.FromBase64String(normalized);
    }
}

internal sealed class AgentUpdateCache
{
    private const long MaximumPackageBytes = 80L * 1024 * 1024;
    private const int MaximumDescriptorBytes = 128 * 1024;
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<AgentUpdateCache> _logger;
    private readonly string _repository;
    private readonly string _tokenFile;
    private readonly string _cacheRoot;
    private readonly string _statePath;
    private readonly string _trustedKeysPath;
    private readonly TimeSpan _metadataTtl;
    private readonly int _retention;

    public AgentUpdateCache(
        IHttpClientFactory httpClientFactory,
        IOptions<SecurityOptions> security,
        IConfiguration configuration,
        ILogger<AgentUpdateCache> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _repository = configuration["Sirk:AgentUpdates:GitHubRepository"] ?? "Eris92/SIRK-Agent";
        if (!Regex.IsMatch(_repository, "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", RegexOptions.CultureInvariant))
            throw new InvalidDataException("Agent update GitHub repository is invalid.");
        _tokenFile = configuration["Sirk:AgentUpdates:GitHubTokenFile"] ?? "/run/secrets/sirk-agent-updates-github-token";
        _cacheRoot = configuration["Sirk:AgentUpdates:CacheRoot"] ?? "/var/lib/sirk/updates/agent";
        _statePath = Path.Combine(_cacheRoot, "source-state.json");
        _trustedKeysPath = security.Value.ReleaseSigningPublicKeyFile;
        _metadataTtl = TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue("Sirk:AgentUpdates:MetadataTtlSeconds", 300), 60, 3600));
        _retention = Math.Clamp(configuration.GetValue("Sirk:AgentUpdates:Retention", 3), 2, 10);
        Directory.CreateDirectory(_cacheRoot);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(_cacheRoot, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    public async Task<CachedAgentUpdate?> GetLatestAsync(string runtime, string channel, CancellationToken cancellationToken)
    {
        ValidateRuntimeChannel(runtime, channel);
        var state = ReadState();
        if (state is not null && DateTimeOffset.UtcNow - state.CheckedAtUtc < _metadataTtl &&
            AgentUpdateVersion.IsValid(state.LatestVersion))
            return ReadCached(state.LatestVersion!, runtime, channel);

        await _refreshGate.WaitAsync(cancellationToken);
        try
        {
            state = ReadState();
            if (state is not null && DateTimeOffset.UtcNow - state.CheckedAtUtc < _metadataTtl &&
                AgentUpdateVersion.IsValid(state.LatestVersion))
                return ReadCached(state.LatestVersion!, runtime, channel);
            try
            {
                var refreshed = await RefreshFromGitHubAsync(state, runtime, channel, cancellationToken);
                return refreshed;
            }
            catch (Exception error) when (error is HttpRequestException or IOException or JsonException or InvalidDataException or CryptographicException)
            {
                var fallback = state is not null && AgentUpdateVersion.IsValid(state.LatestVersion)
                    ? ReadCached(state.LatestVersion!, runtime, channel)
                    : null;
                WriteState(new AgentUpdateSourceState(state?.Etag, DateTimeOffset.UtcNow, state?.LatestVersion,
                    error.GetType().Name + ": " + error.Message));
                if (fallback is not null)
                {
                    _logger.LogWarning("Agent update source refresh failed; serving last verified cache: {Reason}.", error.GetType().Name);
                    return fallback;
                }
                throw;
            }
        }
        finally { _refreshGate.Release(); }
    }

    public CachedAgentUpdate GetPackage(string version, string runtime, string channel, string sha256)
    {
        if (!AgentUpdateVersion.IsValid(version) || !IsSha256(sha256)) throw new InvalidDataException("Requested update identity is invalid.");
        var cached = ReadCached(version, runtime, channel) ?? throw new FileNotFoundException("Requested Agent update is not cached.");
        if (!string.Equals(cached.Sha256, sha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Requested update hash does not match the immutable cache entry.");
        return cached;
    }

    public AgentUpdateCacheStatus Status()
    {
        var state = ReadState();
        return new AgentUpdateCacheStatus(
            _cacheRoot,
            state?.CheckedAtUtc,
            state?.Etag,
            state?.LatestVersion,
            state?.LastError,
            EnumerateCachedVersions());
    }

    private async Task<CachedAgentUpdate?> RefreshFromGitHubAsync(
        AgentUpdateSourceState? previous,
        string runtime,
        string channel,
        CancellationToken cancellationToken)
    {
        var client = CreateGitHubClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{_repository}/releases?per_page=30");
        if (!string.IsNullOrWhiteSpace(previous?.Etag)) request.Headers.TryAddWithoutValidation("If-None-Match", previous.Etag);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotModified)
        {
            var next = previous! with { CheckedAtUtc = DateTimeOffset.UtcNow, LastError = null };
            WriteState(next);
            return AgentUpdateVersion.IsValid(next.LatestVersion) ? ReadCached(next.LatestVersion!, runtime, channel) : null;
        }
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var release = SelectRelease(document.RootElement, runtime, channel)
                      ?? throw new InvalidDataException("No compatible signed Agent release was found.");
        var version = release.Version;
        var existing = ReadCached(version, runtime, channel);
        var cached = existing ?? await CacheReleaseAsync(client, release.Release, version, runtime, channel, cancellationToken);
        var etag = response.Headers.ETag?.ToString();
        WriteState(new AgentUpdateSourceState(etag, DateTimeOffset.UtcNow, version, null));
        EnforceRetention(version);
        return cached;
    }

    private static (JsonElement Release, string Version)? SelectRelease(JsonElement releases, string runtime, string channel)
    {
        (JsonElement Release, string Version)? selected = null;
        foreach (var release in releases.EnumerateArray())
        {
            if (release.TryGetProperty("draft", out var draft) && draft.GetBoolean()) continue;
            var prerelease = release.TryGetProperty("prerelease", out var pre) && pre.GetBoolean();
            if (channel == "stable" && prerelease) continue;
            var tag = release.GetProperty("tag_name").GetString()?.Trim() ?? string.Empty;
            var version = tag.StartsWith('v') ? tag[1..] : tag;
            if (!AgentUpdateVersion.IsValid(version)) continue;
            var expectedDescriptor = $"SIRK-Agent-{version}-{runtime}.update.json";
            if (!release.GetProperty("assets").EnumerateArray().Any(asset => asset.GetProperty("name").GetString() == expectedDescriptor)) continue;
            if (selected is null || AgentUpdateVersion.Compare(version, selected.Value.Version) > 0)
                selected = (release.Clone(), version);
        }
        return selected;
    }

    private async Task<CachedAgentUpdate> CacheReleaseAsync(
        HttpClient client,
        JsonElement release,
        string version,
        string runtime,
        string channel,
        CancellationToken cancellationToken)
    {
        var assets = release.GetProperty("assets").EnumerateArray().Select(value => value.Clone()).ToArray();
        var descriptorName = $"SIRK-Agent-{version}-{runtime}.update.json";
        var descriptorAsset = assets.SingleOrDefault(asset => asset.GetProperty("name").GetString() == descriptorName);
        if (descriptorAsset.ValueKind == JsonValueKind.Undefined) throw new InvalidDataException("Signed release descriptor asset is missing.");
        var descriptorBytes = await DownloadSmallAssetAsync(client, descriptorAsset.GetProperty("url").GetString()!, cancellationToken);
        var descriptor = JsonSerializer.Deserialize<AgentReleaseDescriptor>(descriptorBytes, JsonDefaults.Options)
                         ?? throw new InvalidDataException("Signed release descriptor is invalid.");
        ValidateDescriptor(descriptor, version, runtime, channel);
        VerifySignature(descriptor, descriptor.Signature);
        if (descriptor.AssetName != Path.GetFileName(descriptor.AssetName) || !descriptor.AssetName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Update descriptor asset name is invalid.");
        var packageAsset = assets.SingleOrDefault(asset => asset.GetProperty("name").GetString() == descriptor.AssetName);
        if (packageAsset.ValueKind == JsonValueKind.Undefined) throw new InvalidDataException("Update package asset is missing.");
        if (descriptor.Size <= 0 || descriptor.Size > MaximumPackageBytes || packageAsset.GetProperty("size").GetInt64() != descriptor.Size)
            throw new InvalidDataException("Update package size is invalid.");

        var staging = Path.Combine(_cacheRoot, ".staging-" + Guid.NewGuid().ToString("N"));
        var final = Path.Combine(_cacheRoot, version);
        Directory.CreateDirectory(staging);
        try
        {
            var descriptorPath = Path.Combine(staging, "release.json");
            await File.WriteAllBytesAsync(descriptorPath, descriptorBytes, cancellationToken);
            var packagePath = Path.Combine(staging, "package.zip");
            await DownloadPackageAsync(client, packageAsset.GetProperty("url").GetString()!, packagePath, descriptor.Size, cancellationToken);
            var actualHash = await ComputeSha256Async(packagePath, cancellationToken);
            if (!string.Equals(actualHash, descriptor.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Downloaded Agent update SHA256 does not match the signed descriptor.");
            await VerifyInnerPackageAsync(packagePath, descriptor, cancellationToken);
            if (Directory.Exists(final))
            {
                var existing = ReadCached(version, runtime, channel)
                               ?? throw new InvalidDataException("Immutable cache directory already exists but is invalid.");
                if (!string.Equals(existing.Sha256, descriptor.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Immutable Agent update version already exists with a different hash.");
                return existing;
            }
            Directory.Move(staging, final);
            staging = string.Empty;
            _logger.LogInformation("Published verified Agent update {Version} to local immutable cache.", version);
            return ReadCached(version, runtime, channel)
                   ?? throw new InvalidDataException("Published Agent update cache entry could not be re-read.");
        }
        finally
        {
            if (!string.IsNullOrEmpty(staging) && Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
        }
    }

    private HttpClient CreateGitHubClient()
    {
        var token = File.ReadAllText(_tokenFile, Encoding.UTF8).Trim();
        if (token.Length is < 20 or > 512 || token.Any(char.IsWhiteSpace)) throw new InvalidDataException("Central GitHub update token is missing or invalid.");
        var client = _httpClientFactory.CreateClient("SirkAgentUpdates");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        client.DefaultRequestHeaders.Accept.Clear();
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        client.DefaultRequestHeaders.UserAgent.ParseAdd("SIRK-Central-AgentUpdateCache/1");
        client.DefaultRequestHeaders.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");
        return client;
    }

    private static async Task<byte[]> DownloadSmallAssetAsync(HttpClient client, string url, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Accept.Clear();
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > MaximumDescriptorBytes) throw new InvalidDataException("Release descriptor is too large.");
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var output = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var read = await input.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            if (output.Length + read > MaximumDescriptorBytes) throw new InvalidDataException("Release descriptor is too large.");
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
        return output.ToArray();
    }

    private static async Task DownloadPackageAsync(HttpClient client, string url, string destination, long expectedSize, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Accept.Clear();
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength is long length && length != expectedSize) throw new InvalidDataException("GitHub package size does not match signed descriptor.");
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.Asynchronous | FileOptions.WriteThrough);
        var buffer = new byte[128 * 1024];
        long total = 0;
        while (true)
        {
            var read = await input.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            total += read;
            if (total > MaximumPackageBytes || total > expectedSize) throw new InvalidDataException("Downloaded Agent package exceeded signed size.");
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
        await output.FlushAsync(cancellationToken);
        output.Flush(flushToDisk: true);
        if (total != expectedSize) throw new InvalidDataException("Downloaded Agent package is truncated.");
    }

    private async Task VerifyInnerPackageAsync(string packagePath, AgentReleaseDescriptor descriptor, CancellationToken cancellationToken)
    {
        using var archive = ZipFile.OpenRead(packagePath);
        if (archive.Entries.Count is <= 0 or > 4096) throw new InvalidDataException("Agent update ZIP entry count is invalid.");
        var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in archive.Entries)
        {
            var name = entry.FullName.Replace('\\', '/');
            if (string.IsNullOrWhiteSpace(name) || name.StartsWith('/') || name.Contains("../", StringComparison.Ordinal) || Path.IsPathRooted(name))
                throw new InvalidDataException("Agent update ZIP contains a path traversal entry.");
            if (!entries.TryAdd(name, entry)) throw new InvalidDataException("Agent update ZIP contains duplicate entries.");
        }
        if (!entries.TryGetValue("update-manifest.json", out var manifestEntry) || manifestEntry.Length is <= 0 or > MaximumDescriptorBytes)
            throw new InvalidDataException("Signed package manifest is missing.");
        AgentPackageManifest manifest;
        await using (var manifestStream = manifestEntry.Open())
        {
            manifest = await JsonSerializer.DeserializeAsync<AgentPackageManifest>(manifestStream, JsonDefaults.Options, cancellationToken)
                       ?? throw new InvalidDataException("Signed package manifest is invalid.");
        }
        if (manifest.SchemaVersion != 1 || manifest.Product != "SIRK Agent" || manifest.Version != descriptor.Version ||
            manifest.Runtime != descriptor.Runtime || manifest.Files is null || manifest.Files.Count is <= 0 or > 4095)
            throw new InvalidDataException("Signed package manifest metadata does not match the release descriptor.");
        VerifySignature(manifest, manifest.Signature);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in manifest.Files)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var path = (file.Path ?? string.Empty).Replace('\\', '/');
            if (path.Length is <= 0 or > 512 || path.StartsWith('/') || path.Contains("../", StringComparison.Ordinal) || Path.IsPathRooted(path) ||
                !seen.Add(path) || !IsSha256(file.Sha256) || !entries.TryGetValue(path, out var entry) || entry.Length > MaximumPackageBytes)
                throw new InvalidDataException("Signed package manifest contains an invalid file entry.");
            await using var stream = entry.Open();
            var actual = Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
            if (!string.Equals(actual, file.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Signed package manifest file hash mismatch: " + path);
        }
        foreach (var required in new[] { "SirkAgent.Service.exe", "SirkAgent.Service.dll", "SirkAgent.Policy.dll", "sirkctl.exe" })
            if (!seen.Contains(required)) throw new InvalidDataException("Agent update package is missing required runtime file: " + required);
    }

    private void ValidateDescriptor(AgentReleaseDescriptor descriptor, string version, string runtime, string channel)
    {
        if (descriptor.SchemaVersion != 1 || descriptor.Product != "SIRK Agent" || descriptor.Version != version ||
            descriptor.Runtime != runtime || descriptor.Channel != channel || descriptor.PublishedAtUtc > DateTimeOffset.UtcNow.AddMinutes(10) ||
            !IsSha256(descriptor.Sha256) || descriptor.Signature is null)
            throw new InvalidDataException("Signed Agent release descriptor metadata is invalid.");
    }

    private void VerifySignature<T>(T value, UpdateSignature signature)
    {
        if (signature.Algorithm != "ES256" || string.IsNullOrWhiteSpace(signature.KeyId) || string.IsNullOrWhiteSpace(signature.Value))
            throw new CryptographicException("Agent update signature metadata is invalid.");
        if (string.IsNullOrWhiteSpace(_trustedKeysPath) || !File.Exists(_trustedKeysPath))
            throw new CryptographicException("Trusted release signing keyring is not configured.");
        var keyring = JsonSerializer.Deserialize<TrustedKeyDocument>(File.ReadAllBytes(_trustedKeysPath), JsonDefaults.Options)
                      ?? throw new CryptographicException("Trusted release signing keyring is invalid.");
        var entry = keyring.Keys?.SingleOrDefault(item => item.KeyId == signature.KeyId)
                    ?? throw new CryptographicException("Agent update signing key is not trusted.");
        using var key = ECDsa.Create();
        key.ImportFromPem(entry.PublicKeyPem);
        if (key.KeySize != 256) throw new CryptographicException("Trusted Agent update key must be P-256.");
        var supplied = DecodeBase64Url(signature.Value);
        try
        {
            if (supplied.Length != 64 || !key.VerifyData(
                    CanonicalUpdateJson.SerializeWithoutTopLevelSignature(value), supplied, HashAlgorithmName.SHA256,
                    DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
                throw new CryptographicException("Agent update ES256 signature verification failed.");
        }
        finally { CryptographicOperations.ZeroMemory(supplied); }
    }

    private CachedAgentUpdate? ReadCached(string version, string runtime, string channel)
    {
        if (!AgentUpdateVersion.IsValid(version)) return null;
        var directory = Path.Combine(_cacheRoot, version);
        var descriptorPath = Path.Combine(directory, "release.json");
        var packagePath = Path.Combine(directory, "package.zip");
        if (!File.Exists(descriptorPath) || !File.Exists(packagePath)) return null;
        try
        {
            var descriptor = JsonSerializer.Deserialize<AgentReleaseDescriptor>(File.ReadAllBytes(descriptorPath), JsonDefaults.Options);
            if (descriptor is null || descriptor.Version != version || descriptor.Runtime != runtime || descriptor.Channel != channel || !IsSha256(descriptor.Sha256)) return null;
            var info = new FileInfo(packagePath);
            if (info.Length != descriptor.Size) return null;
            return new CachedAgentUpdate(version, runtime, channel, descriptor.Sha256, descriptor.Size, packagePath, descriptor);
        }
        catch (JsonException) { return null; }
    }

    private AgentUpdateSourceState? ReadState()
    {
        try
        {
            return File.Exists(_statePath)
                ? JsonSerializer.Deserialize<AgentUpdateSourceState>(File.ReadAllBytes(_statePath), JsonDefaults.Options)
                : null;
        }
        catch (JsonException) { return null; }
    }

    private void WriteState(AgentUpdateSourceState state) => AtomicJson(_statePath, state);

    private IReadOnlyList<string> EnumerateCachedVersions() => Directory.EnumerateDirectories(_cacheRoot, "0.1.1.*", SearchOption.TopDirectoryOnly)
        .Select(Path.GetFileName)
        .Where(AgentUpdateVersion.IsValid)
        .Cast<string>()
        .OrderByDescending(value => Version.Parse(value))
        .ToArray();

    private void EnforceRetention(string latest)
    {
        var versions = EnumerateCachedVersions().ToList();
        foreach (var version in versions.Skip(_retention))
        {
            if (version == latest) continue;
            try { Directory.Delete(Path.Combine(_cacheRoot, version), recursive: true); }
            catch (IOException error) { _logger.LogWarning("Failed to prune cached Agent update {Version}: {Reason}.", version, error.GetType().Name); }
        }
    }

    private static void ValidateRuntimeChannel(string runtime, string channel)
    {
        if (runtime != "win-x64" || channel is not ("stable" or "preview"))
            throw new InvalidDataException("Unsupported Agent update runtime or channel.");
    }

    private static bool IsSha256(string? value) => value is { Length: 64 } && value.All(Uri.IsHexDigit);
    private static byte[] DecodeBase64Url(string value)
    {
        var normalized = value.Replace('-', '+').Replace('_', '/');
        normalized += new string('=', (4 - normalized.Length % 4) % 4);
        return Convert.FromBase64String(normalized);
    }

    private static async Task<string> ComputeSha256Async(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
    }

    private static void AtomicJson<T>(string path, T value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                JsonSerializer.Serialize(stream, value, JsonDefaults.Options);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally { File.Delete(temporary); }
    }
}

internal static class AgentUpdateDistributionEndpoints
{
    public static void Map(IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/portal/v1/update/agent/ticket", CreateTicketAsync);
        endpoints.MapGet("/api/v1/agent-updates/latest", LatestAsync);
        endpoints.MapGet("/api/v1/agent-updates/{version}/package", DownloadAsync);
        endpoints.MapGet("/api/v1/updates/agent/status", (AgentUpdateCache cache) => Results.Ok(cache.Status()))
            .RequireAuthorization(SirkPolicies.PortalManagement);
    }

    private static async Task<IResult> CreateTicketAsync(
        HttpContext context,
        PortalRequestAuthenticator authenticator,
        AgentUpdateTicketService tickets,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        var authentication = authenticator.AuthenticateCredentials(context.Request);
        if (!authentication.Succeeded || authentication.Portal is null)
            return Results.NotFound();
        AgentUpdateTicketRequest? request;
        try { request = await context.Request.ReadFromJsonAsync<AgentUpdateTicketRequest>(JsonDefaults.Options, cancellationToken); }
        catch (JsonException) { return Results.BadRequest(new { ok = false, code = "AGENT_UPDATE_TICKET_INVALID" }); }
        if (request is null) return Results.BadRequest(new { ok = false, code = "AGENT_UPDATE_TICKET_INVALID" });
        try { return Results.Ok(tickets.CreateDiscover(authentication.Portal.Id, request)); }
        catch (InvalidDataException error) { return Results.BadRequest(new { ok = false, code = "AGENT_UPDATE_TICKET_INVALID", error = error.Message }); }
    }

    private static async Task<IResult> LatestAsync(
        HttpContext context,
        AgentUpdateTicketService tickets,
        AgentUpdateCache cache,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        var ticket = Bearer(context.Request);
        var payload = tickets.ValidateAndConsume(ticket, "discover");
        if (payload is null) return Results.Unauthorized();
        if (context.Request.Query["runtime"].ToString() != payload.Runtime || context.Request.Query["channel"].ToString() != payload.Channel)
            return Results.BadRequest(new { ok = false, code = "AGENT_UPDATE_SCOPE_MISMATCH" });
        try
        {
            var latest = await cache.GetLatestAsync(payload.Runtime, payload.Channel, cancellationToken);
            if (latest is null || AgentUpdateVersion.Compare(latest.Version, payload.CurrentVersion) <= 0)
                return Results.NoContent();
            var download = tickets.CreateDownload(payload, latest);
            return Results.Ok(new AgentUpdateLatestResponse(latest.Version, latest.Runtime, latest.Channel, latest.Size,
                latest.Sha256, latest.Descriptor, download.Ticket, download.ExpiresAtUtc));
        }
        catch (Exception error) when (error is HttpRequestException or IOException or InvalidDataException or CryptographicException)
        {
            return Results.Json(new { ok = false, code = "AGENT_UPDATE_UNAVAILABLE", error = error.Message }, statusCode: 503);
        }
    }

    private static IResult DownloadAsync(
        string version,
        HttpContext context,
        AgentUpdateTicketService tickets,
        AgentUpdateCache cache)
    {
        context.Response.Headers.CacheControl = "private, no-store";
        var payload = tickets.ValidateAndConsume(Bearer(context.Request), "download");
        if (payload is null) return Results.Unauthorized();
        if (payload.Version != version || !AgentUpdateVersion.IsValid(version) || payload.Sha256 is null)
            return Results.BadRequest(new { ok = false, code = "AGENT_UPDATE_SCOPE_MISMATCH" });
        try
        {
            var update = cache.GetPackage(version, payload.Runtime, payload.Channel, payload.Sha256);
            context.Response.Headers.ETag = '"' + update.Sha256 + '"';
            return Results.File(update.PackagePath, "application/zip", enableRangeProcessing: true);
        }
        catch (FileNotFoundException) { return Results.NotFound(); }
        catch (InvalidDataException error) { return Results.BadRequest(new { ok = false, code = "AGENT_UPDATE_INVALID", error = error.Message }); }
    }

    private static string? Bearer(HttpRequest request)
    {
        var value = request.Headers.Authorization.ToString();
        return value.StartsWith("Bearer ", StringComparison.Ordinal) ? value[7..].Trim() : null;
    }
}

internal static class JsonDefaults
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
}

internal static class CanonicalUpdateJson
{
    public static byte[] SerializeWithoutTopLevelSignature<T>(T value)
    {
        var root = JsonSerializer.SerializeToElement(value, JsonDefaults.Options);
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            WriteObject(root, writer, topLevel: true);
            writer.Flush();
        }
        return output.ToArray();
    }

    private static void WriteObject(JsonElement root, Utf8JsonWriter writer, bool topLevel)
    {
        writer.WriteStartObject();
        foreach (var property in root.EnumerateObject()
                     .Where(property => !(topLevel && property.NameEquals("signature")))
                     .OrderBy(property => property.Name, StringComparer.Ordinal))
        {
            writer.WritePropertyName(property.Name);
            WriteElement(property.Value, writer);
        }
        writer.WriteEndObject();
    }

    private static void WriteElement(JsonElement element, Utf8JsonWriter writer)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                WriteObject(element, writer, topLevel: false);
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray()) WriteElement(item, writer);
                writer.WriteEndArray();
                break;
            default:
                element.WriteTo(writer);
                break;
        }
    }
}
