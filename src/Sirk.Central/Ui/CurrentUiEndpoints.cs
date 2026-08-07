using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Options;
using Sirk.Central.Access;
using Sirk.Central.Portals;
using Sirk.Central.Security;

namespace Sirk.Central.Ui;

internal sealed record UiPortalCreateRequest(string Id, string Name);

internal sealed record UiEntraSettingsUpdate(
    bool Enabled,
    string Tenant,
    string ClientId,
    string? ClientSecret,
    string? AllowedIdentities);

internal sealed record UiLocalUserCreateRequest(
    string UserName,
    string DisplayName,
    string Password,
    string Role);

internal sealed record UiRoleChangeRequest(string Role);
internal sealed record UiAccessSimulationRequest(string MemberKey);

internal static class CurrentUiEndpoints
{
    public static IEndpointRouteBuilder MapCurrentUiApi(this IEndpointRouteBuilder endpoints)
    {
        // Every authenticated identity may list the Portals it can see and connect
        // to them. Creating a Portal remains an administrative operation.
        var portals = endpoints.MapGroup("/api/portals")
            .RequireAuthorization();
        portals.MapGet("/", ListPortals);
        portals.MapPost("/{portalId}/connect", ConnectPortal);
        portals.MapPost("/", CreatePortalAsync)
            .RequireAuthorization(SirkPolicies.PortalManagement);

        var users = endpoints.MapGroup("/api/settings/users")
            .RequireAuthorization(SirkPolicies.PortalManagement);
        users.MapGet("/", ListUsers);
        users.MapPost("/", CreateLocalUserAsync);
        users.MapPatch("/{source}/{key}/role", ChangeUserRoleAsync);

        endpoints.MapGet("/api/settings/roles", ListRoles)
            .RequireAuthorization(SirkPolicies.PortalManagement);

        var entra = endpoints.MapGroup("/api/settings/identity-provider")
            .RequireAuthorization(SirkPolicies.SecurityAdministration);
        entra.MapGet("/", GetEntra);
        entra.MapPut("/", UpdateEntraAsync);
        entra.MapPost("/test", TestEntra);

        // Compatibility surface used by the current Permissions UI. The v1
        // access-control API remains canonical; these routes only adapt the
        // response and request shapes expected by public/app.js.
        var access = endpoints.MapGroup("/api/access-control")
            .RequireAuthorization(SirkPolicies.PortalManagement);
        access.MapGet("/", AccessSnapshot);
        access.MapPost("/teams", SaveTeamAsync);
        access.MapPut("/teams", SaveTeamAsync);
        access.MapDelete("/teams/{id}", DeleteTeamAsync);
        access.MapGet("/portals/{portalId}/policy", GetPortalPolicy);
        access.MapPut("/portals/{portalId}/policy", SavePortalPolicyAsync);
        access.MapPost("/simulate", SimulateAccessAsync);

        return endpoints;
    }

    private static IResult ListPortals(
        HttpContext context,
        FilePortalRegistry registry,
        PortalTelemetryStore telemetry,
        IOptions<PortalProtocolOptions> options,
        IdentityAccessStore accessStore)
    {
        NoStore(context);
        var now = DateTimeOffset.UtcNow;
        var offlineAfter = TimeSpan.FromSeconds(options.Value.OfflineAfterSeconds);
        var managementView = CanManagePortals(context.User);
        var result = new List<object>();

        foreach (var portal in registry.List())
        {
            var effective = ResolveEffectiveAccess(context.User, portal.Id, accessStore);
            if (!managementView && !effective.Allowed) continue;

            var heartbeat = telemetry.Get(portal.Id);
            var online = heartbeat is not null && now - heartbeat.ReceivedAtUtc <= offlineAfter;
            result.Add(new
            {
                portal.Id,
                portal.Name,
                status = online ? "online" : "offline",
                connected = online,
                publicUrl = heartbeat?.Metrics.PublicUrl ?? string.Empty,
                heartbeat = heartbeat is null ? null : new
                {
                    heartbeat.ReceivedAtUtc,
                    heartbeat.RemoteAddress,
                    heartbeat.Metrics.Health,
                    heartbeat.Metrics.PortalVersion,
                    heartbeat.Metrics.AgentCount,
                    heartbeat.Metrics.OnlineAgents,
                    heartbeat.Metrics.Capabilities
                },
                access = new
                {
                    teams = effective.Teams,
                    capabilities = effective.Capabilities
                }
            });
        }

        return Results.Ok(new { ok = true, portals = result });
    }

    private static async Task<IResult> CreatePortalAsync(
        UiPortalCreateRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        FilePortalRegistry registry)
    {
        NoStore(context);
        var csrf = await ValidateCsrfAsync(context, antiforgery);
        if (csrf is not null) return csrf;

        try
        {
            var issued = registry.Create(request.Id, request.Name);
            return Results.Created(
                $"/api/v1/admin/portals/{Uri.EscapeDataString(issued.Portal.Id)}",
                new
                {
                    ok = true,
                    portal = new
                    {
                        issued.Portal.Id,
                        issued.Portal.Name,
                        token = issued.Token
                    },
                    credential = new
                    {
                        portalId = issued.Portal.Id,
                        portalName = issued.Portal.Name,
                        portalToken = issued.Token,
                        shownOnce = true
                    }
                });
        }
        catch (PortalRegistryConflictException exception)
        {
            return Results.Json(
                new { ok = false, code = "PORTAL_ALREADY_EXISTS", error = exception.Message },
                statusCode: StatusCodes.Status409Conflict);
        }
        catch (ArgumentException exception)
        {
            return Results.Json(
                new { ok = false, code = "VALIDATION_FAILED", error = exception.Message },
                statusCode: StatusCodes.Status400BadRequest);
        }
    }

    private static IResult ConnectPortal(
        string portalId,
        HttpContext context,
        FilePortalRegistry registry,
        PortalTelemetryStore telemetry,
        IOptions<PortalProtocolOptions> options,
        IdentityAccessStore accessStore)
    {
        NoStore(context);
        var portal = registry.Get(portalId);
        if (portal is null)
        {
            return Results.Json(
                new { ok = false, code = "PORTAL_NOT_FOUND", error = "Portal was not found." },
                statusCode: StatusCodes.Status404NotFound);
        }

        var effective = ResolveEffectiveAccess(context.User, portal.Id, accessStore);
        var connectState = effective.Capabilities.GetValueOrDefault("portal.connect") ?? "deny";
        if (!effective.Allowed || connectState == "deny")
        {
            return Results.Json(
                new { ok = false, code = "PORTAL_ACCESS_DENIED", error = "Portal access denied by policy." },
                statusCode: StatusCodes.Status403Forbidden);
        }
        if (connectState == "approval")
        {
            return Results.Json(
                new { ok = false, code = "PORTAL_APPROVAL_REQUIRED", error = "Portal connection requires approval.", approvalRequired = true },
                statusCode: StatusCodes.Status409Conflict);
        }

        var heartbeat = telemetry.Get(portal.Id);
        var online = heartbeat is not null &&
            DateTimeOffset.UtcNow - heartbeat.ReceivedAtUtc <=
            TimeSpan.FromSeconds(options.Value.OfflineAfterSeconds);
        if (!online)
        {
            return Results.Json(
                new { ok = false, code = "PORTAL_UNAVAILABLE", error = "Portal is offline." },
                statusCode: StatusCodes.Status409Conflict);
        }

        // Stay inside Central. /connect/{id}/ is protected again by the tunnel
        // middleware, so this compatibility route cannot bypass effective access.
        return Results.Ok(new
        {
            ok = true,
            portalId = portal.Id,
            url = $"/connect/{Uri.EscapeDataString(portal.Id)}/"
        });
    }

    private static IResult ListRoles(HttpContext context)
    {
        NoStore(context);
        var roles = AssignableRolesFor(context.User);
        return Results.Ok(new { ok = true, roles });
    }

    private static IResult ListUsers(
        HttpContext context,
        IdentityAccessStore store)
    {
        NoStore(context);
        return Results.Ok(new { ok = true, users = UiUsers(store) });
    }

    private static object[] UiUsers(IdentityAccessStore store) =>
        store.ListIdentities()
            .Select(identity => (object)new
            {
                username = identity.UserName,
                identity.DisplayName,
                identity.Role,
                identity.Source,
                identityKey = identity.Key,
                identity.Status,
                identity.Enabled,
                identity.RequestedRole,
                identity.ClaimedRoles,
                identity.CreatedAtUtc,
                identity.UpdatedAtUtc,
                identity.ApprovedBy
            })
            .OrderBy(identity => ((dynamic)identity).DisplayName, StringComparer.OrdinalIgnoreCase)
            .ToArray();

    private static async Task<IResult> CreateLocalUserAsync(
        UiLocalUserCreateRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        IdentityAccessStore store)
    {
        NoStore(context);
        return await MutateAsync(
            context,
            antiforgery,
            () => Results.Ok(new
            {
                ok = true,
                user = store.CreateLocal(
                    new CreateLocalIdentityRequest(
                        request.UserName,
                        request.DisplayName,
                        request.Password,
                        request.Role),
                    context.User)
            }));
    }

    private static async Task<IResult> ChangeUserRoleAsync(
        string source,
        string key,
        UiRoleChangeRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        IdentityAccessStore store)
    {
        NoStore(context);
        return await MutateAsync(
            context,
            antiforgery,
            () =>
            {
                if (!source.Equals("local", StringComparison.OrdinalIgnoreCase))
                {
                    return Results.Json(
                        new
                        {
                            ok = false,
                            code = "ENTRA_ROLE_CLAIM_MANAGED",
                            error = "Microsoft Entra roles are managed through application-role claims and privileged-role approval."
                        },
                        statusCode: StatusCodes.Status409Conflict);
                }

                var decoded = Uri.UnescapeDataString(key);
                var identityKey = decoded.StartsWith("local:", StringComparison.OrdinalIgnoreCase)
                    ? decoded
                    : "local:" + decoded;
                var user = store.UpdateRole(
                    identityKey,
                    new ChangeRoleRequest(request.Role),
                    context.User);
                return Results.Ok(new { ok = true, user });
            });
    }

    private static string[] AssignableRolesFor(ClaimsPrincipal user)
    {
        if (user.IsInRole(SirkRoles.BreakGlass))
        {
            return
            [
                SirkRoles.Auditor,
                SirkRoles.OperatorL1,
                SirkRoles.SupportL2,
                SirkRoles.EngineerL3,
                SirkRoles.Admin,
                SirkRoles.SecAdmin
            ];
        }

        if (user.IsInRole(SirkRoles.SecAdmin))
            return [SirkRoles.SecAdmin];

        if (user.IsInRole(SirkRoles.Admin))
        {
            return
            [
                SirkRoles.Auditor,
                SirkRoles.OperatorL1,
                SirkRoles.SupportL2,
                SirkRoles.EngineerL3,
                SirkRoles.Admin
            ];
        }

        return [];
    }

    private static IResult AccessSnapshot(
        HttpContext context,
        IdentityAccessStore store,
        FilePortalRegistry registry)
    {
        NoStore(context);
        var portals = registry.List()
            .Select(portal => new { portal.Id, portal.Name })
            .OrderBy(portal => portal.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return Results.Ok(new
        {
            ok = true,
            users = UiUsers(store),
            portals,
            teams = store.ListTeams(),
            capabilities = IdentityAccessStore.Capabilities
        });
    }

    private static async Task<IResult> SaveTeamAsync(
        AccessTeamRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        IdentityAccessStore store)
    {
        NoStore(context);
        return await MutateAsync(
            context,
            antiforgery,
            () =>
            {
                var normalized = request with
                {
                    Members = request.Members?
                        .Select(NormalizeClassicMemberKey)
                        .ToArray()
                };
                return Results.Ok(new { ok = true, team = store.SaveTeam(normalized) });
            });
    }

    private static async Task<IResult> DeleteTeamAsync(
        string id,
        HttpContext context,
        IAntiforgery antiforgery,
        IdentityAccessStore store)
    {
        NoStore(context);
        return await MutateAsync(
            context,
            antiforgery,
            () =>
            {
                store.DeleteTeam(id);
                // The current UI always parses JSON, so return a body instead of 204.
                return Results.Ok(new { ok = true });
            });
    }

    private static IResult GetPortalPolicy(
        string portalId,
        HttpContext context,
        IdentityAccessStore store)
    {
        NoStore(context);
        return Results.Ok(new { ok = true, policy = store.PortalPolicy(portalId) });
    }

    private static async Task<IResult> SavePortalPolicyAsync(
        string portalId,
        PortalPolicyRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        IdentityAccessStore store)
    {
        NoStore(context);
        return await MutateAsync(
            context,
            antiforgery,
            () => Results.Ok(new
            {
                ok = true,
                policy = store.SavePortalPolicy(portalId, request.Policy)
            }));
    }

    private static async Task<IResult> SimulateAccessAsync(
        UiAccessSimulationRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        IdentityAccessStore store,
        FilePortalRegistry registry)
    {
        NoStore(context);
        return await MutateAsync(
            context,
            antiforgery,
            () =>
            {
                var key = NormalizeClassicMemberKey(request.MemberKey);
                var identity = store.Get(key)
                    ?? throw new KeyNotFoundException("Identity was not found.");
                var result = registry.List()
                    .Select(portal =>
                    {
                        var effective = store.Effective(identity, portal.Id);
                        return new
                        {
                            portal.Id,
                            portal.Name,
                            effective.Allowed,
                            teams = effective.Teams,
                            capabilities = effective.Capabilities
                        };
                    })
                    .OrderBy(portal => portal.Name, StringComparer.OrdinalIgnoreCase)
                    .ToArray();
                return Results.Ok(new { ok = true, result });
            });
    }

    private static string NormalizeClassicMemberKey(string value)
    {
        var key = (value ?? string.Empty).Trim().ToLowerInvariant();
        const string localDuplicate = "local:local:";
        const string entraDuplicate = "entra:entra:";
        if (key.StartsWith(localDuplicate, StringComparison.Ordinal))
            return "local:" + key[localDuplicate.Length..];
        if (key.StartsWith(entraDuplicate, StringComparison.Ordinal))
            return "entra:" + key[entraDuplicate.Length..];
        return key;
    }

    private static EffectiveAccess ResolveEffectiveAccess(
        ClaimsPrincipal actor,
        string portalId,
        IdentityAccessStore store)
    {
        if (actor.IsInRole(SirkRoles.BreakGlass))
        {
            return new EffectiveAccess(
                true,
                ["Break-Glass"],
                IdentityAccessStore.Capabilities.ToDictionary(
                    capability => capability,
                    _ => "allow",
                    StringComparer.Ordinal));
        }

        var key = actor.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrWhiteSpace(key)) return DeniedAccess();
        ManagedIdentity? identity;
        try { identity = store.Get(key); }
        catch (InvalidDataException) { identity = null; }
        return identity is null ? DeniedAccess() : store.Effective(identity, portalId);
    }

    private static EffectiveAccess DeniedAccess() => new(
        false,
        [],
        IdentityAccessStore.Capabilities.ToDictionary(
            capability => capability,
            _ => "deny",
            StringComparer.Ordinal));

    private static bool CanManagePortals(ClaimsPrincipal actor) =>
        actor.IsInRole(SirkRoles.BreakGlass) ||
        actor.IsInRole(SirkRoles.SecAdmin) ||
        actor.IsInRole(SirkRoles.Admin);

    private static IResult GetEntra(HttpContext context, EntraSettingsStore store)
    {
        NoStore(context);
        var provider = store.GetPublic();
        return Results.Ok(new
        {
            ok = true,
            provider = new
            {
                provider.Enabled,
                provider.Tenant,
                provider.ClientId,
                provider.ClientSecretConfigured,
                provider.AllowedIdentities,
                provider.RedirectUri,
                logoutUrl = provider.FrontChannelLogoutUri,
                provider.UpdatedAtUtc
            },
            editable = true,
            securityEditable = true
        });
    }

    private static async Task<IResult> UpdateEntraAsync(
        UiEntraSettingsUpdate request,
        HttpContext context,
        IAntiforgery antiforgery,
        EntraSettingsStore store)
    {
        NoStore(context);
        var csrf = await ValidateCsrfAsync(context, antiforgery);
        if (csrf is not null) return csrf;

        try
        {
            var allowed = (request.AllowedIdentities ?? string.Empty)
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            var origin = $"{context.Request.Scheme}://{context.Request.Host}";
            var result = store.Update(new EntraSettingsUpdate(
                request.Enabled,
                request.Tenant,
                request.ClientId,
                request.ClientSecret,
                allowed,
                origin));
            return Results.Ok(new { ok = true, provider = result });
        }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException)
        {
            return Results.Json(
                new { ok = false, code = "ENTRA_SETTINGS_INVALID", error = exception.Message },
                statusCode: StatusCodes.Status400BadRequest);
        }
    }

    private static IResult TestEntra(HttpContext context, EntraSettingsStore store)
    {
        NoStore(context);
        var value = store.GetPublic();
        if (string.IsNullOrWhiteSpace(value.ClientId))
        {
            return Results.Json(
                new { ok = false, code = "ENTRA_NOT_CONFIGURED", error = "Entra Client ID is not configured." },
                statusCode: StatusCodes.Status409Conflict);
        }

        var issuer = $"https://login.microsoftonline.com/{value.Tenant}/v2.0";
        return Results.Ok(new { ok = true, issuer, configured = value.ClientSecretConfigured });
    }

    private static async Task<IResult> MutateAsync(
        HttpContext context,
        IAntiforgery antiforgery,
        Func<IResult> action)
    {
        var csrf = await ValidateCsrfAsync(context, antiforgery);
        if (csrf is not null) return csrf;

        try
        {
            return action();
        }
        catch (KeyNotFoundException exception)
        {
            return Results.Json(
                new { ok = false, code = "RESOURCE_NOT_FOUND", error = exception.Message },
                statusCode: StatusCodes.Status404NotFound);
        }
        catch (UnauthorizedAccessException exception)
        {
            return Results.Json(
                new { ok = false, code = "ACCESS_FORBIDDEN", error = exception.Message },
                statusCode: StatusCodes.Status403Forbidden);
        }
        catch (Exception exception) when (
            exception is InvalidDataException or
            InvalidOperationException or
            ArgumentException)
        {
            return Results.Json(
                new { ok = false, code = "VALIDATION_FAILED", error = exception.Message },
                statusCode: StatusCodes.Status409Conflict);
        }
    }

    private static async Task<IResult?> ValidateCsrfAsync(
        HttpContext context,
        IAntiforgery antiforgery)
    {
        try
        {
            await antiforgery.ValidateRequestAsync(context);
            return null;
        }
        catch (AntiforgeryValidationException)
        {
            return Results.Json(
                new { ok = false, code = "CSRF_VALIDATION_FAILED", error = "CSRF validation failed." },
                statusCode: StatusCodes.Status400BadRequest);
        }
    }

    private static void NoStore(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Pragma = "no-cache";
    }
}
