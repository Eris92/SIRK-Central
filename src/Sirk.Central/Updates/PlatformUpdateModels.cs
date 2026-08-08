using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

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
    [property: JsonPropertyName("publishedAtUtc"), JsonConverter(typeof(ReleaseTimestampJsonConverter))] DateTimeOffset PublishedAtUtc,
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
            ["sirk-agent"] = new(
                "sirk-agent",
                "SIRK Agent",
                "Eris92/SIRK-Agent",
                "SIRK-Agent",
                new HashSet<string>(StringComparer.Ordinal) { "win-x64" },
                80L * 1024 * 1024),
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
                512L * 1024 * 1024)
        };

    public static PlatformUpdateDefinition Get(string applicationId) =>
        Values.TryGetValue(applicationId, out var value)
            ? value
            : throw new KeyNotFoundException("Unknown SIRK update product.");
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
