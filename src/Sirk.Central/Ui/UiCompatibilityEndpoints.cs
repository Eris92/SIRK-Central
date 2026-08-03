using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Options;
using Sirk.Central.Access;
using Sirk.Central.Portals;
using Sirk.Central.Security;

namespace Sirk.Central.Ui;

internal sealed record UiLocalUserRequest(string UserName, string DisplayName, string Password, string Role);
internal sealed record UiRoleRequest(string Role);
internal sealed record UiSimulationRequest(string MemberKey);
internal sealed record UiSecurityPolicyUpdate(
    int SessionHours,
    bool RequireReauthenticationForSensitiveActions,
    bool PrivilegedRoleApproval,
    bool AlertOnBreakGlassUse,
    bool BlockNewPortalConnections,
    bool EmergencyMode);
internal sealed record UiIncidentCreate(string Title, string Severity, string? Description);
internal sealed record UiIncidentUpdate(string Status);
internal sealed record UiIncident(
    string Id,
    string Title,
    string Severity,
    string Description,
    string Status,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc,
    string CreatedBy);
internal sealed record UiSecurityState(
    int Schema,
    UiSecurityPolicyUpdate Policies,
    List<UiIncident> Incidents,
    DateTimeOffset? BreakGlassReviewedAtUtc,
    string BreakGlassReviewedBy);

internal sealed class UiSecurityStateStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object _sync = new();
    private readonly string _path;
    private UiSecurityState _state;

    public UiSecurityStateStore(IOptions<SecurityOptions> options)
    {
        Directory.CreateDirectory(options.Value.DataRoot);
        _path = Path.Combine(options.Value.DataRoot, "ui-security-state.net10.json");
        _state = Load() ?? new UiSecurityState(
            1,
            new UiSecurityPolicyUpdate(8, true, true, true, false, false),
            [],
            null,
            string.Empty);
        if (_state.Schema != 1) throw new InvalidDataException("UI security state schema is unsupported.");
    }

    public UiSecurityState Snapshot()
    {
        lock (_sync) return _state with { Incidents = [.. _state.Incidents] };
    }

    public UiSecurityPolicyUpdate SavePolicies(UiSecurityPolicyUpdate value)
    {
        if (value.SessionHours is < 1 or > 24) throw new InvalidDataException("Session hours must be between 1 and 24.");
        lock (_sync)
        {
            _state = _state with { Policies = value };
            Persist();
            return value;
        }
    }

    public UiIncident CreateIncident(UiIncidentCreate input, ClaimsPrincipal actor)
    {
        var title = Required(input.Title, 160, "Incident title");
        var severity = (input.Severity ?? string.Empty).Trim().ToLowerInvariant();
        if (severity is not ("low" or "medium" or "high" or "critical"))
            throw new InvalidDataException("Incident severity is invalid.");
        var now = DateTimeOffset.UtcNow;
        var value = new UiIncident(
            "inc-" + Guid.NewGuid().ToString("N"),
            title,
            severity,
            Optional(input.Description, 4000),
            "open",
            now,
            now,
            actor.Identity?.Name ?? "unknown");
        lock (_sync)
        {
            _state.Incidents.Insert(0, value);
            Persist();
            return value;
        }
    }

    public UiIncident UpdateIncident(string id, UiIncidentUpdate input)
    {
        var status = (input.Status ?? string.Empty).Trim().ToLowerInvariant();
        if (status is not ("open" or "investigating" or "resolved"))
            throw new InvalidDataException("Incident status is invalid.");
        lock (_sync)
        {
            var index = _state.Incidents.FindIndex(value => value.Id == id);
            if (index < 0) throw new KeyNotFoundException("Incident was not found.");
            var value = _state.Incidents[index] with { Status = status, UpdatedAtUtc = DateTimeOffset.UtcNow };
            _state.Incidents[index] = value;
            Persist();
            return value;
        }
    }

    public void ReviewBreakGlass(ClaimsPrincipal actor)
    {
        lock (_sync)
        {
            _state = _state with
            {
                BreakGlassReviewedAtUtc = DateTimeOffset.UtcNow,
                BreakGlassReviewedBy = actor.Identity?.Name ?? "unknown"
            };
            Persist();
        }
    }

    private UiSecurityState? Load()
    {
        if (!File.Exists(_path)) return null;
        using var stream = File.OpenRead(_path);
        return JsonSerializer.Deserialize<UiSecurityState>(stream, JsonOptions);
    }

    private void Persist()
    {
        var temporary = $"{_path}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(_state, JsonOptions));
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(temporary, _path, true);
        }
        finally { File.Delete(temporary); }
    }

    private static string Required(string? value, int maximum, string field)
    {
        var normalized = (value ?? string.Empty).Trim();
        if (normalized.Length is < 1 || normalized.Length > maximum || normalized.Any(char.IsControl))
            throw new InvalidDataException($"{field} is invalid.");
        return normalized;
    }

    private static string Optional(string? value, int maximum)
    {
        var normalized = (value ?? string.Empty).Trim();
        if (normalized.Length > maximum || normalized.Contains('\0')) throw new InvalidDataException("Text is invalid.");
        return normalized;
    }
}

internal sealed class UiAuditReader
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly SecurityAuditLog _audit;
    private readonly string _path;

    public UiAuditReader(SecurityAuditLog audit, IOptions<SecurityOptions> options)
    {
        _audit = audit;
        _path = Path.Combine(options.Value.DataRoot, options.Value.AuditFileName);
    }

    public IReadOnlyList<object> Recent(int limit = 200)
    {
        _audit.VerifyIntegrity();
        if (!File.Exists(_path)) return [];
        var result = new List<object>();
        foreach (var line in File.ReadLines(_path).Reverse().Take(Math.Clamp(limit, 1, 1000)))
        {
            var record = JsonSerializer.Deserialize<SecurityAuditRecord>(line, JsonOptions);
            if (record is null) continue;
            result.Add(new
            {
                id = record.Id,
                eventName = record.Action,
                @event = record.Action,
                atUtc = record.TimestampUtc,
                actor = record.ActorName,
                actorId = record.ActorId,
                role = record.Details.GetValueOrDefault("role", string.Empty),
                targetType = record.TargetType,
                targetId = record.TargetId,
                success = record.Success,
                remoteAddress = record.RemoteAddress,
                correlationId = record.CorrelationId,
                details = record.Details
            });
        }
        return result;
    }
}

internal static class UiCompatibilityEndpoints
{
    public static IServiceCollection AddCurrentUiCompatibility(this IServiceCollection services)
    {
        services.AddSingleton<UiSecurityStateStore>();
        services.AddSingleton<UiAuditReader>();
        return services;
    }

    public static IEndpointRouteBuilder MapCurrentUiCompatibility(this IEndpointRouteBuilder endpoints)
    {
        var settings = endpoints.MapGroup("/api/settings")
            .RequireAuthorization(SirkPolicies.SecurityAdministration);
        settings.MapGet("/roles", GetRoles);
        settings.MapGet("/users", GetUsers);
        settings.MapPost("/users", CreateUserAsync);
        settings.MapPatch("/users/{source}/{key}/role", ChangeUserRoleAsync);
        settings.MapPost("/users/entra/{key}/approve", (string key, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
            Mutate(context, antiforgery, () => Results.Ok(store.DecideEntraRole("entra:" + Uri.UnescapeDataString(key), "approve", context.User))));
        settings.MapPost("/users/entra/{key}/reject", (string key, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
            Mutate(context, antiforgery, () => Results.Ok(store.DecideEntraRole("entra:" + Uri.UnescapeDataString(key), "reject", context.User))));

        var access = endpoints.MapGroup("/api/access-control")
            .RequireAuthorization(SirkPolicies.PortalManagement);
        access.MapGet("/", GetAccessControl);
        access.MapPost("/teams", SaveTeamAsync);
        access.MapDelete("/teams/{id}", DeleteTeamAsync);
        access.MapGet("/portals/{portalId}/policy", (string portalId, IdentityAccessStore store) => Results.Ok(new { ok = true, policy = store.PortalPolicy(portalId) }));
        access.MapPut("/portals/{portalId}/policy", SavePolicyAsync);
        access.MapPost("/simulate", SimulateAccess);

        var security = endpoints.MapGroup("/api/security")
            .RequireAuthorization(SirkPolicies.SecurityAdministration);
        security.MapGet("/overview", SecurityOverview);
        security.MapPut("/policies", SaveSecurityPoliciesAsync);
        security.MapPost("/break-glass/review", ReviewBreakGlassAsync);
        security.MapPost("/incidents", CreateIncidentAsync);
        security.MapPatch("/incidents/{id}", UpdateIncidentAsync);
        security.MapPost("/sessions/revoke-all", RevokeSessionsAsync);
        security.MapDelete("/sessions/{id}", RevokeSessionAsync);

        endpoints.MapGet("/api/audit", (UiAuditReader reader, int? limit) => Results.Ok(new { ok = true, events = reader.Recent(limit ?? 200) }))
            .RequireAuthorization(SirkPolicies.AuditRead);
        return endpoints;
    }

    private static IResult GetRoles() => Results.Ok(new
    {
        ok = true,
        roles = SirkRoles.Assignable.OrderBy(value => value, StringComparer.Ordinal).ToArray()
    });

    private static IResult GetUsers(IdentityAccessStore store) => Results.Ok(new
    {
        ok = true,
        users = store.ListIdentities().Select(ToUiIdentity).ToArray()
    });

    private static async Task<IResult> CreateUserAsync(
        UiLocalUserRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(ToUiIdentity(store.CreateLocal(
            new CreateLocalIdentityRequest(request.UserName, request.DisplayName, request.Password, request.Role), context.User))));

    private static async Task<IResult> ChangeUserRoleAsync(
        string source,
        string key,
        UiRoleRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        IdentityAccessStore store)
    {
        var identityKey = source == "local" ? "local:" + Uri.UnescapeDataString(key) : "entra:" + Uri.UnescapeDataString(key);
        return await Mutate(context, antiforgery, () => Results.Ok(ToUiIdentity(store.UpdateRole(identityKey, new ChangeRoleRequest(request.Role), context.User))));
    }

    private static IResult GetAccessControl(
        IdentityAccessStore store,
        FilePortalRegistry portals) => Results.Ok(new
    {
        ok = true,
        users = store.ListIdentities().Select(ToUiIdentity).ToArray(),
        teams = store.ListTeams(),
        portals = portals.List().Select(value => new { value.Id, value.Name }).ToArray(),
        capabilities = IdentityAccessStore.Capabilities
    });

    private static async Task<IResult> SaveTeamAsync(
        AccessTeamRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(new { ok = true, team = store.SaveTeam(request) }));

    private static async Task<IResult> DeleteTeamAsync(
        string id,
        HttpContext context,
        IAntiforgery antiforgery,
        IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => { store.DeleteTeam(id); return Results.NoContent(); });

    private static async Task<IResult> SavePolicyAsync(
        string portalId,
        PortalPolicyRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(new { ok = true, policy = store.SavePortalPolicy(portalId, request.Policy) }));

    private static IResult SimulateAccess(
        UiSimulationRequest request,
        IdentityAccessStore store,
        FilePortalRegistry portals)
    {
        var identity = store.Get(request.MemberKey);
        if (identity is null) return Results.NotFound(new { ok = false, error = "Identity was not found." });
        var result = portals.List().Select(portal =>
        {
            var effective = store.Effective(identity, portal.Id);
            return new
            {
                portal.Id,
                portal.Name,
                effective.Allowed,
                effective.Teams,
                effective.Capabilities
            };
        }).ToArray();
        return Results.Ok(new { ok = true, result });
    }

    private static IResult SecurityOverview(
        IdentityAccessStore identities,
        UiSecurityStateStore state,
        UiAuditReader audit)
    {
        var snapshot = state.Snapshot();
        return Results.Ok(new
        {
            ok = true,
            pendingRoles = identities.ListIdentities()
                .Where(value => value.Source == "entra" && value.Status == "pending" && value.RequestedRole is not null)
                .Select(value => new
                {
                    identityKey = value.Key["entra:".Length..],
                    value.UserName,
                    value.DisplayName,
                    value.RequestedRole
                }).ToArray(),
            sessions = Array.Empty<object>(),
            breakGlass = new
            {
                lastUsedAtUtc = (DateTimeOffset?)null,
                lastUsedIp = string.Empty,
                lastRotatedAtUtc = (DateTimeOffset?)null,
                reviewedAtUtc = snapshot.BreakGlassReviewedAtUtc,
                reviewedBy = snapshot.BreakGlassReviewedBy
            },
            policies = snapshot.Policies,
            audit = audit.Recent(250),
            incidents = snapshot.Incidents
        });
    }

    private static async Task<IResult> SaveSecurityPoliciesAsync(
        UiSecurityPolicyUpdate request,
        HttpContext context,
        IAntiforgery antiforgery,
        UiSecurityStateStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(new { ok = true, policies = store.SavePolicies(request) }));

    private static async Task<IResult> ReviewBreakGlassAsync(
        HttpContext context,
        IAntiforgery antiforgery,
        UiSecurityStateStore store) =>
        await Mutate(context, antiforgery, () => { store.ReviewBreakGlass(context.User); return Results.Ok(new { ok = true }); });

    private static async Task<IResult> CreateIncidentAsync(
        UiIncidentCreate request,
        HttpContext context,
        IAntiforgery antiforgery,
        UiSecurityStateStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(new { ok = true, incident = store.CreateIncident(request, context.User) }));

    private static async Task<IResult> UpdateIncidentAsync(
        string id,
        UiIncidentUpdate request,
        HttpContext context,
        IAntiforgery antiforgery,
        UiSecurityStateStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(new { ok = true, incident = store.UpdateIncident(id, request) }));

    private static async Task<IResult> RevokeSessionsAsync(HttpContext context, IAntiforgery antiforgery) =>
        await Mutate(context, antiforgery, () => Results.Ok(new { ok = true, revoked = 0 }));

    private static async Task<IResult> RevokeSessionAsync(string id, HttpContext context, IAntiforgery antiforgery) =>
        await Mutate(context, antiforgery, () => Results.NotFound(new { ok = false, error = "Session was not found." }));

    private static object ToUiIdentity(ManagedIdentity value) => new
    {
        identityKey = value.Source == "entra" && value.Key.StartsWith("entra:", StringComparison.Ordinal)
            ? value.Key["entra:".Length..]
            : value.UserName,
        username = value.UserName,
        displayName = value.DisplayName,
        source = value.Source,
        role = value.Role,
        requestedRole = value.RequestedRole,
        status = value.Status,
        enabled = value.Enabled,
        createdAtUtc = value.CreatedAtUtc,
        updatedAtUtc = value.UpdatedAtUtc
    };

    private static async Task<IResult> Mutate(HttpContext context, IAntiforgery antiforgery, Func<IResult> action)
    {
        try
        {
            await antiforgery.ValidateRequestAsync(context);
            return action();
        }
        catch (AntiforgeryValidationException)
        {
            return Results.Json(new { ok = false, code = "CSRF_VALIDATION_FAILED", error = "CSRF validation failed." }, statusCode: 400);
        }
        catch (KeyNotFoundException exception)
        {
            return Results.Json(new { ok = false, error = exception.Message }, statusCode: 404);
        }
        catch (UnauthorizedAccessException exception)
        {
            return Results.Json(new { ok = false, error = exception.Message }, statusCode: 403);
        }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException or ArgumentException)
        {
            return Results.Json(new { ok = false, error = exception.Message }, statusCode: 409);
        }
    }
}
