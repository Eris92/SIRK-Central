using System.Security.Claims;
using Fido2NetLib;
using Fido2NetLib.Objects;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using AssertionOptionsModel = Fido2NetLib.Objects.AssertionOptions;

namespace Sirk.Central.Security;

internal sealed record WebAuthnRegistrationOptionsRequest(string DisplayName);
internal sealed record WebAuthnRegistrationVerifyRequest(string CeremonyId, AuthenticatorAttestationRawResponse Response);
internal sealed record WebAuthnAssertionOptionsRequest(string UserName, string AccessCode);
internal sealed record WebAuthnAssertionVerifyRequest(string CeremonyId, string AccessCode, AuthenticatorAssertionRawResponse Response);

internal static class WebAuthnEndpoints
{
    public static IServiceCollection AddSirkWebAuthn(this IServiceCollection services, IConfiguration configuration)
    {
        var serverDomain = configuration["Sirk:WebAuthn:ServerDomain"] ?? "localhost";
        var serverName = configuration["Sirk:WebAuthn:ServerName"] ?? "SIRK Central";
        var origins = configuration.GetSection("Sirk:WebAuthn:Origins").Get<string[]>() ?? ["https://central.sirkportal.com"];
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
        var authenticated = endpoints.MapGroup("/api/v1/webauthn").RequireAuthorization(SirkPolicies.SecurityAdministration);
        authenticated.MapGet("/credentials", ListCredentials);
        authenticated.MapPost("/registration/options", RegistrationOptionsAsync);
        authenticated.MapPost("/registration/verify", RegistrationVerifyAsync);
        authenticated.MapDelete("/credentials/{credentialId}", RemoveCredentialAsync);
        endpoints.MapPost("/api/v1/break-glass/{accessCode}/webauthn/options", CreateAssertionOptions)
            .AllowAnonymous().RequireRateLimiting(SecurityEndpointNames.BreakGlassLoginRateLimit).DisableAntiforgery();
        endpoints.MapPost("/api/v1/break-glass/{accessCode}/webauthn/verify", AssertionVerifyAsync)
            .AllowAnonymous().RequireRateLimiting(SecurityEndpointNames.BreakGlassLoginRateLimit).DisableAntiforgery();
        return endpoints;
    }

    private static IResult ListCredentials(HttpContext context, WebAuthnCredentialStore store)
    {
        var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty;
        return Results.Ok(store.ListByUser(userId).Select(value => new
        {
            value.CredentialId, value.DisplayName, value.AaGuid, value.Transports,
            value.BackupEligible, value.BackedUp, value.RegisteredAtUtc, value.LastUsedAtUtc
        }));
    }

    private static async Task<IResult> RegistrationOptionsAsync(
        WebAuthnRegistrationOptionsRequest request, HttpContext context, IAntiforgery antiforgery,
        IFido2 fido2, WebAuthnCredentialStore store, WebAuthnCeremonyStore ceremonies)
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
            .Select(value => new PublicKeyCredentialDescriptor(WebAuthnCredentialStore.Decode(value.CredentialId))).ToList();
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
        return Results.Ok(new { ceremonyId = ceremony.Id, expiresAtUtc = ceremony.ExpiresAtUtc, options });
    }

    private static async Task<IResult> RegistrationVerifyAsync(
        WebAuthnRegistrationVerifyRequest request, HttpContext context, IAntiforgery antiforgery,
        IFido2 fido2, WebAuthnCredentialStore store, WebAuthnCeremonyStore ceremonies, SecurityAuditLog audit)
    {
        if (!await ValidateCsrf(context, antiforgery)) return CsrfFailure();
        var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty;
        try
        {
            var options = CredentialCreateOptions.FromJson(ceremonies.Consume(request.CeremonyId, "registration", userId));
            IsCredentialIdUniqueToUserAsyncDelegate unique = (args, _) => Task.FromResult(!store.Exists(args.CredentialId));
            var result = await fido2.MakeNewCredentialAsync(new MakeNewCredentialParams
            {
                AttestationResponse = request.Response,
                OriginalOptions = options,
                IsCredentialIdUniqueToUserCallback = unique
            }, context.RequestAborted);
            var credential = store.Add(new WebAuthnCredential(
                WebAuthnCredentialStore.Base64Url(result.Id), userId,
                context.User.Identity?.Name ?? "breakglass", options.User.DisplayName,
                WebAuthnCredentialStore.Base64Url(result.PublicKey), result.SignCount,
                result.AttestationFormat, WebAuthnCredentialStore.Base64Url(result.User.Id),
                result.AaGuid.ToString("D"), result.Transports.Select(value => value.ToString().ToLowerInvariant()).ToArray(),
                result.IsBackupEligible, result.IsBackedUp, DateTimeOffset.UtcNow, null));
            WriteAudit(audit, context, "webauthn.register", credential.CredentialId, true);
            return Results.Ok(new { ok = true, credentialId = credential.CredentialId });
        }
        catch (Exception exception) when (exception is Fido2VerificationException or InvalidOperationException or UnauthorizedAccessException or FormatException)
        {
            WriteAudit(audit, context, "webauthn.register", string.Empty, false);
            return Results.Json(new { ok = false, code = "WEBAUTHN_REGISTRATION_FAILED", error = exception.Message }, statusCode: 400);
        }
    }

    private static IResult CreateAssertionOptions(
        string accessCode, WebAuthnAssertionOptionsRequest request, LocalIdentityStore identities,
        IFido2 fido2, WebAuthnCredentialStore store, WebAuthnCeremonyStore ceremonies)
    {
        var identity = identities.GetBreakGlassIdentity();
        if (identity is null || !identities.VerifyAccessCode(accessCode) ||
            !string.Equals(identity.UserName, request.UserName?.Trim(), StringComparison.OrdinalIgnoreCase))
            return Results.Json(new { ok = false, code = "AUTHENTICATION_FAILED" }, statusCode: 401);
        var credentials = store.ListByUser(identity.Id);
        if (credentials.Count == 0)
            return Results.Json(new { ok = false, code = "WEBAUTHN_NOT_REGISTERED" }, statusCode: 409);
        var allowed = credentials.Select(value =>
            new PublicKeyCredentialDescriptor(WebAuthnCredentialStore.Decode(value.CredentialId))).ToList();
        var options = fido2.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = allowed,
            UserVerification = UserVerificationRequirement.Required
        });
        var ceremony = ceremonies.Create("assertion", identity.Id, options.ToJson());
        return Results.Ok(new { ceremonyId = ceremony.Id, expiresAtUtc = ceremony.ExpiresAtUtc, options });
    }

    private static async Task<IResult> AssertionVerifyAsync(
        string accessCode, WebAuthnAssertionVerifyRequest request, HttpContext context,
        LocalIdentityStore identities, IFido2 fido2, WebAuthnCredentialStore store,
        WebAuthnCeremonyStore ceremonies, SecurityAuditLog audit, IOptions<SecurityOptions> securityOptions)
    {
        var identity = identities.GetBreakGlassIdentity();
        if (identity is null || !identities.VerifyAccessCode(accessCode))
            return Results.Json(new { ok = false, code = "AUTHENTICATION_FAILED" }, statusCode: 401);
        try
        {
            var options = AssertionOptionsModel.FromJson(ceremonies.Consume(request.CeremonyId, "assertion", identity.Id));
            var credential = store.Get(WebAuthnCredentialStore.Decode(request.Response.Id))
                ?? throw new UnauthorizedAccessException("Unknown WebAuthn credential.");
            if (!string.Equals(credential.UserId, identity.Id, StringComparison.Ordinal))
                throw new UnauthorizedAccessException("WebAuthn credential owner mismatch.");
            IsUserHandleOwnerOfCredentialIdAsync owner = (args, _) =>
                Task.FromResult(store.Owns(args.CredentialId, args.UserHandle));
            var result = await fido2.MakeAssertionAsync(new MakeAssertionParams
            {
                AssertionResponse = request.Response,
                OriginalOptions = options,
                StoredPublicKey = WebAuthnCredentialStore.Decode(credential.PublicKey),
                StoredSignatureCounter = credential.SignatureCounter,
                IsUserHandleOwnerOfCredentialIdCallback = owner
            }, context.RequestAborted);
            store.UpdateCounter(result.CredentialId, result.Counter, result.IsBackedUp);
            var expiresAt = DateTimeOffset.UtcNow.AddMinutes(securityOptions.Value.SessionMinutes);
            var claims = new List<Claim>
            {
                new(ClaimTypes.NameIdentifier, identity.Id), new(ClaimTypes.Name, identity.UserName),
                new(ClaimTypes.Role, SirkRoles.BreakGlass), new("amr", "webauthn"),
                new("sirk:identity_source", "local-break-glass"), new("sirk:expires_at_utc", expiresAt.ToString("O"))
            };
            await context.SignInAsync(SirkAuthenticationSchemes.Session,
                new ClaimsPrincipal(new ClaimsIdentity(claims, SirkAuthenticationSchemes.Session, ClaimTypes.Name, ClaimTypes.Role)),
                new AuthenticationProperties { AllowRefresh = false, IsPersistent = false, ExpiresUtc = expiresAt });
            WriteAudit(audit, context, "authentication.webauthn", credential.CredentialId, true);
            return Results.Ok(new { ok = true, expiresAtUtc = expiresAt });
        }
        catch (Exception exception) when (exception is Fido2VerificationException or InvalidOperationException or UnauthorizedAccessException or FormatException)
        {
            WriteAudit(audit, context, "authentication.webauthn", string.Empty, false);
            return Results.Json(new { ok = false, code = "WEBAUTHN_AUTHENTICATION_FAILED", error = exception.Message }, statusCode: 401);
        }
    }

    private static async Task<IResult> RemoveCredentialAsync(
        string credentialId, HttpContext context, IAntiforgery antiforgery,
        WebAuthnCredentialStore store, SecurityAuditLog audit)
    {
        if (!await ValidateCsrf(context, antiforgery)) return CsrfFailure();
        try
        {
            var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? string.Empty;
            if (store.ListByUser(userId).Count <= 1)
                return Results.Json(new { ok = false, code = "LAST_WEBAUTHN_CREDENTIAL" }, statusCode: 409);
            store.Remove(credentialId, userId);
            WriteAudit(audit, context, "webauthn.remove", credentialId, true);
            return Results.Ok(new { ok = true });
        }
        catch (Exception exception) when (exception is KeyNotFoundException or UnauthorizedAccessException)
        {
            return Results.Json(new { ok = false, error = exception.Message }, statusCode: 404);
        }
    }

    private static string UserHandle(string userId) =>
        WebAuthnCredentialStore.Base64Url(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(userId)));
    private static string NormalizeDisplayName(string? value, string fallback)
    {
        var result = (value ?? string.Empty).Trim();
        return result.Length is >= 1 and <= 120 ? result : fallback;
    }
    private static async Task<bool> ValidateCsrf(HttpContext context, IAntiforgery antiforgery)
    {
        try { await antiforgery.ValidateRequestAsync(context); return true; }
        catch (AntiforgeryValidationException) { return false; }
    }
    private static IResult CsrfFailure() => Results.Json(new { ok = false, code = "CSRF_VALIDATION_FAILED" }, statusCode: 400);
    private static void WriteAudit(SecurityAuditLog audit, HttpContext context, string action, string target, bool success) =>
        audit.Write(new SecurityAuditEvent(
            context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "anonymous",
            context.User.Identity?.Name ?? "anonymous", action, "webauthn", target, success,
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown", context.TraceIdentifier));
}
