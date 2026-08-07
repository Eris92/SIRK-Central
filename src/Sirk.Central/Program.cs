using System.Reflection;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.RateLimiting;
using Sirk.Central;
using Sirk.Central.Access;
using Sirk.Central.Approvals;
using Sirk.Central.Backup;
using Sirk.Central.Demo;
using Sirk.Central.Operations;
using Sirk.Central.Organizations;
using Sirk.Central.Portals;
using Sirk.Central.Security;
using Sirk.Central.Tickets;
using Sirk.Central.Updates;

if (RuntimeHealthProbe.IsRequested(args))
{
    Environment.ExitCode = await RuntimeHealthProbe.RunAsync(args);
    return;
}

if (DemoOrchestratorHost.IsRequested(args))
{
    Environment.ExitCode = await DemoOrchestratorHost.RunAsync(args);
    return;
}

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    WebRootPath = "public"
});
builder.WebHost.ConfigureKestrel(options => options.AddServerHeader = false);

var securityOptions = builder.Configuration
    .GetSection(SecurityOptions.SectionName)
    .Get<SecurityOptions>() ?? new();

builder.Services.AddProblemDetails();
builder.Services.AddSingleton<RuntimeState>();
builder.Services.Configure<PortalProtocolOptions>(
    builder.Configuration.GetSection(PortalProtocolOptions.SectionName));
builder.Services.AddSingleton<FilePortalRegistry>();
builder.Services.AddSingleton<PortalNonceReplayGuard>();
builder.Services.AddSingleton<PortalRequestAuthenticator>();
builder.Services.AddSingleton<PortalTelemetryStore>();
builder.Services.Configure<SecurityOptions>(
    builder.Configuration.GetSection(SecurityOptions.SectionName));
builder.Services.AddSingleton<AgentUpdateTicketService>();
builder.Services.AddSingleton<PlatformUpdateCache>();
builder.Services.AddSingleton<HostUpdateControl>();
builder.Services.AddHttpClient("SirkUpdates", client =>
{
    client.Timeout = TimeSpan.FromMinutes(10);
});
builder.Services.AddSingleton<SingleWriterLease>();
builder.Services.AddSingleton<LocalIdentityStore>();
builder.Services.AddSingleton<BreakGlassLoginTransactionStore>();
builder.Services.AddSingleton<BreakGlassRecoveryCodeStore>();
builder.Services.AddSingleton<BreakGlassSessionService>();
builder.Services.AddSingleton<IdentityAccessStore>();
builder.Services.AddSingleton<SecurityAuditLog>();
builder.Services.AddSingleton<BackupKeyStore>();
builder.Services.AddSingleton<BackupArchiveService>();
builder.Services.AddSingleton<EntraSettingsStore>();
builder.Services.AddSingleton<ApprovalStore>();
builder.Services.AddSingleton<TicketStore>();
builder.Services.AddSingleton<TicketCommandStore>();
builder.Services.AddSingleton<OrganizationStore>();
builder.Services.AddSingleton<PortalAssignmentStore>();
builder.Services.AddSingleton<OperationsMiddleware>();
builder.Services.AddSingleton<PortalTunnelMiddleware>();
builder.Services.AddSirkWebAuthn(builder.Configuration);

ProductionSecurityGuards.ConfigureDataProtection(
    builder.Services,
    securityOptions,
    builder.Environment);

var secureCookies = !builder.Environment.IsDevelopment();
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = SirkAuthenticationSchemes.Session;
    options.DefaultChallengeScheme = SirkAuthenticationSchemes.Session;
    options.DefaultForbidScheme = SirkAuthenticationSchemes.Session;
    options.DefaultSignInScheme = SirkAuthenticationSchemes.Session;
    options.DefaultSignOutScheme = SirkAuthenticationSchemes.Session;
}).AddCookie(SirkAuthenticationSchemes.Session, options =>
{
    options.Cookie.Name = secureCookies
        ? "__Host-SIRK-Central-Session"
        : "SIRK-Central-Session-Development";
    options.Cookie.HttpOnly = true;
    options.Cookie.IsEssential = true;
    options.Cookie.Path = "/";
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy = secureCookies
        ? CookieSecurePolicy.Always
        : CookieSecurePolicy.SameAsRequest;
    options.ExpireTimeSpan = TimeSpan.FromMinutes(securityOptions.SessionMinutes);
    options.SlidingExpiration = false;
    options.Events = new CookieAuthenticationEvents
    {
        OnRedirectToLogin = context =>
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        },
        OnRedirectToAccessDenied = context =>
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        },
        OnValidatePrincipal = context =>
        {
            var source = context.Principal?.FindFirst("sirk:identity_source")?.Value;
            var currentId = context.Principal?
                .FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
            if (source == "local-break-glass")
            {
                var current = context.HttpContext.RequestServices
                    .GetRequiredService<LocalIdentityStore>()
                    .GetBreakGlassIdentity();
                if (current is null ||
                    !string.Equals(current.Id, currentId, StringComparison.Ordinal))
                    context.RejectPrincipal();
                return Task.CompletedTask;
            }
            if (source is "local-managed" or "entra")
            {
                var current = currentId is null
                    ? null
                    : context.HttpContext.RequestServices
                        .GetRequiredService<IdentityAccessStore>()
                        .Get(currentId);
                var role = context.Principal?
                    .FindFirst(System.Security.Claims.ClaimTypes.Role)?.Value;
                if (current is not { Enabled: true, Status: "active" } ||
                    string.IsNullOrWhiteSpace(current.Role) ||
                    !string.Equals(current.Role, role, StringComparison.Ordinal))
                    context.RejectPrincipal();
            }
            return Task.CompletedTask;
        }
    };
});
builder.Services.AddSirkEntraAuthentication();

builder.Services.AddAuthorizationBuilder()
    .AddPolicy(
        SirkPolicies.PortalManagement,
        policy => policy.RequireAuthenticatedUser()
            .RequireRole(SirkRoles.BreakGlass, SirkRoles.SecAdmin, SirkRoles.Admin))
    .AddPolicy(
        SirkPolicies.SecurityAdministration,
        policy => policy.RequireAuthenticatedUser()
            .RequireRole(SirkRoles.BreakGlass, SirkRoles.SecAdmin))
    .AddPolicy(
        SirkPolicies.AuditRead,
        policy => policy.RequireAuthenticatedUser()
            .RequireRole(SirkRoles.BreakGlass, SirkRoles.SecAdmin, SirkRoles.Auditor));

builder.Services.AddAntiforgery(options =>
{
    options.HeaderName = "X-SIRK-CSRF";
    options.Cookie.Name = secureCookies
        ? "__Host-SIRK-Central-CSRF"
        : "SIRK-Central-CSRF-Development";
    options.Cookie.HttpOnly = true;
    options.Cookie.IsEssential = true;
    options.Cookie.Path = "/";
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy = secureCookies
        ? CookieSecurePolicy.Always
        : CookieSecurePolicy.SameAsRequest;
});

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy(
        SecurityEndpointNames.BreakGlassLoginRateLimit,
        context => RateLimitPartition.GetSlidingWindowLimiter(
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new SlidingWindowRateLimiterOptions
            {
                PermitLimit = Math.Clamp(
                    securityOptions.LoginAttemptsPerFiveMinutes,
                    1,
                    100),
                Window = TimeSpan.FromMinutes(5),
                SegmentsPerWindow = 5,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0,
                AutoReplenishment = true
            }));
});

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders =
        ForwardedHeaders.XForwardedFor |
        ForwardedHeaders.XForwardedHost |
        ForwardedHeaders.XForwardedProto;
    options.ForwardLimit = 1;
    if (builder.Configuration.GetValue<bool>("Sirk:ReverseProxy:TrustAll"))
    {
        options.KnownIPNetworks.Clear();
        options.KnownProxies.Clear();
    }
});

var app = builder.Build();
var runtimeState = app.Services.GetRequiredService<RuntimeState>();
_ = app.Services.GetRequiredService<FilePortalRegistry>();
if (securityOptions.Enabled)
{
    _ = app.Services.GetRequiredService<SingleWriterLease>();
    _ = app.Services.GetRequiredService<LocalIdentityStore>();
    _ = app.Services.GetRequiredService<BreakGlassLoginTransactionStore>();
    _ = app.Services.GetRequiredService<BreakGlassRecoveryCodeStore>();
    _ = app.Services.GetRequiredService<BreakGlassSessionService>();
    _ = app.Services.GetRequiredService<IdentityAccessStore>();
    _ = app.Services.GetRequiredService<BackupKeyStore>();
    _ = app.Services.GetRequiredService<BackupArchiveService>();
    _ = app.Services.GetRequiredService<EntraSettingsStore>();
    _ = app.Services.GetRequiredService<ApprovalStore>();
    _ = app.Services.GetRequiredService<TicketStore>();
    _ = app.Services.GetRequiredService<TicketCommandStore>();
    _ = app.Services.GetRequiredService<OrganizationStore>();
    _ = app.Services.GetRequiredService<PortalAssignmentStore>();
    _ = app.Services.GetRequiredService<WebAuthnCredentialStore>();
    _ = app.Services.GetRequiredService<WebAuthnCeremonyStore>();
    _ = app.Services.GetRequiredService<SecurityAuditLog>().VerifyIntegrity();
}

app.UseForwardedHeaders();
if (!app.Environment.IsDevelopment()) app.UseHsts();
app.Use(async (context, next) =>
{
    context.Response.OnStarting(() =>
    {
        context.Response.Headers.TryAdd("X-Content-Type-Options", "nosniff");
        context.Response.Headers.TryAdd("X-Frame-Options", "DENY");
        context.Response.Headers.TryAdd("Referrer-Policy", "no-referrer");
        context.Response.Headers.TryAdd(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
        context.Response.Headers.TryAdd("Cross-Origin-Opener-Policy", "same-origin");
        context.Response.Headers.TryAdd("Cross-Origin-Resource-Policy", "same-origin");
        if (context.Request.Path.StartsWithSegments("/api") ||
            context.Request.Path.Value?.EndsWith(".js", StringComparison.OrdinalIgnoreCase) == true ||
            context.Request.Path.Value?.EndsWith(".html", StringComparison.OrdinalIgnoreCase) == true)
            context.Response.Headers.CacheControl = "no-store";
        return Task.CompletedTask;
    });
    await next();
});
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();
if (securityOptions.Enabled)
{
    var operations = app.Services.GetRequiredService<OperationsMiddleware>();
    var tunnel = app.Services.GetRequiredService<PortalTunnelMiddleware>();
    app.Use(async (context, next) =>
    {
        if (await operations.TryHandleAsync(context) ||
            await tunnel.TryHandleAsync(context))
            return;
        await next();
    });
}
app.UseStaticFiles();

app.MapGet("/", () => Results.Redirect("/workspace.html", permanent: false));
app.MapGet("/healthz", () => Results.Ok(new
{
    status = "healthy",
    service = "sirk-central",
    utc = DateTimeOffset.UtcNow
}));
app.MapGet("/readyz", () => runtimeState.IsReady
    ? Results.Ok(new
    {
        status = "ready",
        service = "sirk-central",
        utc = DateTimeOffset.UtcNow
    })
    : Results.Json(new
    {
        status = "starting",
        service = "sirk-central",
        utc = DateTimeOffset.UtcNow
    }, statusCode: StatusCodes.Status503ServiceUnavailable));
app.MapGet("/api/v1/system/version", () => Results.Ok(new
{
    product = "SIRK Central",
    runtime = ".NET 10",
    framework = AppContext.TargetFrameworkName,
    version = VersionInfo.Current,
    environment = app.Environment.EnvironmentName,
    securityEnabled = securityOptions.Enabled
}));

app.MapPortalProtocol();
AgentUpdateDistributionEndpoints.Map(app);
PlatformUpdateDistributionEndpoints.Map(app);
if (securityOptions.Enabled)
{
    app.MapSirkAuthentication();
    app.MapBreakGlassMfa();
    app.MapManagedIdentityAuthentication();
    app.MapSirkEntraAuthentication();
    app.MapSirkWebAuthn();
    app.MapBackupKeyLifecycle();
    app.MapSirkBackup();
    app.MapEntraSettings();
    app.MapPortalManagement();
    app.MapPortalConnectionFiles();
    app.MapApprovals();
    app.MapTickets();
    app.MapTicketCommands();
    app.MapOrganizations();
    app.MapIdentityAccessV2();
}
app.MapFallback(() => Results.Problem(
    statusCode: StatusCodes.Status404NotFound,
    title: "Resource not found"));
app.Lifetime.ApplicationStarted.Register(runtimeState.MarkReady);
app.Lifetime.ApplicationStopping.Register(runtimeState.MarkStopping);
app.Run();

internal sealed class RuntimeState
{
    private int _ready;
    public bool IsReady => Volatile.Read(ref _ready) == 1;
    public void MarkReady() => Interlocked.Exchange(ref _ready, 1);
    public void MarkStopping() => Interlocked.Exchange(ref _ready, 0);
}

internal static class VersionInfo
{
    public static string Current { get; } = Resolve();

    private static string Resolve()
    {
        var assembly = Assembly.GetExecutingAssembly();
        return assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion
            ?? assembly.GetName().Version?.ToString()
            ?? "unknown";
    }
}
