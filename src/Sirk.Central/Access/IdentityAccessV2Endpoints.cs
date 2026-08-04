using Microsoft.AspNetCore.Antiforgery;
using Sirk.Central.Security;

namespace Sirk.Central.Access;

internal static class IdentityAccessV2Endpoints
{
    public static IEndpointRouteBuilder MapIdentityAccessV2(this IEndpointRouteBuilder endpoints)
    {
        var users = endpoints.MapGroup("/api/v1/identities")
            .RequireAuthorization(SirkPolicies.SecurityAdministration);
        users.MapGet("/", (IdentityAccessStore store) => Results.Ok(store.ListIdentities()));
        users.MapPost("/local", CreateLocalAsync);
        users.MapPut("/{key}/role", ChangeRoleAsync);
        users.MapPut("/{key}/enabled/{enabled:bool}", SetEnabledAsync);
        users.MapPost("/{key}/entra-role", DecideEntraRoleAsync);

        var access = endpoints.MapGroup("/api/v1/access-control")
            .RequireAuthorization(SirkPolicies.PortalManagement);
        access.MapGet("/teams", (IdentityAccessStore store) => Results.Ok(store.ListTeams()));
        access.MapPut("/teams", SaveTeamAsync);
        access.MapDelete("/teams/{id}", DeleteTeamAsync);
        access.MapGet("/portals/{portalId}/policy", (string portalId, IdentityAccessStore store) => Results.Ok(store.PortalPolicy(portalId)));
        access.MapPut("/portals/{portalId}/policy", SavePortalPolicyAsync);
        access.MapGet("/effective/{identityKey}/{portalId}", Effective);

        // Compatibility contract for the current classic Security UI. The
        // canonical identity store and authorization rules remain the source
        // of truth; this only adapts response and route shapes used by the UI.
        var currentSecurity = endpoints.MapGroup("/api/security")
            .RequireAuthorization(SirkPolicies.SecurityAdministration);
        currentSecurity.MapGet("/overview", CurrentSecurityOverview);

        var currentEntraApprovals = endpoints.MapGroup("/api/settings/users/entra")
            .RequireAuthorization(SirkPolicies.SecurityAdministration);
        currentEntraApprovals.MapPost("/{key}/approve", ApproveEntraRoleAsync);
        currentEntraApprovals.MapPost("/{key}/reject", RejectEntraRoleAsync);

        return endpoints;
    }

    private static IResult CurrentSecurityOverview(
        HttpContext context,
        IdentityAccessStore store)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Pragma = "no-cache";

        var pendingRoles = store.ListIdentities()
            .Where(identity =>
                identity.Source == "entra" &&
                identity.Enabled &&
                identity.Status == "pending" &&
                !string.IsNullOrWhiteSpace(identity.RequestedRole))
            .Select(identity => new
            {
                identityKey = identity.Key,
                username = identity.UserName,
                identity.DisplayName,
                identity.RequestedRole,
                identity.ClaimedRoles,
                identity.CreatedAtUtc,
                identity.UpdatedAtUtc
            })
            .OrderBy(identity => identity.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        return Results.Ok(new
        {
            pendingRoles,
            sessions = Array.Empty<object>(),
            breakGlass = new
            {
                lastUsedAtUtc = (DateTimeOffset?)null,
                lastUsedIp = string.Empty,
                lastRotatedAtUtc = (DateTimeOffset?)null,
                reviewedAtUtc = (DateTimeOffset?)null,
                reviewedBy = string.Empty
            },
            policies = new
            {
                sessionHours = 8,
                requireReauthenticationForSensitiveActions = true,
                privilegedRoleApproval = true,
                alertOnBreakGlassUse = true,
                blockNewPortalConnections = false,
                emergencyMode = false
            },
            audit = Array.Empty<object>(),
            incidents = Array.Empty<object>()
        });
    }

    private static async Task<IResult> CreateLocalAsync(CreateLocalIdentityRequest request, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.CreateLocal(request, context.User)));

    private static async Task<IResult> ChangeRoleAsync(string key, ChangeRoleRequest request, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.UpdateRole(Uri.UnescapeDataString(key), request, context.User)));

    private static async Task<IResult> SetEnabledAsync(string key, bool enabled, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.SetEnabled(Uri.UnescapeDataString(key), enabled, context.User)));

    private static async Task<IResult> DecideEntraRoleAsync(string key, EntraRoleDecisionRequest request, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.DecideEntraRole(Uri.UnescapeDataString(key), request.Decision, context.User)));

    private static async Task<IResult> ApproveEntraRoleAsync(string key, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.DecideEntraRole(Uri.UnescapeDataString(key), "approve", context.User)));

    private static async Task<IResult> RejectEntraRoleAsync(string key, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.DecideEntraRole(Uri.UnescapeDataString(key), "reject", context.User)));

    private static async Task<IResult> SaveTeamAsync(AccessTeamRequest request, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.SaveTeam(request)));

    private static async Task<IResult> DeleteTeamAsync(string id, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => { store.DeleteTeam(id); return Results.NoContent(); });

    private static async Task<IResult> SavePortalPolicyAsync(string portalId, PortalPolicyRequest request, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.SavePortalPolicy(portalId, request.Policy)));

    private static IResult Effective(string identityKey, string portalId, IdentityAccessStore store)
    {
        var identity = store.Get(Uri.UnescapeDataString(identityKey));
        return identity is null ? Results.NotFound() : Results.Ok(store.Effective(identity, portalId));
    }

    private static async Task<IResult> Mutate(HttpContext context, IAntiforgery antiforgery, Func<IResult> action)
    {
        try
        {
            await antiforgery.ValidateRequestAsync(context);
            return action();
        }
        catch (AntiforgeryValidationException)
        {
            return Results.Json(new { ok = false, code = "CSRF_VALIDATION_FAILED" }, statusCode: 400);
        }
        catch (KeyNotFoundException exception)
        {
            return Results.Json(new { ok = false, error = exception.Message }, statusCode: 404);
        }
        catch (UnauthorizedAccessException exception)
        {
            return Results.Json(new { ok = false, error = exception.Message }, statusCode: 403);
        }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException)
        {
            return Results.Json(new { ok = false, error = exception.Message }, statusCode: 409);
        }
    }
}
