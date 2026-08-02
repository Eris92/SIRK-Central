using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

namespace Sirk.Central.Security;

internal static class EntraAuthentication
{
    public const string Scheme = "Sirk.Entra";

    private static readonly HashSet<string> SupportedRoles = new(StringComparer.Ordinal)
    {
        SirkRoles.SecAdmin,
        SirkRoles.Admin,
        SirkRoles.Auditor,
        SirkRoles.Operator
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
            if (settings is not { Enabled: true })
            {
                context.Fail("Entra configuration is disabled.");
                return Task.CompletedTask;
            }

            context.TokenEndpointRequest.ClientId = settings.ClientId;
            context.TokenEndpointRequest.ClientSecret = store.GetClientSecret();
            return Task.CompletedTask;
        },
        OnTokenValidated = context =>
        {
            var principal = context.Principal;
            var identity = principal?.Identity as ClaimsIdentity;
            if (identity is null)
            {
                context.Fail("Entra identity is missing.");
                return Task.CompletedTask;
            }

            var tenantId = principal!.FindFirstValue("tid")?.ToLowerInvariant();
            var objectId = principal.FindFirstValue("oid")?.ToLowerInvariant();
            if (!Guid.TryParse(tenantId, out _) || !Guid.TryParse(objectId, out _))
            {
                context.Fail("Entra tenant or object identity is missing.");
                return Task.CompletedTask;
            }

            var store = context.HttpContext.RequestServices.GetRequiredService<EntraSettingsStore>();
            var settings = store.GetPrivate();
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

            var roles = principal.FindAll("roles")
                .Select(claim => claim.Value)
                .Where(SupportedRoles.Contains)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (roles.Length == 0)
            {
                context.Fail("Entra identity has no supported SIRK application role.");
                return Task.CompletedTask;
            }

            foreach (var existing in identity.FindAll(ClaimTypes.Role).ToArray())
                identity.RemoveClaim(existing);
            foreach (var role in roles)
                identity.AddClaim(new Claim(ClaimTypes.Role, role));

            var name = principal.FindFirstValue("preferred_username")
                       ?? principal.FindFirstValue("name")
                       ?? identityKey;
            identity.AddClaim(new Claim(ClaimTypes.NameIdentifier, identityKey));
            identity.AddClaim(new Claim(ClaimTypes.Name, name));
            identity.AddClaim(new Claim("sirk:identity_source", "entra"));
            identity.AddClaim(new Claim("amr", "federated"));
            identity.AddClaim(new Claim(
                "sirk:expires_at_utc",
                DateTimeOffset.UtcNow.AddMinutes(30).ToString("O")));

            var audit = context.HttpContext.RequestServices.GetRequiredService<SecurityAuditLog>();
            audit.Write(new SecurityAuditEvent(
                identityKey,
                name,
                "authentication.entra",
                "session",
                identityKey,
                true,
                context.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                context.HttpContext.TraceIdentifier,
                new Dictionary<string, string>
                {
                    ["tenant"] = tenantId!,
                    ["roles"] = string.Join(',', roles)
                }));
            return Task.CompletedTask;
        },
        OnRemoteFailure = context =>
        {
            context.HandleResponse();
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return context.Response.WriteAsJsonAsync(new
            {
                ok = false,
                code = "ENTRA_AUTHENTICATION_FAILED"
            });
        }
    };

    private static string NormalizeReturnUrl(string? returnUrl)
    {
        if (string.IsNullOrWhiteSpace(returnUrl)) return "/";
        if (!Uri.TryCreate(returnUrl, UriKind.Relative, out _) ||
            !returnUrl.StartsWith('/', StringComparison.Ordinal) ||
            returnUrl.StartsWith("//", StringComparison.Ordinal) ||
            returnUrl.Contains('\\'))
            return "/";
        return returnUrl;
    }
}
