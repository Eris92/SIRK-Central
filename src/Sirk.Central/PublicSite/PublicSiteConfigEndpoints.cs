using System.Net;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Sirk.Central.Security;

namespace Sirk.Central.PublicSite;

internal sealed record PublicSiteDemoSettings(bool Enabled, bool Available, string? CtaUrl);
internal sealed record PublicSiteFeatureSettings(bool Agent, bool Portal, bool Central, bool Contact, bool Registration);
internal sealed record PublicSiteMaintenanceSettings(bool Enabled, string Status, string? Message);
internal sealed record PublicSiteSettings(
    int SchemaVersion,
    long Revision,
    DateTimeOffset UpdatedAtUtc,
    PublicSiteDemoSettings Demo,
    PublicSiteFeatureSettings Features,
    PublicSiteMaintenanceSettings Maintenance);
internal sealed record PublicSiteUpdateRequest(
    PublicSiteDemoSettings Demo,
    PublicSiteFeatureSettings Features,
    PublicSiteMaintenanceSettings Maintenance);
internal sealed record PublicSiteSnapshot(
    int SchemaVersion,
    long Revision,
    DateTimeOffset GeneratedAtUtc,
    PublicSiteDemoSettings Demo,
    PublicSiteFeatureSettings Features,
    PublicSiteMaintenanceSettings Maintenance);
internal sealed record PublicSitePublishStatus(
    bool Healthy,
    long Revision,
    DateTimeOffset CheckedAtUtc,
    string? Error);
internal sealed record PublicSiteAdminState(
    PublicSiteSettings Settings,
    bool SnapshotPublished,
    string SnapshotPath,
    string? LastPublishError);

internal sealed class PublicSiteConfigStore
{
    private static readonly object Sync = new();
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly string _settingsPath;
    private readonly string _publishStatusPath;
    private readonly string _snapshotPath;
    private readonly string _publicDomain;

    public PublicSiteConfigStore(IConfiguration configuration)
    {
        var centralDataRoot = configuration["Sirk:PortalProtocol:DataRoot"];
        if (string.IsNullOrWhiteSpace(centralDataRoot)) centralDataRoot = "/var/lib/sirk-central";
        var dataRoot = configuration["Sirk:PublicSite:DataRoot"];
        if (string.IsNullOrWhiteSpace(dataRoot)) dataRoot = Path.Combine(centralDataRoot, "public-site");
        _settingsPath = Path.Combine(dataRoot, "settings.json");
        _publishStatusPath = Path.Combine(dataRoot, "publish-status.json");
        _snapshotPath = configuration["Sirk:PublicSite:SnapshotPath"] ?? "/var/lib/sirk-public/sirk-config.json";
        _publicDomain = (configuration["Sirk:PublicSite:PublicDomain"] ?? "sirkportal.com").Trim().Trim('.').ToLowerInvariant();
    }

    public PublicSiteAdminState Get()
    {
        lock (Sync)
        {
            var settings = ReadOrDefault();
            var status = ReadPublishStatus();
            return new PublicSiteAdminState(
                settings,
                File.Exists(_snapshotPath) && status is { Healthy: true } && status.Revision == settings.Revision,
                _snapshotPath,
                status?.Error);
        }
    }

    public PublicSiteAdminState Update(PublicSiteUpdateRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        lock (Sync)
        {
            var current = ReadOrDefault();
            Validate(request);
            var next = new PublicSiteSettings(
                1,
                checked(current.Revision + 1),
                DateTimeOffset.UtcNow,
                request.Demo,
                request.Features,
                request.Maintenance);

            WriteAtomic(_settingsPath, next);
            PublishWithStatus(next);
            return new PublicSiteAdminState(next, true, _snapshotPath, null);
        }
    }

    public PublicSiteAdminState Republish()
    {
        lock (Sync)
        {
            var current = ReadOrDefault();
            PublishWithStatus(current);
            return new PublicSiteAdminState(current, true, _snapshotPath, null);
        }
    }

    private PublicSiteSettings ReadOrDefault()
    {
        if (!File.Exists(_settingsPath))
        {
            return new PublicSiteSettings(
                1,
                0,
                DateTimeOffset.UnixEpoch,
                new PublicSiteDemoSettings(false, false, null),
                new PublicSiteFeatureSettings(true, true, true, true, false),
                new PublicSiteMaintenanceSettings(false, "operational", null));
        }

        var value = JsonSerializer.Deserialize<PublicSiteSettings>(File.ReadAllBytes(_settingsPath), Json)
                    ?? throw new InvalidDataException("Public site settings are invalid.");
        if (value.SchemaVersion != 1 || value.Revision < 0) throw new InvalidDataException("Public site settings schema is unsupported.");
        Validate(new PublicSiteUpdateRequest(value.Demo, value.Features, value.Maintenance));
        return value;
    }

    private PublicSitePublishStatus? ReadPublishStatus()
    {
        if (!File.Exists(_publishStatusPath)) return null;
        try
        {
            return JsonSerializer.Deserialize<PublicSitePublishStatus>(File.ReadAllBytes(_publishStatusPath), Json);
        }
        catch (JsonException)
        {
            return new PublicSitePublishStatus(false, -1, DateTimeOffset.UtcNow, "Publish status is invalid.");
        }
    }

    private void PublishWithStatus(PublicSiteSettings settings)
    {
        try
        {
            Publish(settings);
            WriteAtomic(_publishStatusPath, new PublicSitePublishStatus(true, settings.Revision, DateTimeOffset.UtcNow, null));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            try
            {
                WriteAtomic(_publishStatusPath, new PublicSitePublishStatus(
                    false,
                    settings.Revision,
                    DateTimeOffset.UtcNow,
                    error.GetType().Name + ": " + error.Message));
            }
            catch
            {
                // Do not mask the original snapshot publication failure.
            }
            throw;
        }
    }

    private void Publish(PublicSiteSettings settings)
    {
        var snapshot = new PublicSiteSnapshot(
            1,
            settings.Revision,
            DateTimeOffset.UtcNow,
            settings.Demo,
            settings.Features,
            settings.Maintenance);
        WriteAtomic(_snapshotPath, snapshot);
    }

    private void Validate(PublicSiteUpdateRequest request)
    {
        ArgumentNullException.ThrowIfNull(request.Demo);
        ArgumentNullException.ThrowIfNull(request.Features);
        ArgumentNullException.ThrowIfNull(request.Maintenance);

        if (request.Demo.Enabled && request.Demo.Available && string.IsNullOrWhiteSpace(request.Demo.CtaUrl))
            throw new InvalidDataException("Demo CTA URL is required when Demo is enabled and available.");
        if (!string.IsNullOrWhiteSpace(request.Demo.CtaUrl)) ValidatePublicUrl(request.Demo.CtaUrl);

        if (request.Maintenance.Status is not ("operational" or "degraded" or "maintenance"))
            throw new InvalidDataException("Maintenance status is unsupported.");
        if (request.Maintenance.Message is { Length: > 300 })
            throw new InvalidDataException("Maintenance message is too long.");
        if (request.Maintenance.Enabled && string.IsNullOrWhiteSpace(request.Maintenance.Message))
            throw new InvalidDataException("Maintenance message is required when maintenance banner is enabled.");
    }

    private void ValidatePublicUrl(string raw)
    {
        if (raw.Length > 2048 || !Uri.TryCreate(raw, UriKind.Absolute, out var uri) ||
            uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo) ||
            string.IsNullOrWhiteSpace(uri.Host) || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
            IPAddress.TryParse(uri.Host, out _))
            throw new InvalidDataException("Demo CTA must be a public HTTPS URL.");

        var host = uri.IdnHost.TrimEnd('.').ToLowerInvariant();
        if (host != _publicDomain && !host.EndsWith("." + _publicDomain, StringComparison.Ordinal))
            throw new InvalidDataException("Demo CTA host must belong to the configured public SIRK domain.");
    }

    internal static void WriteAtomic<T>(string path, T value)
    {
        var directory = Path.GetDirectoryName(path) ?? throw new InvalidDataException("Output path has no directory.");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, "." + Path.GetFileName(path) + ".tmp-" + Guid.NewGuid().ToString("N"));
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(value, Json);
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
}

internal static class PublicSiteConfigEndpoints
{
    public static void Map(IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/settings/public-site")
            .RequireAuthorization(SirkPolicies.PortalManagement);
        group.MapGet("/", (IConfiguration configuration) => Results.Ok(new PublicSiteConfigStore(configuration).Get()));
        group.MapPut("/", UpdateAsync);
        group.MapPost("/republish", RepublishAsync);
    }

    private static async Task<IResult> UpdateAsync(
        PublicSiteUpdateRequest request,
        HttpContext context,
        IConfiguration configuration,
        IAntiforgery antiforgery,
        SecurityAuditLog auditLog)
    {
        if (!await ValidateCsrfAsync(context, antiforgery)) return CsrfFailure();
        var actorId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown";
        var actorName = context.User.Identity?.Name ?? "unknown";
        try
        {
            var result = new PublicSiteConfigStore(configuration).Update(request);
            auditLog.Write(new SecurityAuditEvent(actorId, actorName, "public-site.settings.update", "public-site",
                result.Settings.Revision.ToString(), true,
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown", context.TraceIdentifier,
                new Dictionary<string, string>
                {
                    ["revision"] = result.Settings.Revision.ToString(),
                    ["demoEnabled"] = result.Settings.Demo.Enabled.ToString(),
                    ["maintenanceEnabled"] = result.Settings.Maintenance.Enabled.ToString()
                }));
            return Results.Ok(result);
        }
        catch (InvalidDataException error)
        {
            AuditFailure(context, auditLog, actorId, actorName, error);
            return Results.Json(new { ok = false, code = "PUBLIC_SITE_SETTINGS_INVALID", error = error.Message },
                statusCode: StatusCodes.Status400BadRequest);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            AuditFailure(context, auditLog, actorId, actorName, error);
            return Results.Json(new { ok = false, code = "PUBLIC_SITE_PUBLISH_FAILED", error = error.Message },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }

    private static async Task<IResult> RepublishAsync(
        HttpContext context,
        IConfiguration configuration,
        IAntiforgery antiforgery)
    {
        if (!await ValidateCsrfAsync(context, antiforgery)) return CsrfFailure();
        try { return Results.Ok(new PublicSiteConfigStore(configuration).Republish()); }
        catch (Exception error) when (error is InvalidDataException or IOException or UnauthorizedAccessException)
        {
            return Results.Json(new { ok = false, code = "PUBLIC_SITE_PUBLISH_FAILED", error = error.Message },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }

    private static void AuditFailure(
        HttpContext context,
        SecurityAuditLog auditLog,
        string actorId,
        string actorName,
        Exception error)
    {
        auditLog.Write(new SecurityAuditEvent(actorId, actorName, "public-site.settings.update", "public-site", "", false,
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown", context.TraceIdentifier,
            new Dictionary<string, string> { ["reason"] = error.GetType().Name }));
    }

    private static async Task<bool> ValidateCsrfAsync(HttpContext context, IAntiforgery antiforgery)
    {
        try { await antiforgery.ValidateRequestAsync(context); return true; }
        catch (AntiforgeryValidationException) { return false; }
    }

    private static IResult CsrfFailure() => Results.Json(new { ok = false, code = "CSRF_VALIDATION_FAILED" },
        statusCode: StatusCodes.Status400BadRequest);
}
