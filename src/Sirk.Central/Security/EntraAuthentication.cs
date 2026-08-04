using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Sirk.Central.Access;

namespace Sirk.Central.Security;

internal static class EntraAuthentication
{
    public const string Scheme = "Sirk.Entra";

    private static readonly HashSet<string> SupportedRoles = new(StringComparer.Ordinal)
    {
        SirkRoles.SecAdmin,
        SirkRoles.Admin,
        SirkRoles.Auditor,
        SirkRoles.OperatorL1,
        SirkRoles.SupportL2,
        SirkRoles.EngineerL3
    };

    public static IServiceCollection AddSirkEntraAuthentication(this IServiceCollection services)
    {
        services.AddAuthentication()
            .AddOpenIdConnect(Scheme, options =>
            {
                options.SignInScheme = SirkAuthenticationSchemes.Session;
                options.ResponseType = OpenIdConnectResponseType.Code;
                options.UsePkce = true;
                options.SaveTokens = false;
                options.GetClaimsFromUserInfoEndpoint = false;
                options.MapInboundClaims = false;
                options.CallbackPath = "/auth/entra/callback";
                options.RemoteSignOutPath = "/auth/entra/frontchannel-logout";
                options.SignedOutRedirectUri = "/";
                options.Scope.Clear();
                options.Scope.Add("openid");
                options.Scope.Add("profile");
                options.Scope.Add("email");
                options.TokenValidationParameters.NameClaimType = "name";
                options.TokenValidationParameters.RoleClaimType = "roles";
                options.Events = CreateEvents();
            });

        services.AddOptions<OpenIdConnectOptions>(Scheme)
            .Configure<EntraSettingsStore>((options, store) =>
            {
                var settings = store.GetPrivate();
                var tenant = settings?.Tenant ?? "organizations";
                options.Authority = $"https://login.microsoftonline.com/{tenant}/v2.0";
                options.ClientId = settings?.ClientId ?? Guid.Empty.ToString("D");
                options.ClientSecret = settings is { Enabled: true }
                    ? store.GetClientSecret()
                    : "entra-disabled";
            });

        return services;
    }

    public static IEndpointRouteBuilder MapSirkEntraAuthentication(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/v1/auth/entra/login", LoginAsync)
            .AllowAnonymous();

        endpoints.MapGet("/api/v1/auth/entra/status", (EntraSettingsStore store) =>
        {
            var value = store.GetPublic();
            return Results.Ok(new
            {
                enabled = value.Enabled,
                configured = value.ClientSecretConfigured && !string.IsNullOrWhiteSpace(value.ClientId),
                redirectUri = value.RedirectUri
            });
        }).AllowAnonymous();

        endpoints.MapPost("/auth/entra/frontchannel-logout", FrontChannelLogoutAsync)
            .AllowAnonymous()
            .DisableAntiforgery();
        endpoints.MapGet("/auth/entra/frontchannel-logout", FrontChannelLogoutAsync)
            .AllowAnonymous();

        return endpoints;
    }

    private static async Task LoginAsync(
        HttpContext context,
        EntraSettingsStore store,
        string? returnUrl)
    {
        var settings = store.GetPublic();
        if (!settings.Enabled || !settings.ClientSecretConfigured || string.IsNullOrWhiteSpace(settings.ClientId))
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            await context.Response.WriteAsJsonAsync(new
            {
                ok = false,
                code = "ENTRA_NOT_CONFIGURED"
            });
            return;
        }

        var target = NormalizeReturnUrl(returnUrl);
        await context.ChallengeAsync(
            Scheme,
            new AuthenticationProperties
            {
                RedirectUri = target,
                IsPersistent = false,
                AllowRefresh = false
            });
    }

    private static async Task FrontChannelLogoutAsync(HttpContext context)
    {
        await context.SignOutAsync(SirkAuthenticationSchemes.Session);
        context.Response.StatusCode = StatusCodes.Status204NoContent;
    }

    private static OpenIdConnectEvents CreateEvents() => new()
    {
        OnRedirectToIdentityProvider = context =>
        {
            var store = context.HttpContext.RequestServices.GetRequiredService<EntraSettingsStore>();
            var settings = store.GetPrivate();
            if (settings is not { Enabled: true })
            {
                context.HandleResponse();
                context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
                return context.Response.WriteAsJsonAsync(new
                {
                    ok = false,
                    code = "ENTRA_NOT_CONFIGURED"
                });
            }

            context.ProtocolMessage.IssuerAddress =
                $"https://login.microsoftonline.com/{settings.Tenant}/oauth2/v2.0/authorize";
            context.ProtocolMessage.ClientId = settings.ClientId;
            return Task.CompletedTask;
        },
        OnAuthorizationCodeReceived = context =>
        {
            var store = context.HttpContext.RequestServices.GetRequiredService<EntraSettingsStore>();
            var settings = store.GetPrivate();
            if (settings is not { Enabled: true } || context.TokenEndpointRequest is null)
            {
                context.Fail("Entra configuration or token request is unavailable.");
                return Task.CompletedTask;
            }

            context.TokenEndpointRequest.ClientId = settings.ClientId;
            context.TokenEndpointRequest.ClientSecret = store.GetClientSecret();
            return Task.CompletedTask;
        },
        OnTokenValidated = context =>
        {
            if (context.Principal is not { Identity: ClaimsIdentity identity } principal)
            {
                context.Fail("Entra identity is missing.");
                return Task.CompletedTask;
            }

            var tenantId = principal.FindFirstValue("tid")?.ToLowerInvariant();
            var objectId = principal.FindFirstValue("oid")?.ToLowerInvariant();
            if (!Guid.TryParse(tenantId, out _) || !Guid.TryParse(objectId, out _))
            {
                context.Fail("Entra tenant or object identity is missing.");
                return Task.CompletedTask;
            }

            var settingsStore = context.HttpContext.RequestServices.GetRequiredService<EntraSettingsStore>();
            var settings = settingsStore.GetPrivate();
            if (settings is not { Enabled: true })
            {
                context.Fail("Entra configuration is disabled.");
                return Task.CompletedTask;
            }

            var identityKey = $"{tenantId}:{objectId}";
            if (settings.AllowedIdentities.Count > 0 &&
                !settings.AllowedIdentities.Contains(identityKey, StringComparer.Ordinal))
            {
                context.Fail("Entra identity is not allowed.");
                return Task.CompletedTask;
            }

            var claimedRoles = principal.FindAll("roles")
                .Select(claim => claim.Value)
                .Where(SupportedRoles.Contains)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (claimedRoles.Length == 0)
            {
                context.Fail("Entra identity has no supported SIRK application role.");
                return Task.CompletedTask;
            }

            var name = principal.FindFirstValue("preferred_username")
                       ?? principal.FindFirstValue("name")
                       ?? identityKey;
            var displayName = principal.FindFirstValue("name") ?? name;
            ManagedIdentity managed;
            try
            {
                managed = context.HttpContext.RequestServices
                    .GetRequiredService<IdentityAccessStore>()
                    .ResolveEntra(identityKey, name, displayName, claimedRoles);
            }
            catch (Exception exception) when (exception is InvalidDataException or UnauthorizedAccessException)
            {
                context.Fail(exception.Message);
                return Task.CompletedTask;
            }

            if (managed.Status == "conflict")
            {
                context.Fail("Entra identity has conflicting SIRK application roles.");
                return Task.CompletedTask;
            }
            if (managed.Status != "active" || string.IsNullOrWhiteSpace(managed.Role))
            {
                context.Fail("Entra privileged role is pending approval in SIRK Central.");
                return Task.CompletedTask;
            }

            foreach (var existing in identity.FindAll(ClaimTypes.Role).ToArray())
                identity.RemoveClaim(existing);
            identity.AddClaim(new Claim(ClaimTypes.Role, managed.Role));
            identity.AddClaim(new Claim(ClaimTypes.NameIdentifier, managed.Key));
            identity.AddClaim(new Claim(ClaimTypes.Name, managed.DisplayName));
            identity.AddClaim(new Claim("sirk:identity_source", "entra"));
            identity.AddClaim(new Claim("amr", "federated"));
            identity.AddClaim(new Claim(
                "sirk:expires_at_utc",
                DateTimeOffset.UtcNow.AddMinutes(30).ToString("O")));

            var audit = context.HttpContext.RequestServices.GetRequiredService<SecurityAuditLog>();
            audit.Write(new SecurityAuditEvent(
                managed.Key,
                managed.DisplayName,
                "authentication.entra",
                "session",
                managed.Key,
                true,
                context.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                context.HttpContext.TraceIdentifier,
                new Dictionary<string, string>
                {
                    ["tenant"] = tenantId!,
                    ["claimedRoles"] = string.Join(',', claimedRoles),
                    ["effectiveRole"] = managed.Role
                }));
            return Task.CompletedTask;
        },
        OnRemoteFailure = RenderRemoteFailureAsync
    };

    private static Task RenderRemoteFailureAsync(RemoteFailureContext context)
    {
        context.HandleResponse();

        var english = context.Request.Cookies.TryGetValue("sirk_lang", out var language) &&
                      string.Equals(language, "en", StringComparison.OrdinalIgnoreCase);
        var failure = ClassifyFailure(context.Failure?.Message, english);

        context.Response.StatusCode = failure.StatusCode;
        context.Response.ContentType = "text/html; charset=utf-8";
        context.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate, max-age=0";
        context.Response.Headers.Pragma = "no-cache";
        context.Response.Headers.Expires = "0";

        var html = $$"""
            <!doctype html>
            <html lang="{{(english ? "en" : "pl")}}">
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width,initial-scale=1">
              <meta name="robots" content="noindex,nofollow">
              <title>SIRK Central — {{failure.Title}}</title>
              <link rel="stylesheet" href="/styles.css">
              <style>
                .auth-failure-card { max-width: 460px; }
                .auth-failure-message { margin: 22px 0; padding: 16px 18px; border: 1px solid #a94755; border-radius: 12px; background: rgba(115,27,45,.24); color: #ffd5dc; line-height: 1.55; }
                .auth-failure-help { margin: 0 0 22px; color: #9eb1cf; line-height: 1.55; }
                .auth-failure-card .button { display: block; width: 100%; text-align: center; box-sizing: border-box; }
              </style>
            </head>
            <body>
              <main class="shell">
                <section class="login-card auth-failure-card">
                  <div class="mark">S</div>
                  <p class="eyebrow">SIRK Management Platform</p>
                  <h1>{{failure.Title}}</h1>
                  <div class="auth-failure-message" role="alert">{{failure.Message}}</div>
                  <p class="auth-failure-help">{{failure.Help}}</p>
                  <a class="button login-provider" href="/">{{(english ? "Back to sign-in" : "Wróć do logowania")}}</a>
                </section>
              </main>
            </body>
            </html>
            """;

        return context.Response.WriteAsync(html);
    }

    private static EntraFailurePage ClassifyFailure(string? message, bool english)
    {
        var value = message ?? string.Empty;
        if (value.Contains("pending approval", StringComparison.OrdinalIgnoreCase))
        {
            return english
                ? new EntraFailurePage(
                    "Account awaiting approval",
                    "Microsoft Entra sign-in succeeded, but the privileged SIRK role has not yet been approved.",
                    "Sign in with the Break-Glass account or ask a SecAdmin to approve the account in SIRK Central.",
                    StatusCodes.Status403Forbidden)
                : new EntraFailurePage(
                    "Konto oczekuje na zatwierdzenie",
                    "Logowanie Microsoft Entra zakończyło się poprawnie, ale uprzywilejowana rola SIRK nie została jeszcze zatwierdzona.",
                    "Zaloguj się kontem Break-Glass albo poproś SecAdmina o zatwierdzenie konta w SIRK Central.",
                    StatusCodes.Status403Forbidden);
        }

        if (value.Contains("no supported SIRK application role", StringComparison.OrdinalIgnoreCase))
        {
            return english
                ? new EntraFailurePage(
                    "No SIRK role assigned",
                    "The Microsoft Entra account does not have a supported SIRK application role.",
                    "Assign an appropriate application role in Entra and try again.",
                    StatusCodes.Status403Forbidden)
                : new EntraFailurePage(
                    "Brak przypisanej roli SIRK",
                    "Konto Microsoft Entra nie ma obsługiwanej roli aplikacyjnej SIRK.",
                    "Przypisz odpowiednią rolę aplikacyjną w Entra i ponów logowanie.",
                    StatusCodes.Status403Forbidden);
        }

        if (value.Contains("conflicting SIRK application roles", StringComparison.OrdinalIgnoreCase))
        {
            return english
                ? new EntraFailurePage(
                    "Conflicting SIRK roles",
                    "The account has mutually exclusive privileged SIRK roles.",
                    "Correct the application-role assignments in Entra before signing in again.",
                    StatusCodes.Status403Forbidden)
                : new EntraFailurePage(
                    "Konflikt ról SIRK",
                    "Konto ma wzajemnie wykluczające się uprzywilejowane role SIRK.",
                    "Popraw przypisania ról aplikacyjnych w Entra przed ponownym logowaniem.",
                    StatusCodes.Status403Forbidden);
        }

        if (value.Contains("identity is not allowed", StringComparison.OrdinalIgnoreCase))
        {
            return english
                ? new EntraFailurePage(
                    "Account is not allowed",
                    "This Microsoft Entra account is not on the SIRK Central allowlist.",
                    "Ask a SecAdmin to add the account or use another authorised identity.",
                    StatusCodes.Status403Forbidden)
                : new EntraFailurePage(
                    "Konto nie jest dozwolone",
                    "To konto Microsoft Entra nie znajduje się na liście dozwolonych kont SIRK Central.",
                    "Poproś SecAdmina o dodanie konta albo użyj innej uprawnionej tożsamości.",
                    StatusCodes.Status403Forbidden);
        }

        return english
            ? new EntraFailurePage(
                "Microsoft Entra sign-in failed",
                "SIRK Central could not complete Microsoft Entra authentication.",
                "Return to sign-in and try again. If the problem persists, contact a SIRK Central administrator.",
                StatusCodes.Status401Unauthorized)
            : new EntraFailurePage(
                "Logowanie Microsoft Entra nie powiodło się",
                "SIRK Central nie mógł zakończyć uwierzytelniania Microsoft Entra.",
                "Wróć do logowania i spróbuj ponownie. Jeśli problem nadal występuje, skontaktuj się z administratorem SIRK Central.",
                StatusCodes.Status401Unauthorized);
    }

    private static string NormalizeReturnUrl(string? returnUrl)
    {
        if (string.IsNullOrWhiteSpace(returnUrl)) return "/";
        if (!Uri.TryCreate(returnUrl, UriKind.Relative, out _) ||
            !returnUrl.StartsWith("/", StringComparison.Ordinal) ||
            returnUrl.StartsWith("//", StringComparison.Ordinal) ||
            returnUrl.Contains("\\", StringComparison.Ordinal))
            return "/";
        return returnUrl;
    }

    private sealed record EntraFailurePage(
        string Title,
        string Message,
        string Help,
        int StatusCode);
}
