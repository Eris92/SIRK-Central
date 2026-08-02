using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Options;

namespace Sirk.Central.Security;

internal static class SirkAuthenticationSchemes
{
    public const string Session = "Sirk.Session";
}

internal static class SecurityEndpointNames
{
    public const string BreakGlassLoginRateLimit = "Sirk.BreakGlass.Login";
}

internal sealed record BreakGlassLoginRequest(
    string UserName,
    string Password);

internal sealed record AuthenticatedSessionResponse(
    bool Authenticated,
    string UserId,
    string UserName,
    IReadOnlyList<string> Roles,
    string AuthenticationMethod,
    DateTimeOffset? ExpiresAtUtc);

internal static class AuthenticationEndpoints
{
    public static IEndpointRouteBuilder MapSirkAuthentication(
        this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost(
                "/api/v1/break-glass/{accessCode}/login",
                LoginAsync)
            .AllowAnonymous()
            .RequireRateLimiting(SecurityEndpointNames.BreakGlassLoginRateLimit)
            .DisableAntiforgery();

        endpoints.MapGet(
                "/api/v1/auth/session",
                Session)
            .RequireAuthorization();

        endpoints.MapGet(
                "/api/v1/auth/csrf",
                IssueCsrfToken)
            .RequireAuthorization();

        endpoints.MapPost(
                "/api/v1/auth/logout",
                LogoutAsync)
            .RequireAuthorization();

        return endpoints;
    }

    private static async Task<IResult> LoginAsync(
        string accessCode,
        BreakGlassLoginRequest request,
        HttpContext context,
        LocalIdentityStore identityStore,
        SecurityAuditLog auditLog,
        IOptions<SecurityOptions> options)
    {
        context.Response.Headers.CacheControl = "no-store";
        var remoteAddress = RemoteAddress(context);
        var suppliedUserName = NormalizeAuditUserName(request.UserName);

        LocalIdentity? identity;
        try
        {
            identity = identityStore.Authenticate(
                request.UserName ?? string.Empty,
                request.Password ?? string.Empty,
                accessCode ?? string.Empty);
        }
        catch (Exception exception) when (exception is CryptographicException or InvalidDataException)
        {
            auditLog.Write(new SecurityAuditEvent(
                "anonymous",
                suppliedUserName,
                "authentication.break-glass",
                "session",
                string.Empty,
                false,
                remoteAddress,
                context.TraceIdentifier,
                new Dictionary<string, string>
                {
                    ["reason"] = "identity-store-error"
                }));
            return Results.Problem(
                statusCode: StatusCodes.Status503ServiceUnavailable,
                title: "Authentication service unavailable");
        }

        if (identity is null)
        {
            auditLog.Write(new SecurityAuditEvent(
                "anonymous",
                suppliedUserName,
                "authentication.break-glass",
                "session",
                string.Empty,
                false,
                remoteAddress,
                context.TraceIdentifier,
                new Dictionary<string, string>
                {
                    ["reason"] = "invalid-credentials"
                }));
            await ApplyFailureDelayAsync(context.RequestAborted);
            return Results.Json(
                new
                {
                    ok = false,
                    code = "AUTHENTICATION_FAILED",
                    error = "Authentication failed."
                },
                statusCode: StatusCodes.Status401Unauthorized);
        }

        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, identity.Id),
            new(ClaimTypes.Name, identity.UserName),
            new("amr", "pwd"),
            new("sirk:identity_source", "local-break-glass")
        };
        claims.AddRange(identity.Roles.Select(role => new Claim(ClaimTypes.Role, role)));

        var expiresAt = DateTimeOffset.UtcNow.AddMinutes(options.Value.SessionMinutes);
        var principal = new ClaimsPrincipal(
            new ClaimsIdentity(
                claims,
                SirkAuthenticationSchemes.Session,
                ClaimTypes.Name,
                ClaimTypes.Role));
        await context.SignInAsync(
            SirkAuthenticationSchemes.Session,
            principal,
            new AuthenticationProperties
            {
                AllowRefresh = false,
                IsPersistent = false,
                IssuedUtc = DateTimeOffset.UtcNow,
                ExpiresUtc = expiresAt
            });

        auditLog.Write(new SecurityAuditEvent(
            identity.Id,
            identity.UserName,
            "authentication.break-glass",
            "session",
            identity.Id,
            true,
            remoteAddress,
            context.TraceIdentifier,
            new Dictionary<string, string>
            {
                ["roles"] = string.Join(',', identity.Roles),
                ["expiresAtUtc"] = expiresAt.ToString("O")
            }));

        return Results.Ok(new
        {
            ok = true,
            user = new
            {
                id = identity.Id,
                name = identity.UserName,
                roles = identity.Roles
            },
            expiresAtUtc = expiresAt
        });
    }

    private static IResult Session(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        var user = context.User;
        var roles = user.FindAll(ClaimTypes.Role)
            .Select(claim => claim.Value)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        var expiresAt = context.Features
            .Get<Microsoft.AspNetCore.Authentication.Cookies.ICookieAuthenticationFeature>()
            ?.Properties?.ExpiresUtc;

        return Results.Ok(new AuthenticatedSessionResponse(
            user.Identity?.IsAuthenticated == true,
            user.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty,
            user.Identity?.Name ?? string.Empty,
            roles,
            user.FindFirstValue("sirk:identity_source") ?? string.Empty,
            expiresAt));
    }

    private static IResult IssueCsrfToken(
        HttpContext context,
        IAntiforgery antiforgery)
    {
        context.Response.Headers.CacheControl = "no-store";
        var tokens = antiforgery.GetAndStoreTokens(context);
        if (string.IsNullOrWhiteSpace(tokens.RequestToken))
        {
            return Results.Problem(
                statusCode: StatusCodes.Status503ServiceUnavailable,
                title: "CSRF token could not be issued");
        }

        return Results.Ok(new
        {
            headerName = tokens.HeaderName,
            requestToken = tokens.RequestToken
        });
    }

    private static async Task<IResult> LogoutAsync(
        HttpContext context,
        IAntiforgery antiforgery,
        SecurityAuditLog auditLog)
    {
        context.Response.Headers.CacheControl = "no-store";
        try
        {
            await antiforgery.ValidateRequestAsync(context);
        }
        catch (AntiforgeryValidationException)
        {
            return Results.Json(
                new
                {
                    ok = false,
                    code = "CSRF_VALIDATION_FAILED",
                    error = "CSRF validation failed."
                },
                statusCode: StatusCodes.Status400BadRequest);
        }

        var actorId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown";
        var actorName = context.User.Identity?.Name ?? "unknown";
        auditLog.Write(new SecurityAuditEvent(
            actorId,
            actorName,
            "authentication.logout",
            "session",
            actorId,
            true,
            RemoteAddress(context),
            context.TraceIdentifier));

        await context.SignOutAsync(SirkAuthenticationSchemes.Session);
        return Results.Ok(new { ok = true });
    }

    private static string RemoteAddress(HttpContext context) =>
        (context.Connection.RemoteIpAddress?.ToString() ?? "unknown")[..Math.Min(
            context.Connection.RemoteIpAddress?.ToString().Length ?? 7,
            128)];

    private static string NormalizeAuditUserName(string? value)
    {
        var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length is < 1 or > 64)
        {
            return "unknown";
        }

        foreach (var character in normalized)
        {
            if (character is not (>= 'a' and <= 'z') and
                not (>= '0' and <= '9') and
                not '.' and
                not '_' and
                not '-')
            {
                return "unknown";
            }
        }

        return normalized;
    }

    private static async Task ApplyFailureDelayAsync(CancellationToken cancellationToken)
    {
        var milliseconds = Random.Shared.Next(150, 351);
        try
        {
            await Task.Delay(milliseconds, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Request was aborted; authentication still fails closed.
        }
    }
}
