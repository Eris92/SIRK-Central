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

internal sealed record PlatformReleaseDescriptor(
    [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
    [property: JsonPropertyName("applicationId")] string ApplicationId,
    [property: JsonPropertyName("product")] string Product,
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("runtime")] string Runtime,
    [property: JsonPropertyName("channel")] string Channel,
    [property: JsonPropertyName("assetName")] string AssetName,
    [property: JsonPropertyName("size")] long Size,
    [property: JsonPropertyName("sha256")] string Sha256,
    [property: JsonPropertyName("commit")] string Commit,
    [property: JsonPropertyName("publishedAtUtc")] DateTimeOffset PublishedAtUtc,
    [property: JsonPropertyName("signature")] UpdateSignature Signature);

internal sealed record PlatformPackageManifest(
    [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
    [property: JsonPropertyName("applicationId")] string ApplicationId,
    [property: JsonPropertyName("product")] string Product,
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("runtime")] string Runtime,
    [property: JsonPropertyName("files")] IReadOnlyList<PlatformPackageManifestFile> Files,
    [property: JsonPropertyName("signature")] UpdateSignature Signature);

internal sealed record PlatformPackageManifestFile(
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("size")] long Size,
    [property: JsonPropertyName("sha256")] string Sha256);

internal sealed record PlatformUpdateSourceState(
    string? Etag,
    DateTimeOffset CheckedAtUtc,
    string? LatestVersion,
    string? LastError);

internal sealed record CachedPlatformUpdate(
    string ApplicationId,
    string Version,
    string Runtime,
    string Channel,
    string Sha256,
    long Size,
    string PackagePath,
    PlatformReleaseDescriptor Descriptor);

internal sealed record PlatformUpdateCacheStatus(
    string ApplicationId,
    string Runtime,
    string Channel,
    string CacheRoot,
    DateTimeOffset? LastSourceCheckUtc,
    string? SourceEtag,
    string? LatestVersion,
    string? LastError,
    IReadOnlyList<string> CachedVersions);

internal sealed record PlatformUpdateDefinition(
    string ApplicationId,
    string Product,
    string Repository,
    string AssetPrefix,
    IReadOnlySet<string> Runtimes,
    long MaximumPackageBytes);

internal static class PlatformUpdateDefinitions
{
    private static readonly IReadOnlyDictionary<string, PlatformUpdateDefinition> Values =
        new Dictionary<string, PlatformUpdateDefinition>(StringComparer.Ordinal)
        {
            ["sirk-portal"] = new(
                "sirk-portal",
                "SIRK Portal",
                "Eris92/SIRK-Portal",
                "SIRK-Portal",
                new HashSet<string>(StringComparer.Ordinal) { "win-x64", "linux-x64" },
                256L * 1024 * 1024),
            ["sirk-central"] = new(
                "sirk-central",
                "SIRK Central",
                "Eris92/SIRK-Central",
                "SIRK-Central",
                new HashSet<string>(StringComparer.Ordinal) { "linux-x64" },
                512L * 1024 * 1024),
            ["sirk-updater"] = new(
                "sirk-updater",
                "SIRK Updater",
                "Eris92/SIRK-Updater",
                "SIRK-Updater",
                new HashSet<string>(StringComparer.Ordinal) { "win-x64", "linux-x64" },
                128L * 1024 * 1024)
        };

    public static PlatformUpdateDefinition Get(string applicationId) =>
        Values.TryGetValue(applicationId, out var value)
            ? value
            : throw new KeyNotFoundException("Unknown SIRK update product.");

    public static IReadOnlyCollection<PlatformUpdateDefinition> All => Values.Values.ToArray();
}

internal static class PlatformUpdateVersion
{
    private static readonly Regex Pattern = new(
        "^0\\.1\\.1\\.[0-9]+$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static bool IsValid(string? value) =>
        !string.IsNullOrWhiteSpace(value) && Pattern.IsMatch(value);

    public static int Compare(string left, string right)
    {
        if (!IsValid(left) || !IsValid(right))
            throw new InvalidDataException("SIRK update version must use 0.1.1.X.");
        return Version.Parse(left).CompareTo(Version.Parse(right));
    }
}

internal sealed class PlatformUpdateCache
{
    private const int MaximumDescriptorBytes = 128 * 1024;
    private const int MaximumArchiveEntries = 8192;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _refreshGates = new(StringComparer.Ordinal);
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<PlatformUpdateCache> _logger;
    private readonly IConfiguration _configuration;
    private readonly string _tokenFile;
    private readonly string _cacheRoot;
    private readonly string _trustedKeysPath;
    private readonly TimeSpan _metadataTtl;
    private readonly int _retention;

    public PlatformUpdateCache(
        IHttpClientFactory httpClientFactory,
        IOptions<SecurityOptions> security,
        IConfiguration configuration,
        ILogger<PlatformUpdateCache> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _configuration = configuration;
        _tokenFile = configuration["Sirk:Updates:GitHubTokenFile"] ??
                     "/run/secrets/sirk-updates-github-token";
        _cacheRoot = configuration["Sirk:Updates:CacheRoot"] ?? "/var/lib/sirk/updates";
        _trustedKeysPath = security.Value.ReleaseSigningPublicKeyFile;
        _metadataTtl = TimeSpan.FromSeconds(Math.Clamp(
            configuration.GetValue("Sirk:Updates:MetadataTtlSeconds", 300), 60, 3600));
        _retention = Math.Clamp(configuration.GetValue("Sirk:Updates:Retention", 3), 2, 10);
        Directory.CreateDirectory(_cacheRoot);
        SecureDirectory(_cacheRoot);
    }

    public async Task<CachedPlatformUpdate?> GetLatestAsync(
        string applicationId,
        string runtime,
        string channel,
        CancellationToken cancellationToken)
    {
        var definition = ValidateScope(applicationId, runtime, channel);
        var scopeRoot = ScopeRoot(definition, runtime, channel);
        Directory.CreateDirectory(scopeRoot);
        SecureDirectory(scopeRoot);
        var statePath = Path.Combine(scopeRoot, "source-state.json");
        var state = ReadState(statePath);
        if (state is not null && DateTimeOffset.UtcNow - state.CheckedAtUtc < _metadataTtl &&
            PlatformUpdateVersion.IsValid(state.LatestVersion))
            return ReadCached(definition, state.LatestVersion!, runtime, channel);

        var gate = _refreshGates.GetOrAdd(
            definition.ApplicationId + ":" + runtime + ":" + channel,
            static _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            state = ReadState(statePath);
            if (state is not null && DateTimeOffset.UtcNow - state.CheckedAtUtc < _metadataTtl &&
                PlatformUpdateVersion.IsValid(state.LatestVersion))
                return ReadCached(definition, state.LatestVersion!, runtime, channel);

            try
            {
                return await RefreshFromGitHubAsync(
                    definition,
                    state,
                    statePath,
                    runtime,
                    channel,
                    cancellationToken);
            }
            catch (Exception error) when (
                error is HttpRequestException or IOException or JsonException or InvalidDataException or CryptographicException)
            {
                var fallback = state is not null && PlatformUpdateVersion.IsValid(state.LatestVersion)
                    ? ReadCached(definition, state.LatestVersion!, runtime, channel)
                    : null;
                WriteState(statePath, new PlatformUpdateSourceState(
                    state?.Etag,
                    DateTimeOffset.UtcNow,
                    state?.LatestVersion,
                    error.GetType().Name + ": " + error.Message));
                if (fallback is not null)
                {
                    _logger.LogWarning(
                        "{ApplicationId} update source refresh failed; serving last verified cache: {Reason}.",
                        applicationId,
                        error.GetType().Name);
                    return fallback;
                }
                throw;
            }
        }
        finally
        {
            gate.Release();
        }
    }

    public CachedPlatformUpdate GetPackage(
        string applicationId,
        string version,
        string runtime,
        string channel,
        string? expectedSha256 = null)
    {
        var definition = ValidateScope(applicationId, runtime, channel);
        if (!PlatformUpdateVersion.IsValid(version))
            throw new InvalidDataException("Requested update version is invalid.");
        var cached = ReadCached(definition, version, runtime, channel)
                     ?? throw new FileNotFoundException("Requested SIRK update is not cached.");
        if (!string.IsNullOrWhiteSpace(expectedSha256) &&
            !string.Equals(cached.Sha256, expectedSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Requested update hash does not match the immutable cache entry.");
        return cached;
    }

    public PlatformUpdateCacheStatus Status(string applicationId, string runtime, string channel)
    {
        var definition = ValidateScope(applicationId, runtime, channel);
        var scopeRoot = ScopeRoot(definition, runtime, channel);
        var state = ReadState(Path.Combine(scopeRoot, "source-state.json"));
        return new PlatformUpdateCacheStatus(
            applicationId,
            runtime,
            channel,
            scopeRoot,
            state?.CheckedAtUtc,
            state?.Etag,
            state?.LatestVersion,
            state?.LastError,
            EnumerateCachedVersions(scopeRoot));
    }

    public byte[] ReadTrustedKeys()
    {
        if (string.IsNullOrWhiteSpace(_trustedKeysPath) || !File.Exists(_trustedKeysPath))
            throw new CryptographicException("Trusted release signing keyring is not configured.");
        var bytes = File.ReadAllBytes(_trustedKeysPath);
        if (bytes.Length is <= 0 or > 128 * 1024)
            throw new InvalidDataException("Trusted release signing keyring size is invalid.");
        var keyring = JsonSerializer.Deserialize<TrustedKeyDocument>(bytes, JsonDefaults.Options)
                      ?? throw new InvalidDataException("Trusted release signing keyring is invalid.");
        if (keyring.Keys is null || keyring.Keys.Count is <= 0 or > 32)
            throw new InvalidDataException("Trusted release signing keyring contains no usable keys.");
        return bytes;
    }

    private async Task<CachedPlatformUpdate?> RefreshFromGitHubAsync(
        PlatformUpdateDefinition definition,
        PlatformUpdateSourceState? previous,
        string statePath,
        string runtime,
        string channel,
        CancellationToken cancellationToken)
    {
        using var client = CreateGitHubClient();
        var repository = _configuration[$"Sirk:Updates:Products:{definition.ApplicationId}:GitHubRepository"]
                         ?? definition.Repository;
        if (!Regex.IsMatch(repository, "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", RegexOptions.CultureInvariant))
            throw new InvalidDataException("SIRK update GitHub repository is invalid.");

        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"https://api.github.com/repos/{repository}/releases?per_page=30");
        if (!string.IsNullOrWhiteSpace(previous?.Etag))
            request.Headers.TryAddWithoutValidation("If-None-Match", previous.Etag);
        using var response = await client.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotModified)
        {
            var next = previous! with { CheckedAtUtc = DateTimeOffset.UtcNow, LastError = null };
            WriteState(statePath, next);
            return PlatformUpdateVersion.IsValid(next.LatestVersion)
                ? ReadCached(definition, next.LatestVersion!, runtime, channel)
                : null;
        }
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var release = SelectRelease(document.RootElement, definition, runtime, channel)
                      ?? throw new InvalidDataException(
                          $"No compatible signed {definition.Product} release was found.");
        var existing = ReadCached(definition, release.Value.Version, runtime, channel);
        var cached = existing ?? await CacheReleaseAsync(
            client,
            definition,
            release.Value.Release,
            release.Value.Version,
            runtime,
            channel,
            cancellationToken);
        WriteState(statePath, new PlatformUpdateSourceState(
            response.Headers.ETag?.ToString(),
            DateTimeOffset.UtcNow,
            cached.Version,
            null));
        EnforceRetention(ScopeRoot(definition, runtime, channel), cached.Version);
        return cached;
    }

    private static (JsonElement Release, string Version)? SelectRelease(
        JsonElement releases,
        PlatformUpdateDefinition definition,
        string runtime,
        string channel)
    {
        if (releases.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("GitHub releases response is invalid.");
        (JsonElement Release, string Version)? selected = null;
        foreach (var release in releases.EnumerateArray())
        {
            if (release.TryGetProperty("draft", out var draft) && draft.GetBoolean()) continue;
            var prerelease = release.TryGetProperty("prerelease", out var pre) && pre.GetBoolean();
            if (channel == "stable" && prerelease) continue;
            var tag = release.GetProperty("tag_name").GetString()?.Trim() ?? string.Empty;
            var version = tag.StartsWith('v') ? tag[1..] : tag;
            if (!PlatformUpdateVersion.IsValid(version)) continue;
            var descriptorName = $"{definition.AssetPrefix}-{version}-{runtime}.update.json";
            if (!release.GetProperty("assets").EnumerateArray().Any(
                    asset => asset.GetProperty("name").GetString() == descriptorName))
                continue;
            if (selected is null || PlatformUpdateVersion.Compare(version, selected.Value.Version) > 0)
                selected = (release.Clone(), version);
        }
        return selected;
    }

    private async Task<CachedPlatformUpdate> CacheReleaseAsync(
        HttpClient client,
        PlatformUpdateDefinition definition,
        JsonElement release,
        string version,
        string runtime,
        string channel,
        CancellationToken cancellationToken)
    {
        var assets = release.GetProperty("assets").EnumerateArray().Select(value => value.Clone()).ToArray();
        var descriptorName = $"{definition.AssetPrefix}-{version}-{runtime}.update.json";
        var descriptorAsset = assets.SingleOrDefault(
            asset => asset.GetProperty("name").GetString() == descriptorName);
        if (descriptorAsset.ValueKind == JsonValueKind.Undefined)
            throw new InvalidDataException("Signed release descriptor asset is missing.");
        var descriptorBytes = await DownloadSmallAssetAsync(
            client,
            descriptorAsset.GetProperty("url").GetString()!,
            cancellationToken);
        var descriptor = JsonSerializer.Deserialize<PlatformReleaseDescriptor>(
                             descriptorBytes,
                             JsonDefaults.Options)
                         ?? throw new InvalidDataException("Signed release descriptor is invalid.");
        ValidateDescriptor(definition, descriptor, version, runtime, channel);
        VerifySignature(descriptor, descriptor.Signature);

        var packageAsset = assets.SingleOrDefault(
            asset => asset.GetProperty("name").GetString() == descriptor.AssetName);
        if (packageAsset.ValueKind == JsonValueKind.Undefined)
            throw new InvalidDataException("Update package asset is missing.");
        if (descriptor.Size <= 0 || descriptor.Size > definition.MaximumPackageBytes ||
            packageAsset.GetProperty("size").GetInt64() != descriptor.Size)
            throw new InvalidDataException("Update package size is invalid.");

        var scopeRoot = ScopeRoot(definition, runtime, channel);
        Directory.CreateDirectory(scopeRoot);
        SecureDirectory(scopeRoot);
        var staging = Path.Combine(scopeRoot, ".staging-" + Guid.NewGuid().ToString("N"));
        var final = Path.Combine(scopeRoot, version);
        Directory.CreateDirectory(staging);
        SecureDirectory(staging);
        try
        {
            await File.WriteAllBytesAsync(
                Path.Combine(staging, "release.json"),
                descriptorBytes,
                cancellationToken);
            var packagePath = Path.Combine(staging, "package.zip");
            await DownloadPackageAsync(
                client,
                packageAsset.GetProperty("url").GetString()!,
                packagePath,
                descriptor.Size,
                definition.MaximumPackageBytes,
                cancellationToken);
            var actual = await ComputeSha256Async(packagePath, cancellationToken);
            if (!string.Equals(actual, descriptor.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Downloaded update SHA256 does not match the signed descriptor.");
            await VerifyPackageManifestAsync(
                definition,
                packagePath,
                descriptor,
                cancellationToken);
            if (Directory.Exists(final))
            {
                var existing = ReadCached(definition, version, runtime, channel)
                               ?? throw new InvalidDataException(
                                   "Immutable cache directory already exists but is invalid.");
                if (!string.Equals(existing.Sha256, descriptor.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException(
                        "Immutable SIRK update version already exists with a different hash.");
                return existing;
            }
            Directory.Move(staging, final);
            staging = string.Empty;
            _logger.LogInformation(
                "Published verified {ApplicationId} update {Version} ({Runtime}) to immutable cache.",
                definition.ApplicationId,
                version,
                runtime);
            return ReadCached(definition, version, runtime, channel)
                   ?? throw new InvalidDataException("Published update cache entry could not be re-read.");
        }
        finally
        {
            if (!string.IsNullOrEmpty(staging) && Directory.Exists(staging))
                Directory.Delete(staging, recursive: true);
        }
    }

    private async Task VerifyPackageManifestAsync(
        PlatformUpdateDefinition definition,
        string packagePath,
        PlatformReleaseDescriptor descriptor,
        CancellationToken cancellationToken)
    {
        using var archive = ZipFile.OpenRead(packagePath);
        if (archive.Entries.Count is <= 0 or > MaximumArchiveEntries)
            throw new InvalidDataException("Update ZIP entry count is invalid.");
        var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in archive.Entries)
        {
            var name = NormalizeArchivePath(entry.FullName);
            if (!entries.TryAdd(name, entry))
                throw new InvalidDataException("Update ZIP contains duplicate entries.");
        }
        if (!entries.TryGetValue("update-manifest.json", out var manifestEntry) ||
            manifestEntry.Length is <= 0 or > MaximumDescriptorBytes)
            throw new InvalidDataException("Signed package manifest is missing.");
        PlatformPackageManifest manifest;
        await using (var input = manifestEntry.Open())
        {
            manifest = await JsonSerializer.DeserializeAsync<PlatformPackageManifest>(
                           input,
                           JsonDefaults.Options,
                           cancellationToken)
                       ?? throw new InvalidDataException("Signed package manifest is invalid.");
        }
        if (manifest.SchemaVersion != 1 ||
            manifest.ApplicationId != definition.ApplicationId ||
            manifest.Product != definition.Product ||
            manifest.Version != descriptor.Version ||
            manifest.Runtime != descriptor.Runtime ||
            manifest.Files is null || manifest.Files.Count is <= 0 or > MaximumArchiveEntries - 1)
            throw new InvalidDataException("Signed package manifest metadata does not match the release descriptor.");
        VerifySignature(manifest, manifest.Signature);

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in manifest.Files)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var path = NormalizeArchivePath(file.Path);
            if (!seen.Add(path) || !IsSha256(file.Sha256) || file.Size < 0 ||
                !entries.TryGetValue(path, out var entry) || entry.Length != file.Size ||
                entry.Length > definition.MaximumPackageBytes)
                throw new InvalidDataException("Signed package manifest contains an invalid file entry.");
            await using var input = entry.Open();
            var actual = Convert.ToHexString(await SHA256.HashDataAsync(input, cancellationToken))
                .ToLowerInvariant();
            if (!string.Equals(actual, file.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Signed package manifest file hash mismatch: " + path);
        }
    }

    private void VerifySignature<T>(T value, UpdateSignature signature)
    {
        if (signature.Algorithm != "ES256" || string.IsNullOrWhiteSpace(signature.KeyId) ||
            string.IsNullOrWhiteSpace(signature.Value))
            throw new CryptographicException("SIRK update signature metadata is invalid.");
        var bytes = ReadTrustedKeys();
        var keyring = JsonSerializer.Deserialize<TrustedKeyDocument>(bytes, JsonDefaults.Options)
                      ?? throw new CryptographicException("Trusted release signing keyring is invalid.");
        var entry = keyring.Keys?.SingleOrDefault(item => item.KeyId == signature.KeyId)
                    ?? throw new CryptographicException("SIRK update signing key is not trusted.");
        using var key = ECDsa.Create();
        key.ImportFromPem(entry.PublicKeyPem);
        if (key.KeySize != 256)
            throw new CryptographicException("Trusted SIRK update key must be P-256.");
        var supplied = DecodeBase64Url(signature.Value);
        try
        {
            if (supplied.Length != 64 || !key.VerifyData(
                    CanonicalUpdateJson.SerializeWithoutTopLevelSignature(value),
                    supplied,
                    HashAlgorithmName.SHA256,
                    DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
                throw new CryptographicException("SIRK update ES256 signature verification failed.");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(supplied);
        }
    }

    private static void ValidateDescriptor(
        PlatformUpdateDefinition definition,
        PlatformReleaseDescriptor descriptor,
        string version,
        string runtime,
        string channel)
    {
        if (descriptor.SchemaVersion != 1 ||
            descriptor.ApplicationId != definition.ApplicationId ||
            descriptor.Product != definition.Product ||
            descriptor.Version != version ||
            descriptor.Runtime != runtime ||
            descriptor.Channel != channel ||
            descriptor.PublishedAtUtc > DateTimeOffset.UtcNow.AddMinutes(10) ||
            descriptor.Commit.Length != 40 || descriptor.Commit.Any(ch => !Uri.IsHexDigit(ch)) ||
            !IsSha256(descriptor.Sha256) || descriptor.Signature is null ||
            descriptor.AssetName != Path.GetFileName(descriptor.AssetName) ||
            !descriptor.AssetName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Signed SIRK release descriptor metadata is invalid.");
    }

    private HttpClient CreateGitHubClient()
    {
        if (!File.Exists(_tokenFile))
            throw new InvalidDataException("Central GitHub update token file is missing.");
        var token = File.ReadAllText(_tokenFile, Encoding.UTF8).Trim();
        if (token.Length is < 20 or > 512 || token.Any(char.IsWhiteSpace))
            throw new InvalidDataException("Central GitHub update token is invalid.");
        var client = _httpClientFactory.CreateClient("SirkUpdates");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        client.DefaultRequestHeaders.Accept.Clear();
        client.DefaultRequestHeaders.Accept.Add(
            new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        client.DefaultRequestHeaders.UserAgent.ParseAdd("SIRK-Central-UpdateCache/1");
        client.DefaultRequestHeaders.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");
        return client;
    }

    private static async Task<byte[]> DownloadSmallAssetAsync(
        HttpClient client,
        string url,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Accept.Clear();
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        using var response = await client.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > MaximumDescriptorBytes)
            throw new InvalidDataException("Release descriptor is too large.");
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var output = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var read = await input.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            if (output.Length + read > MaximumDescriptorBytes)
                throw new InvalidDataException("Release descriptor is too large.");
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
        return output.ToArray();
    }

    private static async Task DownloadPackageAsync(
        HttpClient client,
        string url,
        string destination,
        long expectedSize,
        long maximumSize,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Accept.Clear();
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        using var response = await client.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength is long length && length != expectedSize)
            throw new InvalidDataException("GitHub package size does not match signed descriptor.");
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var output = new FileStream(
            destination,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            128 * 1024,
            FileOptions.Asynchronous | FileOptions.WriteThrough);
        var buffer = new byte[128 * 1024];
        long total = 0;
        while (true)
        {
            var read = await input.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            total += read;
            if (total > maximumSize || total > expectedSize)
                throw new InvalidDataException("Downloaded SIRK package exceeded signed size.");
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
        await output.FlushAsync(cancellationToken);
        output.Flush(flushToDisk: true);
        if (total != expectedSize)
            throw new InvalidDataException("Downloaded SIRK package is truncated.");
    }

    private CachedPlatformUpdate? ReadCached(
        PlatformUpdateDefinition definition,
        string version,
        string runtime,
        string channel)
    {
        if (!PlatformUpdateVersion.IsValid(version)) return null;
        var directory = Path.Combine(ScopeRoot(definition, runtime, channel), version);
        var descriptorPath = Path.Combine(directory, "release.json");
        var packagePath = Path.Combine(directory, "package.zip");
        if (!File.Exists(descriptorPath) || !File.Exists(packagePath)) return null;
        try
        {
            var descriptor = JsonSerializer.Deserialize<PlatformReleaseDescriptor>(
                File.ReadAllBytes(descriptorPath),
                JsonDefaults.Options);
            if (descriptor is null || descriptor.ApplicationId != definition.ApplicationId ||
                descriptor.Version != version || descriptor.Runtime != runtime ||
                descriptor.Channel != channel || !IsSha256(descriptor.Sha256))
                return null;
            var info = new FileInfo(packagePath);
            if (info.Length != descriptor.Size) return null;
            return new CachedPlatformUpdate(
                definition.ApplicationId,
                version,
                runtime,
                channel,
                descriptor.Sha256,
                descriptor.Size,
                packagePath,
                descriptor);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private PlatformUpdateSourceState? ReadState(string path)
    {
        try
        {
            return File.Exists(path)
                ? JsonSerializer.Deserialize<PlatformUpdateSourceState>(
                    File.ReadAllBytes(path),
                    JsonDefaults.Options)
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private void WriteState(string path, PlatformUpdateSourceState state) => AtomicJson(path, state);

    private IReadOnlyList<string> EnumerateCachedVersions(string scopeRoot)
    {
        if (!Directory.Exists(scopeRoot)) return [];
        return Directory.EnumerateDirectories(scopeRoot, "0.1.1.*", SearchOption.TopDirectoryOnly)
            .Select(Path.GetFileName)
            .Where(PlatformUpdateVersion.IsValid)
            .Cast<string>()
            .OrderByDescending(value => Version.Parse(value))
            .ToArray();
    }

    private void EnforceRetention(string scopeRoot, string latest)
    {
        foreach (var version in EnumerateCachedVersions(scopeRoot).Skip(_retention))
        {
            if (version == latest) continue;
            try
            {
                Directory.Delete(Path.Combine(scopeRoot, version), recursive: true);
            }
            catch (IOException error)
            {
                _logger.LogWarning(
                    "Failed to prune cached SIRK update {Version}: {Reason}.",
                    version,
                    error.GetType().Name);
            }
        }
    }

    private PlatformUpdateDefinition ValidateScope(string applicationId, string runtime, string channel)
    {
        var definition = PlatformUpdateDefinitions.Get(applicationId);
        if (!definition.Runtimes.Contains(runtime))
            throw new InvalidDataException("Unsupported SIRK update runtime.");
        if (channel is not ("stable" or "preview"))
            throw new InvalidDataException("Unsupported SIRK update channel.");
        return definition;
    }

    private string ScopeRoot(PlatformUpdateDefinition definition, string runtime, string channel) =>
        Path.Combine(_cacheRoot, definition.ApplicationId, runtime, channel);

    private static string NormalizeArchivePath(string value)
    {
        var path = (value ?? string.Empty).Replace('\\', '/');
        if (path.Length is <= 0 or > 512 || path.StartsWith('/') ||
            path.Contains("../", StringComparison.Ordinal) || Path.IsPathRooted(path))
            throw new InvalidDataException("Update ZIP contains an unsafe path.");
        return path;
    }

    private static bool IsSha256(string? value) =>
        value is { Length: 64 } && value.All(Uri.IsHexDigit);

    private static byte[] DecodeBase64Url(string value)
    {
        var normalized = value.Replace('-', '+').Replace('_', '/');
        normalized += new string('=', (4 - normalized.Length % 4) % 4);
        return Convert.FromBase64String(normalized);
    }

    private static async Task<string> ComputeSha256Async(
        string path,
        CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            128 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken))
            .ToLowerInvariant();
    }

    private static void AtomicJson<T>(string path, T value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            using (var stream = new FileStream(
                       temporary,
                       FileMode.CreateNew,
                       FileAccess.Write,
                       FileShare.None,
                       4096,
                       FileOptions.WriteThrough))
            {
                JsonSerializer.Serialize(stream, value, JsonDefaults.Options);
                stream.Flush(flushToDisk: true);
            }
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    private static void SecureDirectory(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(
                path,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }
}

internal sealed class HostUpdateControl
{
    private readonly byte[] _token;

    public HostUpdateControl(IConfiguration configuration)
    {
        var path = configuration["Sirk:Updates:HostControlTokenFile"] ??
                   "/run/secrets/sirk-update-host-token";
        if (!File.Exists(path))
        {
            _token = [];
            return;
        }
        var value = File.ReadAllText(path, Encoding.UTF8).Trim();
        _token = Encoding.UTF8.GetBytes(value);
        if (_token.Length is < 32 or > 512)
            throw new InvalidDataException("SIRK host update control token is invalid.");
    }

    public bool Authenticate(HttpContext context)
    {
        if (_token.Length == 0 || context.Connection.RemoteIpAddress is null ||
            !IPAddress.IsLoopback(context.Connection.RemoteIpAddress))
            return false;
        var authorization = context.Request.Headers.Authorization.ToString();
        if (!authorization.StartsWith("Bearer ", StringComparison.Ordinal)) return false;
        var supplied = Encoding.UTF8.GetBytes(authorization[7..].Trim());
        try
        {
            return supplied.Length == _token.Length &&
                   CryptographicOperations.FixedTimeEquals(supplied, _token);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(supplied);
        }
    }
}

internal static class PlatformUpdateDistributionEndpoints
{
    public static void Map(IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet(
            "/api/portal/v1/update/products/{applicationId}/latest",
            LatestForPortalAsync);
        endpoints.MapGet(
            "/api/portal/v1/update/products/{applicationId}/{version}/package",
            DownloadForPortal);
        endpoints.MapGet(
            "/api/portal/v1/update/trusted-keys",
            TrustedKeysForPortal);
        endpoints.MapPost(
            "/api/internal/v1/update/central/prepare",
            PrepareCentralAsync);
        endpoints.MapGet(
                "/api/v1/updates/products/{applicationId}/status",
                (string applicationId, string runtime, string channel, PlatformUpdateCache cache) =>
                    Results.Ok(cache.Status(applicationId, runtime, channel)))
            .RequireAuthorization(SirkPolicies.PortalManagement);
    }

    private static async Task<IResult> LatestForPortalAsync(
        string applicationId,
        HttpContext context,
        PortalRequestAuthenticator authenticator,
        PlatformUpdateCache cache,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        var authentication = authenticator.AuthenticateCredentials(context.Request);
        if (!authentication.Succeeded || authentication.Portal is null)
            return Results.NotFound();
        if (applicationId is not ("sirk-portal" or "sirk-updater"))
            return Results.NotFound();
        var runtime = context.Request.Query["runtime"].ToString();
        var channel = context.Request.Query["channel"].ToString();
        var currentVersion = context.Request.Query["currentVersion"].ToString();
        try
        {
            var latest = await cache.GetLatestAsync(
                applicationId,
                runtime,
                channel,
                cancellationToken);
            if (latest is null ||
                PlatformUpdateVersion.IsValid(currentVersion) &&
                PlatformUpdateVersion.Compare(latest.Version, currentVersion) <= 0)
                return Results.NoContent();
            return Results.Ok(new
            {
                latest.ApplicationId,
                latest.Version,
                latest.Runtime,
                latest.Channel,
                latest.Size,
                latest.Sha256,
                latest.Descriptor,
                packagePath = $"/api/portal/v1/update/products/{applicationId}/{latest.Version}/package"
            });
        }
        catch (Exception error) when (
            error is HttpRequestException or IOException or JsonException or InvalidDataException or CryptographicException or KeyNotFoundException)
        {
            return Results.Json(
                new { ok = false, code = "SIRK_UPDATE_UNAVAILABLE", error = error.Message },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }

    private static IResult DownloadForPortal(
        string applicationId,
        string version,
        HttpContext context,
        PortalRequestAuthenticator authenticator,
        PlatformUpdateCache cache)
    {
        context.Response.Headers.CacheControl = "private, no-store";
        var authentication = authenticator.AuthenticateCredentials(context.Request);
        if (!authentication.Succeeded || authentication.Portal is null)
            return Results.NotFound();
        if (applicationId is not ("sirk-portal" or "sirk-updater"))
            return Results.NotFound();
        var runtime = context.Request.Query["runtime"].ToString();
        var channel = context.Request.Query["channel"].ToString();
        try
        {
            var update = cache.GetPackage(applicationId, version, runtime, channel);
            context.Response.Headers.ETag = '"' + update.Sha256 + '"';
            return Results.File(
                update.PackagePath,
                "application/zip",
                enableRangeProcessing: true);
        }
        catch (FileNotFoundException)
        {
            return Results.NotFound();
        }
        catch (Exception error) when (error is InvalidDataException or KeyNotFoundException)
        {
            return Results.BadRequest(new { ok = false, code = "SIRK_UPDATE_INVALID", error = error.Message });
        }
    }

    private static IResult TrustedKeysForPortal(
        HttpContext context,
        PortalRequestAuthenticator authenticator,
        PlatformUpdateCache cache)
    {
        context.Response.Headers.CacheControl = "private, no-store";
        var authentication = authenticator.AuthenticateCredentials(context.Request);
        if (!authentication.Succeeded || authentication.Portal is null)
            return Results.NotFound();
        try
        {
            return Results.Bytes(cache.ReadTrustedKeys(), "application/json");
        }
        catch (Exception error) when (error is IOException or JsonException or InvalidDataException or CryptographicException)
        {
            return Results.Json(
                new { ok = false, code = "SIRK_UPDATE_TRUST_UNAVAILABLE", error = error.Message },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }

    private static async Task<IResult> PrepareCentralAsync(
        HttpContext context,
        HostUpdateControl control,
        PlatformUpdateCache cache,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        if (!control.Authenticate(context)) return Results.NotFound();
        try
        {
            var latest = await cache.GetLatestAsync(
                "sirk-central",
                "linux-x64",
                "stable",
                cancellationToken) ?? throw new InvalidDataException("No SIRK Central update is available.");
            return Results.Ok(new
            {
                latest.ApplicationId,
                latest.Version,
                latest.Runtime,
                latest.Channel,
                latest.Size,
                latest.Sha256,
                latest.Descriptor.Commit,
                latest.PackagePath
            });
        }
        catch (Exception error) when (
            error is HttpRequestException or IOException or JsonException or InvalidDataException or CryptographicException)
        {
            return Results.Json(
                new { ok = false, code = "CENTRAL_UPDATE_UNAVAILABLE", error = error.Message },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }
}
