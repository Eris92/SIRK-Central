using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;

namespace Sirk.Central.Security;

internal sealed record BreakGlassRecoveryVerifyRequest(string TransactionToken, string RecoveryCode);
internal sealed record BreakGlassRecoveryRotateRequest(int Count = 10);

internal static class BreakGlassMfaEndpoints
{
    public static IEndpointRouteBuilder MapBreakGlassMfa(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/login/mfa/recovery", VerifyRecoveryCodeAsync)
            .AllowAnonymous()
            .RequireRateLimiting(SecurityEndpointNames.BreakGlassLoginRateLimit)
            .DisableAntiforgery();

        var canonical = endpoints.MapGroup("/api/v1/break-glass/mfa")
            .RequireAuthorization(policy => policy.RequireRole(SirkRoles.BreakGlass));
        canonical.MapGet("/status", Status);
        canonical.MapPost("/recovery-codes/rotate", RotateAsync);
        canonical.MapDelete("/recovery-codes", RevokeAsync);

        var compatibility = endpoints.MapGroup("/api/break-glass/mfa")
            .RequireAuthorization(policy => policy.RequireRole(SirkRoles.BreakGlass));
        compatibility.MapGet("/status", Status);
        compatibility.MapPost("/recovery-codes/rotate", RotateAsync);
        compatibility.MapDelete("/recovery-codes", RevokeAsync);

        return endpoints;
    }

    private static async Task<IResult> VerifyRecoveryCodeAsync(
        BreakGlassRecoveryVerifyRequest request,
        HttpContext context,
        LocalIdentityStore identityStore,
        BreakGlassLoginTransactionStore transactions,
        BreakGlassRecoveryCodeStore recoveryCodes,
        BreakGlassSessionService sessions,
        SecurityAuditLog auditLog)
    {
        context.Response.Headers.CacheControl = "no-store";
        var accessCode = AuthenticationEndpoints.ReadBearerToken(context);
        if (string.IsNullOrWhiteSpace(accessCode) || !identityStore.VerifyAccessCode(accessCode))
            return Results.Json(new { ok = false, code = "AUTHENTICATION_FAILED", error = "Authentication failed." }, statusCode: 401);

        var identity = transactions.Consume(request.TransactionToken, context);
        if (identity is null)
        {
            auditLog.Write(new SecurityAuditEvent(
                "anonymous",
                "unknown",
                "authentication.break-glass.mfa-transaction-rejected",
                "login-transaction",
                string.Empty,
                false,
                AuthenticationEndpoints.RemoteAddress(context),
                context.TraceIdentifier));
            return Results.Json(
                new { ok = false, code = "MFA_TRANSACTION_INVALID", error = "MFA transaction is invalid or expired." },
                statusCode: 401);
        }

        try
        {
            var remaining = recoveryCodes.VerifyAndConsume(identity.Id, request.RecoveryCode);
            var expiresAt = await sessions.SignInAsync(context, identity, "recovery-code");
            auditLog.Write(new SecurityAuditEvent(
                identity.Id,
                identity.UserName,
                "authentication.break-glass.mfa-success",
                "recovery-code",
                identity.Id,
                true,
                AuthenticationEndpoints.RemoteAddress(context),
                context.TraceIdentifier,
                new Dictionary<string, string>
                {
                    ["remaining"] = remaining.ToString(),
                    ["expiresAtUtc"] = expiresAt.ToString("O")
                }));
            return Results.Ok(new
            {
                ok = true,
                authenticated = true,
                mfaRequired = false,
                method = "recovery-code",
                recoveryCodesRemaining = remaining,
                expiresAtUtc = expiresAt
            });
        }
        catch (UnauthorizedAccessException)
        {
            auditLog.Write(new SecurityAuditEvent(
                identity.Id,
                identity.UserName,
                "authentication.break-glass.mfa-failure",
                "recovery-code",
                identity.Id,
                false,
                AuthenticationEndpoints.RemoteAddress(context),
                context.TraceIdentifier));
            return Results.Json(
                new { ok = false, code = "RECOVERY_CODE_INVALID", error = "Recovery code verification failed." },
                statusCode: 401);
        }
    }

    private static IResult Status(
        HttpContext context,
        BreakGlassRecoveryCodeStore recoveryCodes,
        WebAuthnCredentialStore credentials)
    {
        context.Response.Headers.CacheControl = "no-store";
        var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty;
        var recovery = recoveryCodes.Status(userId);
        var passkeyCount = credentials.ListByUser(userId).Count;
        return Results.Ok(new
        {
            ok = true,
            recoveryCodes = new
            {
                configured = recovery.Configured,
                remaining = recovery.Remaining,
                rotatedAtUtc = recovery.RotatedAtUtc,
                lastUsedAtUtc = recovery.LastUsedAtUtc,
                blockedUntilUtc = (DateTimeOffset?)null
            },
            passkeys = new
            {
                configured = passkeyCount > 0,
                active = passkeyCount
            }
        });
    }

    private static async Task<IResult> RotateAsync(
        BreakGlassRecoveryRotateRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        BreakGlassRecoveryCodeStore recoveryCodes,
        SecurityAuditLog auditLog)
    {
        if (!await ValidateCsrfAsync(context, antiforgery)) return CsrfFailure();
        var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty;
        var codes = recoveryCodes.Rotate(userId, request.Count);
        auditLog.Write(new SecurityAuditEvent(
            userId,
            context.User.Identity?.Name ?? "breakglass",
            "breakglass.recovery-codes.rotated",
            "recovery-codes",
            userId,
            true,
            AuthenticationEndpoints.RemoteAddress(context),
            context.TraceIdentifier,
            new Dictionary<string, string> { ["count"] = codes.Count.ToString() }));
        return Results.Ok(new { ok = true, codes, shownOnce = true });
    }

    private static async Task<IResult> RevokeAsync(
        HttpContext context,
        IAntiforgery antiforgery,
        BreakGlassRecoveryCodeStore recoveryCodes,
        WebAuthnCredentialStore credentials,
        SecurityAuditLog auditLog)
    {
        if (!await ValidateCsrfAsync(context, antiforgery)) return CsrfFailure();
        var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty;
        if (credentials.ListByUser(userId).Count == 0)
        {
            return Results.Json(new
            {
                ok = false,
                code = "LAST_MFA_METHOD",
                error = "Register a YubiKey or passkey before revoking the final recovery method."
            }, statusCode: 409);
        }
        var removed = recoveryCodes.Revoke(userId);
        auditLog.Write(new SecurityAuditEvent(
            userId,
            context.User.Identity?.Name ?? "breakglass",
            "breakglass.recovery-codes.revoked",
            "recovery-codes",
            userId,
            true,
            AuthenticationEndpoints.RemoteAddress(context),
            context.TraceIdentifier,
            new Dictionary<string, string> { ["removed"] = removed.ToString() }));
        return Results.Ok(new { ok = true, removed });
    }

    private static async Task<bool> ValidateCsrfAsync(HttpContext context, IAntiforgery antiforgery)
    {
        try
        {
            await antiforgery.ValidateRequestAsync(context);
            return true;
        }
        catch (AntiforgeryValidationException)
        {
            return false;
        }
    }

    private static IResult CsrfFailure() => Results.Json(
        new { ok = false, code = "CSRF_VALIDATION_FAILED", error = "CSRF validation failed." },
        statusCode: 400);
}
