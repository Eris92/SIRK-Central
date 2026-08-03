using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.RateLimiting;
using Sirk.Central.Security;

namespace Sirk.Central.Access;

internal sealed record ManagedLocalLoginRequest(string UserName, string Password);

internal static class ManagedIdentityAuthentication
{
    public static IEndpointRouteBuilder MapManagedIdentityAuthentication(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/v1/auth/local/login", LoginAsync)
            .AllowAnonymous()
            .RequireRateLimiting(SecurityEndpointNames.BreakGlassLoginRateLimit)
            .DisableAntiforgery();
        return endpoints;
    }

    private static async Task<IResult> LoginAsync(
        ManagedLocalLoginRequest request,
        HttpContext context,
        IdentityAccessStore store,
        SecurityAuditLog audit)
    {
        context.Response.Headers.CacheControl = "no-store";
        var identity = store.AuthenticateLocal(request.UserName, request.Password);
        if (identity is null || identity.Role is null)
        {
            audit.Write(new SecurityAuditEvent(
                "anonymous",
                NormalizeAuditName(request.UserName),
                "authentication.local-managed",
                "session",
                string.Empty,
                false,
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                context.TraceIdentifier));
            return Results.Json(new { ok = false, code = "INVALID_CREDENTIALS" }, statusCode: 401);
        }

        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, identity.Key),
            new(ClaimTypes.Name, identity.DisplayName),
            new(ClaimTypes.Role, identity.Role),
            new("sirk:identity_source", "local-managed"),
            new("amr", "pwd"),
            new("sirk:expires_at_utc", DateTimeOffset.UtcNow.AddMinutes(30).ToString("O"))
        };
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, SirkAuthenticationSchemes.Session));
        await context.SignInAsync(
            SirkAuthenticationSchemes.Session,
            principal,
            new AuthenticationProperties
            {
                IsPersistent = false,
                AllowRefresh = false,
                ExpiresUtc = DateTimeOffset.UtcNow.AddMinutes(30)
            });

        audit.Write(new SecurityAuditEvent(
            identity.Key,
            identity.DisplayName,
            "authentication.local-managed",
            "session",
            identity.Key,
            true,
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            context.TraceIdentifier,
            new Dictionary<string, string> { ["role"] = identity.Role }));

        return Results.Ok(new
        {
            authenticated = true,
            userId = identity.Key,
            userName = identity.UserName,
            displayName = identity.DisplayName,
            role = identity.Role,
            authenticationMethod = "password"
        });
    }

    private static string NormalizeAuditName(string? value)
    {
        var result = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (result.Length > 64) result = result[..64];
        return new string(result.Where(character => !char.IsControl(character)).ToArray());
    }
}
