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

internal static class CurrentUiEndpoints
{
    public static IEndpointRouteBuilder MapCurrentUiApi(this IEndpointRouteBuilder endpoints)
    {
        var portals = endpoints.MapGroup("/api/portals")
            .RequireAuthorization(SirkPolicies.PortalManagement);
        portals.MapGet("/", ListPortals);
        portals.MapPost("/", CreatePortalAsync);
        portals.MapPost("/{portalId}/connect", ConnectPortal);

        var users = endpoints.MapGroup("/api/settings/users")
            .RequireAuthorization(SirkPolicies.PortalManagement);
        users.MapGet("/", ListUsers);
        users.MapPost("/", CreateLocalUserAsync);
        users.MapPatch("/{source}/{*key}/role", ChangeUserRoleAsync);

        endpoints.MapGet("/api/settings/roles", ListRoles)
            .RequireAuthorization(SirkPolicies.PortalManagement);

        var entra = endpoints.MapGroup("/api/settings/identity-provider")
            .RequireAuthorization(SirkPolicies.SecurityAdministration);
        entra.MapGet("/", GetEntra);
        entra.MapPut("/", UpdateEntraAsync);
        entra.MapPost("/test", TestEntra);

        return endpoints;
    }

    private static IResult ListPortals(
        HttpContext context,
        FilePortalRegistry registry,
        PortalTelemetryStore telemetry,
        IOptions<PortalProtocolOptions> options)
    {
        NoStore(context);
        var now = DateTimeOffset.UtcNow;
        var offlineAfter = TimeSpan.FromSeconds(options.Value.OfflineAfterSeconds);
        var result = registry.List().Select(portal =>
        {
            var heartbeat = telemetry.Get(portal.Id);
            var online = heartbeat is not null && now - heartbeat.ReceivedAtUtc <= offlineAfter;
            return new
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
                    teams = Array.Empty<string>(),
                    capabilities = new Dictionary<string, string>
                    {
                        ["portal.connect"] = online ? "allow" : "deny"
                    }
                }
            };
        }).ToArray();

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
        IOptions<PortalProtocolOptions> options)
    {
        NoStore(context);
        var portal = registry.Get(portalId);
        var heartbeat = portal is null ? null : telemetry.Get(portal.Id);
        var online = heartbeat is not null &&
            DateTimeOffset.UtcNow - heartbeat.ReceivedAtUtc <=
            TimeSpan.FromSeconds(options.Value.OfflineAfterSeconds);

        if (!online || heartbeat is null ||
            !Uri.TryCreate(heartbeat.Metrics.PublicUrl, UriKind.Absolute, out var target) ||
            target.Scheme != Uri.UriSchemeHttps ||
            !string.IsNullOrEmpty(target.UserInfo))
        {
            return Results.Json(
                new { ok = false, code = "PORTAL_UNAVAILABLE", error = "Portal is offline or has no valid public URL." },
                statusCode: StatusCodes.Status409Conflict);
        }

        return Results.Ok(new { ok = true, url = target.AbsoluteUri });
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
        var users = store.ListIdentities()
            .Select(identity => new
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
            .OrderBy(identity => identity.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        return Results.Ok(new { ok = true, users });
    }

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

    private static string[] AssignableRolesFor(System.Security.Claims.ClaimsPrincipal user)
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
                new { ok = false, code = "USER_NOT_FOUND", error = exception.Message },
                statusCode: StatusCodes.Status404NotFound);
        }
        catch (UnauthorizedAccessException exception)
        {
            return Results.Json(
                new { ok = false, code = "ROLE_ASSIGNMENT_FORBIDDEN", error = exception.Message },
                statusCode: StatusCodes.Status403Forbidden);
        }
        catch (Exception exception) when (
            exception is InvalidDataException or
            InvalidOperationException)
        {
            return Results.Json(
                new { ok = false, code = "USER_VALIDATION_FAILED", error = exception.Message },
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
