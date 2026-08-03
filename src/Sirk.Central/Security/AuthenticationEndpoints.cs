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
            .DisableAntiforgery();

        endpoints.MapGet("/api/v1/auth/session", Session)
            .RequireAuthorization();

        endpoints.MapGet("/api/v1/auth/csrf", IssueCsrfToken)
            .RequireAuthorization();

        endpoints.MapPost("/api/v1/auth/logout", LogoutAsync)
            .RequireAuthorization();

        endpoints.MapGet("/api/access", ValidateAccess)
            .AllowAnonymous();

        endpoints.MapPost("/api/login", CompatibilityLoginAsync)
            .AllowAnonymous()
            .DisableAntiforgery();

        endpoints.MapGet("/api/session", CompatibilitySession)
            .RequireAuthorization();

        endpoints.MapPost("/api/logout", LogoutAsync)
            .RequireAuthorization();

        return endpoints;
    }

    private static IResult ValidateAccess(HttpContext context, LocalIdentityStore identityStore)
    {
        context.Response.Headers.CacheControl = "no-store";
        var accessCode = ReadBearerToken(context);
        if (string.IsNullOrWhiteSpace(accessCode) || !identityStore.VerifyAccessCode(accessCode))
            return Results.Json(new { ok = false, error = "Access link is invalid or expired." }, statusCode: 404);
        return Results.Ok(new { ok = true, localLoginEnabled = true });
    }

    private static Task<IResult> CompatibilityLoginAsync(
        BreakGlassLoginRequest request,
        HttpContext context,
        LocalIdentityStore identityStore,
        WebAuthnCredentialStore webAuthnCredentials,
        BreakGlassRecoveryCodeStore recoveryCodes,
        BreakGlassLoginTransactionStore transactions,
        BreakGlassSessionService sessions,
        SecurityAuditLog auditLog,
        IOptions<SecurityOptions> securityOptions) =>
        LoginCoreAsync(
            ReadBearerToken(context),
            request,
            context,
            identityStore,
            webAuthnCredentials,
            recoveryCodes,
            transactions,
            sessions,
            auditLog,
            securityOptions.Value,
            compatibilityResponse: true);

    private static Task<IResult> LoginAsync(
        string accessCode,
        BreakGlassLoginRequest request,
        HttpContext context,
        LocalIdentityStore identityStore,
        WebAuthnCredentialStore webAuthnCredentials,
        BreakGlassRecoveryCodeStore recoveryCodes,
        BreakGlassLoginTransactionStore transactions,
        BreakGlassSessionService sessions,
        SecurityAuditLog auditLog,
        IOptions<SecurityOptions> securityOptions) =>
        LoginCoreAsync(
            accessCode,
            request,
            context,
            identityStore,
            webAuthnCredentials,
            recoveryCodes,
            transactions,
            sessions,
            auditLog,
            securityOptions.Value,
            compatibilityResponse: false);

    private static async Task<IResult> LoginCoreAsync(
        string? accessCode,
        BreakGlassLoginRequest request,
        HttpContext context,
        LocalIdentityStore identityStore,
        WebAuthnCredentialStore webAuthnCredentials,
        BreakGlassRecoveryCodeStore recoveryCodes,
        BreakGlassLoginTransactionStore transactions,
        BreakGlassSessionService sessions,
        SecurityAuditLog auditLog,
        SecurityOptions securityOptions,
        bool compatibilityResponse)
    {
        context.Response.Headers.CacheControl = "no-store";
        var remoteAddress = RemoteAddress(context);
        var suppliedUserName = NormalizeAuditUserName(request.UserName);
        var throttle = FailedLoginThrottle.Check(
            remoteAddress,
            suppliedUserName,
            securityOptions.LoginAttemptsPerFiveMinutes);
        if (throttle.Blocked)
            return TooManyAttempts(context, throttle);

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
                new Dictionary<string, string> { ["reason"] = "identity-store-error" }));
            return Results.Problem(statusCode: 503, title: "Authentication service unavailable");
        }

        if (identity is null)
        {
            var failure = FailedLoginThrottle.RecordFailure(
                remoteAddress,
                suppliedUserName,
                securityOptions.LoginAttemptsPerFiveMinutes);
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
                    ["reason"] = "invalid-credentials",
                    ["remainingAttempts"] = failure.RemainingAttempts.ToString()
                }));
            await ApplyFailureDelayAsync(context.RequestAborted);
            if (failure.Blocked)
                return TooManyAttempts(context, failure);
            return Results.Json(
                new
                {
                    ok = false,
                    code = "AUTHENTICATION_FAILED",
                    error = "Authentication failed.",
                    remainingAttempts = failure.RemainingAttempts
                },
                statusCode: 401);
        }

        FailedLoginThrottle.Reset(remoteAddress, suppliedUserName);

        var methods = new List<string>(2);
        if (webAuthnCredentials.ListByUser(identity.Id).Count > 0) methods.Add("passkey");
        if (recoveryCodes.IsConfigured(identity.Id)) methods.Add("recovery-code");

        if (methods.Count > 0)
        {
            var transaction = transactions.Issue(identity, context);
            auditLog.Write(new SecurityAuditEvent(
                identity.Id,
                identity.UserName,
                "authentication.break-glass.password-verified",
                "login-transaction",
                identity.Id,
                true,
                remoteAddress,
                context.TraceIdentifier,
                new Dictionary<string, string>
                {
                    ["mfaRequired"] = "true",
                    ["methods"] = string.Join(',', methods),
                    ["expiresAtUtc"] = transaction.ExpiresAtUtc.ToString("O")
                }));
            return Results.Json(new
            {
                ok = true,
                authenticated = false,
                mfaRequired = true,
                methods,
                preferredMethod = methods.Contains("passkey", StringComparer.Ordinal) ? "passkey" : methods[0],
                transactionToken = transaction.Token,
                expiresAtUtc = transaction.ExpiresAtUtc
            }, statusCode: 202);
        }

        var expiresAt = await sessions.SignInAsync(context, identity, "pwd");
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
                ["expiresAtUtc"] = expiresAt.ToString("O"),
                ["mfaRequired"] = "false",
                ["mfaEnrollmentRecommended"] = "true"
            }));

        if (compatibilityResponse)
            return Results.Ok(BreakGlassSessionService.CompatibilityIdentity(identity, enrollmentRecommended: true));

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

    private static IResult TooManyAttempts(
        HttpContext context,
        FailedLoginThrottleResult throttle)
    {
        var retryAfterSeconds = Math.Max(1, (int)Math.Ceiling(throttle.RetryAfter.TotalSeconds));
        context.Response.Headers.RetryAfter = retryAfterSeconds.ToString();
        return Results.Json(
            new
            {
                ok = false,
                code = "LOGIN_RATE_LIMITED",
                error = "Too many failed login attempts.",
                retryAfterSeconds
            },
            statusCode: StatusCodes.Status429TooManyRequests);
    }

    private static IResult CompatibilitySession(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        if (context.User.Identity?.IsAuthenticated != true) return Results.Unauthorized();
        var identity = new LocalIdentity(
            context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty,
            context.User.Identity?.Name ?? string.Empty,
            context.User.FindAll(ClaimTypes.Role).Select(value => value.Value).ToArray());
        return Results.Ok(BreakGlassSessionService.CompatibilityIdentity(identity, enrollmentRecommended: false));
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
        DateTimeOffset? expiresAt = DateTimeOffset.TryParse(
            user.FindFirstValue("sirk:expires_at_utc"),
            out var parsedExpiry)
            ? parsedExpiry
            : null;

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
            return Results.Problem(statusCode: 503, title: "CSRF token could not be issued");
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
            return Results.Json(
                new { ok = false, code = "CSRF_VALIDATION_FAILED", error = "CSRF validation failed." },
                statusCode: 400);
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

    internal static string ReadBearerToken(HttpContext context)
    {
        var header = context.Request.Headers.Authorization.ToString();
        const string prefix = "Bearer ";
        return header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? header[prefix.Length..].Trim()
            : string.Empty;
    }

    internal static string RemoteAddress(HttpContext context)
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
            if (character is not (>= 'a' and <= 'z') and
                not (>= '0' and <= '9') and
                not '.' and
                not '_' and
                not '-')
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
