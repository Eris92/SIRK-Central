using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Antiforgery;
using Sirk.Central.PublicSite;
using Sirk.Central.Security;

namespace Sirk.Central.Demo;

internal sealed record DemoManagementSettings(
    int SchemaVersion,
    bool Enabled,
    string DesiredVersion,
    int MaxSessions,
    int IdleTtlMinutes,
    int AbsoluteTtlMinutes,
    bool Maintenance,
    DateTimeOffset UpdatedAtUtc);

internal sealed record DemoManagementUpdate(
    bool Enabled,
    string DesiredVersion,
    int MaxSessions,
    int IdleTtlMinutes,
    int AbsoluteTtlMinutes,
    bool Maintenance);

internal sealed class DemoManagementStore
{
    private static readonly object Sync = new();
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private static readonly Regex VersionPattern = new("^0\\.1\\.1\\.[0-9]+$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private readonly string _path;

    public DemoManagementStore(IConfiguration configuration)
    {
        var root = configuration["Sirk:PortalProtocol:DataRoot"];
        if (string.IsNullOrWhiteSpace(root)) root = "/var/lib/sirk-central";
        _path = Path.Combine(root, "demo", "settings.json");
    }

    public DemoManagementSettings Get()
    {
        lock (Sync)
        {
            if (!File.Exists(_path))
                return new DemoManagementSettings(1, false, "0.1.1.1", 4, 20, 60, false, DateTimeOffset.UnixEpoch);
            var value = JsonSerializer.Deserialize<DemoManagementSettings>(File.ReadAllBytes(_path), Json)
                        ?? throw new InvalidDataException("Demo settings are invalid.");
            Validate(new DemoManagementUpdate(value.Enabled, value.DesiredVersion, value.MaxSessions,
                value.IdleTtlMinutes, value.AbsoluteTtlMinutes, value.Maintenance));
            return value;
        }
    }

    public DemoManagementSettings Save(DemoManagementUpdate request)
    {
        Validate(request);
        lock (Sync)
        {
            var value = new DemoManagementSettings(1, request.Enabled, request.DesiredVersion,
                request.MaxSessions, request.IdleTtlMinutes, request.AbsoluteTtlMinutes,
                request.Maintenance, DateTimeOffset.UtcNow);
            var directory = Path.GetDirectoryName(_path)!;
            Directory.CreateDirectory(directory);
            var temporary = Path.Combine(directory, ".settings.tmp-" + Guid.NewGuid().ToString("N"));
            try
            {
                File.WriteAllBytes(temporary, JsonSerializer.SerializeToUtf8Bytes(value, Json));
                File.Move(temporary, _path, overwrite: true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            return value;
        }
    }

    public static void Validate(DemoManagementUpdate request)
    {
        if (!VersionPattern.IsMatch((request.DesiredVersion ?? string.Empty).Trim()))
            throw new InvalidDataException("Demo version must use 0.1.1.X.");
        if (request.MaxSessions is < 1 or > 100) throw new InvalidDataException("Max sessions must be between 1 and 100.");
        if (request.IdleTtlMinutes is < 5 or > 120) throw new InvalidDataException("Idle TTL must be between 5 and 120 minutes.");
        if (request.AbsoluteTtlMinutes <= request.IdleTtlMinutes || request.AbsoluteTtlMinutes > 480)
            throw new InvalidDataException("Absolute TTL must be greater than idle TTL and no more than 480 minutes.");
    }
}

internal sealed class DemoOrchestratorClient
{
    private readonly HttpClient _client;
    private readonly string _tokenFile;

    public DemoOrchestratorClient(IConfiguration configuration)
    {
        var baseUrl = configuration["Sirk:Demo:OrchestratorUrl"] ?? "http://demo-orchestrator:8090";
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttp)
            throw new InvalidDataException("Demo orchestrator URL must be an internal HTTP URL.");
        _client = new HttpClient { BaseAddress = uri, Timeout = TimeSpan.FromSeconds(15) };
        _tokenFile = configuration["Sirk:Demo:ControlTokenFile"] ?? "/run/secrets/sirk-demo-control-token";
    }

    public async Task<JsonDocument> ConfigureAsync(DemoManagementUpdate request, CancellationToken cancellationToken)
    {
        var body = new DemoRuntimeConfig(request.Enabled, request.DesiredVersion.Trim(), request.MaxSessions,
            request.IdleTtlMinutes, request.AbsoluteTtlMinutes, request.Maintenance);
        return await SendAsync(HttpMethod.Post, "/control/config", body, cancellationToken);
    }

    public Task<JsonDocument> StatusAsync(CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Get, "/control/status", null, cancellationToken);

    public Task<JsonDocument> DrainAsync(CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Post, "/control/drain", new { }, cancellationToken);

    private async Task<JsonDocument> SendAsync(HttpMethod method, string path, object? body, CancellationToken cancellationToken)
    {
        var token = File.ReadAllText(_tokenFile, Encoding.UTF8).Trim();
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        if (body is not null) request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var response = await _client.SendAsync(request, cancellationToken);
        var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"Demo orchestrator returned {(int)response.StatusCode}: {Encoding.UTF8.GetString(bytes)}");
        return JsonDocument.Parse(bytes);
    }
}

internal static class DemoManagementEndpoints
{
    public static void Map(IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/demo")
            .RequireAuthorization(SirkPolicies.PortalManagement);
        group.MapGet("/settings", GetAsync);
        group.MapPut("/settings", UpdateAsync);
        group.MapGet("/status", StatusAsync);
        group.MapPost("/drain", DrainAsync);
    }

    private static async Task<IResult> GetAsync(IConfiguration configuration, CancellationToken cancellationToken)
    {
        var settings = new DemoManagementStore(configuration).Get();
        JsonElement? runtime = null;
        string? runtimeError = null;
        try
        {
            using var status = await new DemoOrchestratorClient(configuration).StatusAsync(cancellationToken);
            runtime = status.RootElement.Clone();
        }
        catch (Exception error) { runtimeError = error.Message; }
        return Results.Ok(new { settings, runtime, runtimeError });
    }

    private static async Task<IResult> UpdateAsync(
        DemoManagementUpdate request,
        HttpContext context,
        IConfiguration configuration,
        IAntiforgery antiforgery,
        SecurityAuditLog auditLog,
        CancellationToken cancellationToken)
    {
        if (!await ValidateCsrfAsync(context, antiforgery)) return CsrfFailure();
        try
        {
            DemoManagementStore.Validate(request);
            using var runtime = await new DemoOrchestratorClient(configuration).ConfigureAsync(request, cancellationToken);
            var saved = new DemoManagementStore(configuration).Save(request);
            PublishDemoState(configuration, saved.Enabled, saved.Enabled && !saved.Maintenance);
            Audit(context, auditLog, "demo.settings.update", saved.DesiredVersion, true,
                new Dictionary<string, string>
                {
                    ["enabled"] = saved.Enabled.ToString(), ["version"] = saved.DesiredVersion,
                    ["maxSessions"] = saved.MaxSessions.ToString(), ["maintenance"] = saved.Maintenance.ToString()
                });
            return Results.Ok(new { settings = saved, runtime = runtime.RootElement.Clone() });
        }
        catch (Exception error) when (error is InvalidDataException or InvalidOperationException or IOException or HttpRequestException)
        {
            Audit(context, auditLog, "demo.settings.update", request.DesiredVersion ?? "", false,
                new Dictionary<string, string> { ["reason"] = error.GetType().Name });
            return Results.Json(new { ok = false, code = "DEMO_CONFIGURATION_FAILED", error = error.Message },
                statusCode: error is InvalidDataException ? 400 : 503);
        }
    }

    private static async Task<IResult> StatusAsync(IConfiguration configuration, CancellationToken cancellationToken)
    {
        try
        {
            using var status = await new DemoOrchestratorClient(configuration).StatusAsync(cancellationToken);
            return Results.Text(status.RootElement.GetRawText(), "application/json");
        }
        catch (Exception error)
        {
            return Results.Json(new { ok = false, code = "DEMO_ORCHESTRATOR_UNAVAILABLE", error = error.Message }, statusCode: 503);
        }
    }

    private static async Task<IResult> DrainAsync(
        HttpContext context,
        IConfiguration configuration,
        IAntiforgery antiforgery,
        CancellationToken cancellationToken)
    {
        if (!await ValidateCsrfAsync(context, antiforgery)) return CsrfFailure();
        try
        {
            using var status = await new DemoOrchestratorClient(configuration).DrainAsync(cancellationToken);
            var current = new DemoManagementStore(configuration).Get();
            new DemoManagementStore(configuration).Save(new DemoManagementUpdate(current.Enabled, current.DesiredVersion,
                current.MaxSessions, current.IdleTtlMinutes, current.AbsoluteTtlMinutes, true));
            PublishDemoState(configuration, current.Enabled, false);
            return Results.Text(status.RootElement.GetRawText(), "application/json");
        }
        catch (Exception error)
        {
            return Results.Json(new { ok = false, code = "DEMO_DRAIN_FAILED", error = error.Message }, statusCode: 503);
        }
    }

    private static void PublishDemoState(IConfiguration configuration, bool enabled, bool available)
    {
        var publicStore = new PublicSiteConfigStore(configuration);
        var current = publicStore.Get().Settings;
        var publicBase = (configuration["Sirk:Demo:PublicBaseUrl"] ?? "https://demo.sirkportal.com").TrimEnd('/');
        publicStore.Update(new PublicSiteUpdateRequest(
            new PublicSiteDemoSettings(enabled, available, enabled ? publicBase + "/start" : null),
            current.Features,
            current.Maintenance));
    }

    private static void Audit(HttpContext context, SecurityAuditLog auditLog, string action, string target, bool success,
        IReadOnlyDictionary<string, string> details)
    {
        auditLog.Write(new SecurityAuditEvent(
            context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown",
            context.User.Identity?.Name ?? "unknown",
            action,
            "demo",
            target,
            success,
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            context.TraceIdentifier,
            details));
    }

    private static async Task<bool> ValidateCsrfAsync(HttpContext context, IAntiforgery antiforgery)
    {
        try { await antiforgery.ValidateRequestAsync(context); return true; }
        catch (AntiforgeryValidationException) { return false; }
    }

    private static IResult CsrfFailure() => Results.Json(new { ok = false, code = "CSRF_VALIDATION_FAILED" }, statusCode: 400);
}
