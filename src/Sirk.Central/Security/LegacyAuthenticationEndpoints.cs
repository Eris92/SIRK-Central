using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;

namespace Sirk.Central.Security;

internal static class LegacyAuthenticationEndpoints
{
    public static IEndpointRouteBuilder MapLegacyAuthentication(
        this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/access", Access)
            .AllowAnonymous();

        endpoints.MapPost("/api/login", LoginAsync)
            .AllowAnonymous()
            .RequireRateLimiting(SecurityEndpointNames.BreakGlassLoginRateLimit)
            .DisableAntiforgery();

        endpoints.MapGet("/api/session", Session)
            .RequireAuthorization();

        endpoints.MapPost("/api/logout", LogoutAsync)
            .RequireAuthorization();

        return endpoints;
    }

    private static IResult Access(
        HttpContext context,
        LocalIdentityStore identityStore)
    {
        context.Response.Headers.CacheControl = "no-store";
        var accessCode = AuthenticationEndpoints.ReadBearerToken(context);
        return Results.Ok(new
        {
            localLoginEnabled = identityStore.VerifyAccessCode(accessCode),
            accessRequired = true
        });
    }

    private static Task<IResult> LoginAsync(
        BreakGlassLoginRequest request,
        HttpContext context,
        LocalIdentityStore identityStore,
        WebAuthnCredentialStore webAuthnCredentials,
        BreakGlassRecoveryCodeStore recoveryCodes,
        BreakGlassLoginTransactionStore transactions,
        BreakGlassSessionService sessions,
        SecurityAuditLog auditLog) =>
        AuthenticationEndpoints.LoginAsync(
            AuthenticationEndpoints.ReadBearerToken(context),
            request,
            context,
            identityStore,
            webAuthnCredentials,
            recoveryCodes,
            transactions,
            sessions,
            auditLog);

    private static IResult Session(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        var user = context.User;
        var roles = user.FindAll(ClaimTypes.Role)
            .Select(claim => claim.Value)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        return Results.Ok(new
        {
            authenticated = user.Identity?.IsAuthenticated == true,
            id = user.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty,
            name = user.Identity?.Name ?? string.Empty,
            role = roles.FirstOrDefault() ?? string.Empty,
            roles,
            authenticationMethod = user.FindFirstValue("sirk:identity_source") ?? string.Empty
        });
    }

    private static Task<IResult> LogoutAsync(
        HttpContext context,
        IAntiforgery antiforgery,
        SecurityAuditLog auditLog) =>
        AuthenticationEndpoints.LogoutAsync(context, antiforgery, auditLog);
}
