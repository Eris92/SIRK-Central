using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;

namespace Sirk.Central.Operations;

internal sealed record MaintenancePolicy(bool AutomaticUpdates, string Channel, int RetainBackups, string MaintenanceWindow, DateTimeOffset UpdatedAtUtc, string UpdatedBy);
internal sealed record UpdateRequest(string? Version, string? Channel, bool DryRun, string Confirmation);
internal sealed record UpdateJob(string Id, string State, string Version, string Channel, bool DryRun, DateTimeOffset CreatedAtUtc, string RequestedBy, string? Error);
internal sealed record OperationsState(int Schema, MaintenancePolicy Policy, Dictionary<string, UpdateJob> Jobs);
internal sealed record PortalReleaseMetadata(int SchemaVersion, string ApplicationId, string Version, string Channel, string PackageUrl, string Sha256, string Architecture, DateTimeOffset? PublishedAtUtc, string Commit);

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

internal sealed class PortalReleaseCatalog
{
    private static readonly HashSet<string> TrustedHosts = new(StringComparer.OrdinalIgnoreCase)
    { "api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com" };
    private readonly IHttpClientFactory _clients;
    private readonly object _sync = new();
    private readonly Dictionary<string, (DateTimeOffset Expires, PortalReleaseMetadata Value)> _cache = [];

    public PortalReleaseCatalog(IHttpClientFactory clients) => _clients = clients;

    public async Task<PortalReleaseMetadata> LatestAsync(string channel, CancellationToken cancellationToken)
    {
        channel = channel == "stable" ? "stable" : "dev";
        lock (_sync) if (_cache.TryGetValue(channel, out var cached) && cached.Expires > DateTimeOffset.UtcNow) return cached.Value;
        var client = _clients.CreateClient("PortalReleaseCatalog");
        using var response = await client.GetAsync("https://api.github.com/repos/Eris92/SIRK-Portal/releases?per_page=30", cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        if (document.RootElement.ValueKind != JsonValueKind.Array) throw new InvalidDataException("GitHub releases response is invalid.");
        string? metadataUrl = null;
        foreach (var release in document.RootElement.EnumerateArray())
        {
            if (release.TryGetProperty("draft", out var draft) && draft.GetBoolean()) continue;
            if (channel == "stable" && release.TryGetProperty("prerelease", out var pre) && pre.GetBoolean()) continue;
            if (!release.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Array) continue;
            foreach (var asset in assets.EnumerateArray())
            {
                var name = asset.GetProperty("name").GetString() ?? string.Empty;
                if (!name.StartsWith("SIRK-Portal-", StringComparison.OrdinalIgnoreCase) || !name.EndsWith("-release.json", StringComparison.OrdinalIgnoreCase)) continue;
                metadataUrl = asset.GetProperty("browser_download_url").GetString(); break;
            }
            if (metadataUrl is not null) break;
        }
        if (metadataUrl is null) throw new KeyNotFoundException("No matching SIRK Portal release was found.");
        ValidateTrustedUri(metadataUrl);
        var metadata = await client.GetFromJsonAsync<PortalReleaseMetadata>(metadataUrl, cancellationToken)
            ?? throw new InvalidDataException("Portal release metadata is empty.");
        metadata = Validate(metadata, channel);
        lock (_sync) _cache[channel] = (DateTimeOffset.UtcNow.AddMinutes(5), metadata);
        return metadata;
    }

    internal static PortalReleaseMetadata Validate(PortalReleaseMetadata value, string requestedChannel)
    {
        if (value.SchemaVersion != 1 || value.ApplicationId != "sirk-portal") throw new InvalidDataException("Portal release metadata schema is invalid.");
        if (value.Architecture != "win-x64") throw new InvalidDataException("Portal release architecture is invalid.");
        if (value.Version.Length is < 1 or > 80 || value.Version.Any(ch => !(char.IsAsciiLetterOrDigit(ch) || ch is '.' or '+' or '_' or '-')))
            throw new InvalidDataException("Portal release version is invalid.");
        if (value.Sha256.Length != 64 || value.Sha256.Any(ch => !Uri.IsHexDigit(ch))) throw new InvalidDataException("Portal release SHA-256 is invalid.");
        ValidateTrustedUri(value.PackageUrl);
        var uri = new Uri(value.PackageUrl);
        if (!uri.AbsolutePath.EndsWith("-win-x64.zip", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Portal package asset is invalid.");
        var channel = value.Channel == "stable" ? "stable" : "dev";
        if (requestedChannel == "stable" && channel != "stable") throw new InvalidDataException("Stable release metadata has a non-stable channel.");
        return value with { Channel = channel, Sha256 = value.Sha256.ToUpperInvariant(), Commit = (value.Commit ?? string.Empty)[..Math.Min(value.Commit?.Length ?? 0, 80)] };
    }
    private static void ValidateTrustedUri(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps || !TrustedHosts.Contains(uri.Host) || !string.IsNullOrEmpty(uri.UserInfo))
            throw new InvalidDataException("Release URL is not trusted.");
    }
}

internal static class OperationsEndpoints
{
    public static IEndpointRouteBuilder MapOperations(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/operations").RequireAuthorization(SirkPolicies.PortalManagement);
        group.MapGet("/maintenance", (OperationsStore store) => Results.Ok(new { policy = store.Policy(), jobs = store.Jobs() }));
        group.MapPut("/maintenance/policy", SavePolicyAsync);
        group.MapPost("/updates", QueueUpdateAsync);
        group.MapGet("/portal-releases/latest", async (string? channel, PortalReleaseCatalog catalog, CancellationToken ct) =>
        {
            try { return Results.Ok(new { release = await catalog.LatestAsync(channel == "stable" ? "stable" : "dev", ct) }); }
            catch (KeyNotFoundException ex) { return Results.Json(new { error = ex.Message }, statusCode: 404); }
            catch (Exception ex) when (ex is HttpRequestException or InvalidDataException or TaskCanceledException)
            { return Results.Json(new { code = "PORTAL_RELEASE_LOOKUP_FAILED", error = ex.Message }, statusCode: 502); }
        });
        return endpoints;
    }
    private static async Task<IResult> SavePolicyAsync(MaintenancePolicy request, HttpContext context, IAntiforgery antiforgery, OperationsStore store)
        => await Mutate(context, antiforgery, () => Results.Ok(store.SavePolicy(request, Actor(context))));
    private static async Task<IResult> QueueUpdateAsync(UpdateRequest request, HttpContext context, IAntiforgery antiforgery, OperationsStore store)
        => await Mutate(context, antiforgery, () => Results.Accepted(value: store.Queue(request, Actor(context))));
    private static async Task<IResult> Mutate(HttpContext context, IAntiforgery antiforgery, Func<IResult> action)
    {
        try { await antiforgery.ValidateRequestAsync(context); return action(); }
        catch (AntiforgeryValidationException) { return Results.Json(new { code = "CSRF_VALIDATION_FAILED" }, statusCode: 400); }
        catch (Exception ex) when (ex is InvalidDataException or InvalidOperationException) { return Results.Json(new { error = ex.Message }, statusCode: 409); }
    }
    private static string Actor(HttpContext context) => context.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value ?? "unknown";
}
