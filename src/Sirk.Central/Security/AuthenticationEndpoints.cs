using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
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

internal sealed record BreakGlassLoginRequest(string UserName, string Password);

internal sealed record AuthenticatedSessionResponse(
    bool Authenticated,
    string UserId,
    string UserName,
    IReadOnlyList<string> Roles,
    string AuthenticationMethod,
    DateTimeOffset? ExpiresAtUtc);

internal static class AuthenticationEndpoints
{
    public static IEndpointRouteBuilder MapSirkAuthentication(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/v1/break-glass/{accessCode}/login", LoginAsync)
            .AllowAnonymous()
            .RequireRateLimiting(SecurityEndpointNames.BreakGlassLoginRateLimit)
            .DisableAntiforgery();

        endpoints.MapGet("/api/v1/auth/session", Session)
            .RequireAuthorization();

        endpoints.MapGet("/api/v1/auth/csrf", IssueCsrfToken)
            .RequireAuthorization();

        endpoints.MapPost("/api/v1/auth/logout", LogoutAsync)
            .RequireAuthorization();

        // Compatibility routes used by the current Central UI. These are kept
        // intentionally thin and delegate to the same hardened implementation.
        endpoints.MapGet("/api/access", ValidateAccessAsync)
            .AllowAnonymous()
            .RequireRateLimiting(SecurityEndpointNames.BreakGlassLoginRateLimit);

        endpoints.MapPost("/api/login", CompatibilityLoginAsync)
            .AllowAnonymous()
            .RequireRateLimiting(SecurityEndpointNames.BreakGlassLoginRateLimit)
            .DisableAntiforgery();

        endpoints.MapGet("/api/session", CompatibilitySession)
            .RequireAuthorization();

        endpoints.MapPost("/api/logout", LogoutAsync)
            .RequireAuthorization();

        return endpoints;
    }

    private static IResult ValidateAccessAsync(HttpContext context, LocalIdentityStore identityStore)
    {
        context.Response.Headers.CacheControl = "no-store";
        var accessCode = ReadBearerToken(context);
        if (string.IsNullOrWhiteSpace(accessCode) || !identityStore.VerifyAccessCode(accessCode))
        {
            return Results.Json(new { ok = false, error = "Access link is invalid or expired." }, statusCode: 404);
        }

        return Results.Ok(new { ok = true, localLoginEnabled = true });
    }

    private static Task<IResult> CompatibilityLoginAsync(
        BreakGlassLoginRequest request,
        HttpContext context,
        LocalIdentityStore identityStore,
        SecurityAuditLog auditLog,
        IOptions<SecurityOptions> options)
    {
        var accessCode = ReadBearerToken(context);
        return LoginCoreAsync(accessCode, request, context, identityStore, auditLog, options, compatibilityResponse: true);
    }

    private static Task<IResult> LoginAsync(
        string accessCode,
        BreakGlassLoginRequest request,
        HttpContext context,
        LocalIdentityStore identityStore,
        SecurityAuditLog auditLog,
        IOptions<SecurityOptions> options) =>
        LoginCoreAsync(accessCode, request, context, identityStore, auditLog, options, compatibilityResponse: false);

    private static async Task<IResult> LoginCoreAsync(
        string? accessCode,
        BreakGlassLoginRequest request,
        HttpContext context,
        LocalIdentityStore identityStore,
        SecurityAuditLog auditLog,
        IOptions<SecurityOptions> options,
        bool compatibilityResponse)
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
                "anonymous", suppliedUserName, "authentication.break-glass", "session", string.Empty,
                false, remoteAddress, context.TraceIdentifier,
                new Dictionary<string, string> { ["reason"] = "identity-store-error" }));
            return Results.Problem(statusCode: 503, title: "Authentication service unavailable");
        }

        if (identity is null)
        {
            auditLog.Write(new SecurityAuditEvent(
                "anonymous", suppliedUserName, "authentication.break-glass", "session", string.Empty,
                false, remoteAddress, context.TraceIdentifier,
                new Dictionary<string, string> { ["reason"] = "invalid-credentials" }));
            await ApplyFailureDelayAsync(context.RequestAborted);
            return Results.Json(new { ok = false, code = "AUTHENTICATION_FAILED", error = "Authentication failed." }, statusCode: 401);
        }

        // First login and accounts without enrolled MFA authenticate with the
        // verified access URL, username and password. MFA is only requested by
        // the dedicated WebAuthn flow after an authenticator has been enrolled.
        var expiresAt = DateTimeOffset.UtcNow.AddMinutes(options.Value.SessionMinutes);
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, identity.Id),
            new(ClaimTypes.Name, identity.UserName),
            new("amr", "pwd"),
            new("sirk:identity_source", "local-break-glass"),
            new("sirk:expires_at_utc", expiresAt.ToString("O"))
        };
        claims.AddRange(identity.Roles.Select(role => new Claim(ClaimTypes.Role, role)));

        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            claims, SirkAuthenticationSchemes.Session, ClaimTypes.Name, ClaimTypes.Role));

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
            identity.Id, identity.UserName, "authentication.break-glass", "session", identity.Id,
            true, remoteAddress, context.TraceIdentifier,
            new Dictionary<string, string>
            {
                ["roles"] = string.Join(',', identity.Roles),
                ["expiresAtUtc"] = expiresAt.ToString("O"),
                ["mfaRequired"] = "false"
            }));

        if (compatibilityResponse)
        {
            return Results.Ok(ToCompatibilityIdentity(identity));
        }

        return Results.Ok(new
        {
            ok = true,
            authenticated = true,
            mfaRequired = false,
            mfaEnrollmentRecommended = true,
            user = new { id = identity.Id, name = identity.UserName, roles = identity.Roles },
            expiresAtUtc = expiresAt
        });
    }

    private static IResult CompatibilitySession(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        if (context.User.Identity?.IsAuthenticated != true)
        {
            return Results.Unauthorized();
        }

        var roles = context.User.FindAll(ClaimTypes.Role).Select(x => x.Value).ToArray();
        var identity = new LocalIdentity(
            context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty,
            context.User.Identity?.Name ?? string.Empty,
            roles);
        return Results.Ok(ToCompatibilityIdentity(identity));
    }

    private static object ToCompatibilityIdentity(LocalIdentity identity)
    {
        var role = identity.Roles.FirstOrDefault() ?? string.Empty;
        return new
        {
            id = identity.Id,
            username = identity.UserName,
            displayName = identity.UserName,
            role,
            roles = identity.Roles,
            permissions = new[] { "*" },
            source = "local",
            builtIn = true,
            mfaRequired = false,
            mfaEnrollmentRecommended = true
        };
    }

    private static IResult Session(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        var user = context.User;
        var roles = user.FindAll(ClaimTypes.Role).Select(c => c.Value)
            .Distinct(StringComparer.Ordinal).OrderBy(v => v, StringComparer.Ordinal).ToArray();
        DateTimeOffset? expiresAt = DateTimeOffset.TryParse(
            user.FindFirstValue("sirk:expires_at_utc"), out var parsedExpiry) ? parsedExpiry : null;

        return Results.Ok(new AuthenticatedSessionResponse(
            user.Identity?.IsAuthenticated == true,
            user.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty,
            user.Identity?.Name ?? string.Empty,
            roles,
            user.FindFirstValue("sirk:identity_source") ?? string.Empty,
            expiresAt));
    }

    private static IResult IssueCsrfToken(HttpContext context, IAntiforgery antiforgery)
    {
        context.Response.Headers.CacheControl = "no-store";
        var tokens = antiforgery.GetAndStoreTokens(context);
        if (string.IsNullOrWhiteSpace(tokens.RequestToken))
        {
            return Results.Problem(statusCode: 503, title: "CSRF token could not be issued");
        }
        return Results.Ok(new { headerName = tokens.HeaderName, requestToken = tokens.RequestToken });
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
            return Results.Json(new { ok = false, code = "CSRF_VALIDATION_FAILED", error = "CSRF validation failed." }, statusCode: 400);
        }

        var actorId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown";
        var actorName = context.User.Identity?.Name ?? "unknown";
        auditLog.Write(new SecurityAuditEvent(
            actorId, actorName, "authentication.logout", "session", actorId,
            true, RemoteAddress(context), context.TraceIdentifier));

        await context.SignOutAsync(SirkAuthenticationSchemes.Session);
        return Results.Ok(new { ok = true });
    }

    private static string ReadBearerToken(HttpContext context)
    {
        var header = context.Request.Headers.Authorization.ToString();
        const string prefix = "Bearer ";
        return header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? header[prefix.Length..].Trim()
            : string.Empty;
    }

    private static string RemoteAddress(HttpContext context)
    {
        var address = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return address[..Math.Min(address.Length, 128)];
    }

    private static string NormalizeAuditUserName(string? value)
    {
        var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length is < 1 or > 64) return "unknown";
        foreach (var character in normalized)
        {
            if (character is not (>= 'a' and <= 'z') and not (>= '0' and <= '9') and not '.' and not '_' and not '-')
                return "unknown";
        }
        return normalized;
    }

    private static async Task ApplyFailureDelayAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(Random.Shared.Next(150, 351), cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }
}
