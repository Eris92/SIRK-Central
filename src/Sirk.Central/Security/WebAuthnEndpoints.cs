using System.Security.Claims;
using System.Text;
using Fido2NetLib;
using Fido2NetLib.Objects;
using Microsoft.AspNetCore.Antiforgery;
using AssertionOptionsModel = Fido2NetLib.Objects.AssertionOptions;

namespace Sirk.Central.Security;

internal sealed record WebAuthnRegistrationOptionsRequest(string DisplayName);
internal sealed record WebAuthnRegistrationVerifyRequest(
    string CeremonyId,
    AuthenticatorAttestationRawResponse Response);
internal sealed record BreakGlassPasskeyBeginRequest(string TransactionToken);
internal sealed record BreakGlassPasskeyFinishRequest(
    string TransactionToken,
    string ChallengeId,
    AuthenticatorAssertionRawResponse Credential);

internal static class WebAuthnEndpoints
{
    public static IServiceCollection AddSirkWebAuthn(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var serverDomain = configuration["Sirk:WebAuthn:ServerDomain"] ?? "localhost";
        var serverName = configuration["Sirk:WebAuthn:ServerName"] ?? "SIRK Central";
        var origins = configuration.GetSection("Sirk:WebAuthn:Origins").Get<string[]>()
            ?? ["https://central.sirkportal.com"];
        services.AddFido2(options =>
        {
            options.ServerDomain = serverDomain;
            options.ServerName = serverName;
            options.Origins = origins.ToHashSet(StringComparer.Ordinal);
            options.TimestampDriftTolerance = 300000;
        });
        services.AddSingleton<WebAuthnCredentialStore>();
        services.AddSingleton<WebAuthnCeremonyStore>();
        return services;
    }

    public static IEndpointRouteBuilder MapSirkWebAuthn(this IEndpointRouteBuilder endpoints)
    {
        var authenticated = endpoints.MapGroup("/api/v1/webauthn")
            .RequireAuthorization(SirkPolicies.SecurityAdministration);
        authenticated.MapGet("/credentials", ListCredentials);
        authenticated.MapPost("/registration/options", RegistrationOptionsAsync);
        authenticated.MapPost("/registration/verify", RegistrationVerifyAsync);
        authenticated.MapDelete("/credentials/{credentialId}", RemoveCredentialAsync);

        // Password verification must precede every Break-Glass MFA ceremony.
        endpoints.MapPost("/api/login/mfa/passkey/begin", BeginPasswordBoundAssertion)
            .AllowAnonymous()
            .RequireRateLimiting(SecurityEndpointNames.BreakGlassLoginRateLimit)
            .DisableAntiforgery();
        endpoints.MapPost("/api/login/mfa/passkey/finish", FinishPasswordBoundAssertionAsync)
            .AllowAnonymous()
            .RequireRateLimiting(SecurityEndpointNames.BreakGlassLoginRateLimit)
            .DisableAntiforgery();

        // Read-only compatibility route for the existing MFA status card.
        endpoints.MapGet("/api/break-glass/passkeys", CompatibilityListCredentials)
            .RequireAuthorization(SirkPolicies.SecurityAdministration);

        return endpoints;
    }

    private static IResult ListCredentials(HttpContext context, WebAuthnCredentialStore store)
    {
        var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty;
        return Results.Ok(store.ListByUser(userId).Select(value => new
        {
            value.CredentialId,
            value.DisplayName,
            value.AaGuid,
            value.Transports,
            value.BackupEligible,
            value.BackedUp,
            value.RegisteredAtUtc,
            value.LastUsedAtUtc
        }));
    }

    private static IResult CompatibilityListCredentials(
        HttpContext context,
        WebAuthnCredentialStore store)
    {
        var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty;
        return Results.Ok(new
        {
            ok = true,
            passkeys = store.ListByUser(userId).Select(value => new
            {
                value.CredentialId,
                value.DisplayName,
                status = "active",
                value.Transports,
                createdAtUtc = value.RegisteredAtUtc,
                value.LastUsedAtUtc
            })
        });
    }

    private static async Task<IResult> RegistrationOptionsAsync(
        WebAuthnRegistrationOptionsRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        IFido2 fido2,
        WebAuthnCredentialStore store,
        WebAuthnCeremonyStore ceremonies)
    {
        if (!await ValidateCsrf(context, antiforgery)) return CsrfFailure();
        var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty;
        var userName = context.User.Identity?.Name ?? "breakglass";
        var user = new Fido2User
        {
            Id = WebAuthnCredentialStore.Decode(UserHandle(userId)),
            Name = userName,
            DisplayName = NormalizeDisplayName(request.DisplayName, userName)
        };
        var excluded = store.ListByUser(userId)
            .Select(value => new PublicKeyCredentialDescriptor(
                WebAuthnCredentialStore.Decode(value.CredentialId)))
            .ToList();
        var options = fido2.RequestNewCredential(new RequestNewCredentialParams
        {
            User = user,
            ExcludeCredentials = excluded,
            AuthenticatorSelection = new AuthenticatorSelection
            {
                ResidentKey = ResidentKeyRequirement.Preferred,
                UserVerification = UserVerificationRequirement.Required
            },
            AttestationPreference = AttestationConveyancePreference.Direct,
            Extensions = new AuthenticationExtensionsClientInputs { CredProps = true }
        });
        var ceremony = ceremonies.Create("registration", userId, options.ToJson());
        return Results.Ok(new
        {
            ceremonyId = ceremony.Id,
            expiresAtUtc = ceremony.ExpiresAtUtc,
            options
        });
    }

    private static async Task<IResult> RegistrationVerifyAsync(
        WebAuthnRegistrationVerifyRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        IFido2 fido2,
        WebAuthnCredentialStore store,
        WebAuthnCeremonyStore ceremonies,
        SecurityAuditLog audit)
    {
        if (!await ValidateCsrf(context, antiforgery)) return CsrfFailure();
        var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty;
        try
        {
            var options = CredentialCreateOptions.FromJson(
                ceremonies.Consume(request.CeremonyId, "registration", userId));
            IsCredentialIdUniqueToUserAsyncDelegate unique =
                (args, _) => Task.FromResult(!store.Exists(args.CredentialId));
            var result = await fido2.MakeNewCredentialAsync(new MakeNewCredentialParams
            {
                AttestationResponse = request.Response,
                OriginalOptions = options,
                IsCredentialIdUniqueToUserCallback = unique
            }, context.RequestAborted);
            var credential = store.Add(new WebAuthnCredential(
                WebAuthnCredentialStore.Base64Url(result.Id),
                userId,
                context.User.Identity?.Name ?? "breakglass",
                options.User.DisplayName,
                WebAuthnCredentialStore.Base64Url(result.PublicKey),
                result.SignCount,
                result.AttestationFormat,
                WebAuthnCredentialStore.Base64Url(result.User.Id),
                result.AaGuid.ToString("D"),
                result.Transports.Select(value => value.ToString().ToLowerInvariant()).ToArray(),
                result.IsBackupEligible,
                result.IsBackedUp,
                DateTimeOffset.UtcNow,
                null));
            WriteAudit(audit, context, "webauthn.register", credential.CredentialId, true);
            return Results.Ok(new { ok = true, credentialId = credential.CredentialId });
        }
        catch (Exception exception) when (
            exception is Fido2VerificationException or InvalidOperationException or
            UnauthorizedAccessException or FormatException)
        {
            WriteAudit(audit, context, "webauthn.register", string.Empty, false);
            return Results.Json(new
            {
                ok = false,
                code = "WEBAUTHN_REGISTRATION_FAILED",
                error = exception.Message
            }, statusCode: 400);
        }
    }

    private static IResult BeginPasswordBoundAssertion(
        BreakGlassPasskeyBeginRequest request,
        HttpContext context,
        BreakGlassLoginTransactionStore transactions,
        IFido2 fido2,
        WebAuthnCredentialStore store,
        WebAuthnCeremonyStore ceremonies)
    {
        var identity = transactions.Inspect(request.TransactionToken, context);
        if (identity is null)
            return Results.Json(new
            {
                ok = false,
                code = "MFA_TRANSACTION_INVALID",
                error = "MFA transaction is invalid or expired."
            }, statusCode: 401);

        var credentials = store.ListByUser(identity.Id);
        if (credentials.Count == 0)
            return Results.Json(new
            {
                ok = false,
                code = "WEBAUTHN_NOT_REGISTERED",
                error = "No active security key is registered."
            }, statusCode: 409);

        var allowed = credentials
            .Select(value => new PublicKeyCredentialDescriptor(
                WebAuthnCredentialStore.Decode(value.CredentialId)))
            .ToList();
        var options = fido2.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = allowed,
            UserVerification = UserVerificationRequirement.Required
        });
        var subject = TransactionSubject(identity.Id, request.TransactionToken);
        var ceremony = ceremonies.Create("password-bound-assertion", subject, options.ToJson());
        return Results.Ok(new
        {
            ok = true,
            challengeId = ceremony.Id,
            expiresAtUtc = ceremony.ExpiresAtUtc,
            publicKey = options,
            options
        });
    }

    private static async Task<IResult> FinishPasswordBoundAssertionAsync(
        BreakGlassPasskeyFinishRequest request,
        HttpContext context,
        BreakGlassLoginTransactionStore transactions,
        IFido2 fido2,
        WebAuthnCredentialStore store,
        WebAuthnCeremonyStore ceremonies,
        BreakGlassSessionService sessions,
        SecurityAuditLog audit)
    {
        var identity = transactions.Inspect(request.TransactionToken, context);
        if (identity is null)
            return Results.Json(new
            {
                ok = false,
                code = "MFA_TRANSACTION_INVALID",
                error = "MFA transaction is invalid or expired."
            }, statusCode: 401);

        try
        {
            var subject = TransactionSubject(identity.Id, request.TransactionToken);
            var options = AssertionOptionsModel.FromJson(
                ceremonies.Consume(request.ChallengeId, "password-bound-assertion", subject));
            var credential = store.Get(WebAuthnCredentialStore.Decode(request.Credential.Id))
                ?? throw new UnauthorizedAccessException("Unknown WebAuthn credential.");
            if (!string.Equals(credential.UserId, identity.Id, StringComparison.Ordinal))
                throw new UnauthorizedAccessException("WebAuthn credential owner mismatch.");
            IsUserHandleOwnerOfCredentialIdAsync owner =
                (args, _) => Task.FromResult(store.Owns(args.CredentialId, args.UserHandle));
            var result = await fido2.MakeAssertionAsync(new MakeAssertionParams
            {
                AssertionResponse = request.Credential,
                OriginalOptions = options,
                StoredPublicKey = WebAuthnCredentialStore.Decode(credential.PublicKey),
                StoredSignatureCounter = credential.SignatureCounter,
                IsUserHandleOwnerOfCredentialIdCallback = owner
            }, context.RequestAborted);

            var consumedIdentity = transactions.Consume(request.TransactionToken, context);
            if (consumedIdentity is null ||
                !string.Equals(consumedIdentity.Id, identity.Id, StringComparison.Ordinal))
                throw new UnauthorizedAccessException("MFA transaction is invalid or already used.");

            store.UpdateCounter(result.CredentialId, result.SignCount, result.IsBackedUp);
            var expiresAt = await sessions.SignInAsync(context, consumedIdentity, "webauthn");
            WriteAudit(audit, context, "authentication.break-glass.mfa-success", credential.CredentialId, true);
            return Results.Ok(new
            {
                ok = true,
                authenticated = true,
                mfaRequired = false,
                method = "passkey",
                expiresAtUtc = expiresAt
            });
        }
        catch (Exception exception) when (
            exception is Fido2VerificationException or InvalidOperationException or
            UnauthorizedAccessException or FormatException)
        {
            WriteAudit(audit, context, "authentication.break-glass.mfa-failure", string.Empty, false);
            return Results.Json(new
            {
                ok = false,
                code = "WEBAUTHN_AUTHENTICATION_FAILED",
                error = exception.Message
            }, statusCode: 401);
        }
    }

    private static async Task<IResult> RemoveCredentialAsync(
        string credentialId,
        HttpContext context,
        IAntiforgery antiforgery,
        WebAuthnCredentialStore store,
        BreakGlassRecoveryCodeStore recoveryCodes,
        SecurityAuditLog audit)
    {
        if (!await ValidateCsrf(context, antiforgery)) return CsrfFailure();
        try
        {
            var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty;
            if (store.ListByUser(userId).Count <= 1 && !recoveryCodes.IsConfigured(userId))
            {
                return Results.Json(new
                {
                    ok = false,
                    code = "LAST_MFA_METHOD",
                    error = "Generate recovery codes before removing the final security key."
                }, statusCode: 409);
            }
            store.Remove(credentialId, userId);
            WriteAudit(audit, context, "webauthn.remove", credentialId, true);
            return Results.Ok(new { ok = true });
        }
        catch (Exception exception) when (
            exception is KeyNotFoundException or UnauthorizedAccessException)
        {
            return Results.Json(new { ok = false, error = exception.Message }, statusCode: 404);
        }
    }

    private static string TransactionSubject(string userId, string transactionToken)
    {
        var digest = WebAuthnCredentialStore.Base64Url(
            SHA256.HashData(Encoding.UTF8.GetBytes(transactionToken ?? string.Empty)));
        return $"{userId}:{digest}";
    }

    private static string UserHandle(string userId) =>
        WebAuthnCredentialStore.Base64Url(
            SHA256.HashData(Encoding.UTF8.GetBytes(userId)));

    private static string NormalizeDisplayName(string? value, string fallback)
    {
        var result = (value ?? string.Empty).Trim();
        return result.Length is >= 1 and <= 120 ? result : fallback;
    }

    private static async Task<bool> ValidateCsrf(
        HttpContext context,
        IAntiforgery antiforgery)
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

    private static void WriteAudit(
        SecurityAuditLog audit,
        HttpContext context,
        string action,
        string target,
        bool success) =>
        audit.Write(new SecurityAuditEvent(
            context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "anonymous",
            context.User.Identity?.Name ?? "anonymous",
            action,
            "webauthn",
            target,
            success,
            AuthenticationEndpoints.RemoteAddress(context),
            context.TraceIdentifier));
}
