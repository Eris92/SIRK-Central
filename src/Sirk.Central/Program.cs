using System.Reflection;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.RateLimiting;
using Sirk.Central;
using Sirk.Central.Approvals;
using Sirk.Central.Backup;
using Sirk.Central.Portals;
using Sirk.Central.Security;
using Sirk.Central.Tickets;

if (RuntimeHealthProbe.IsRequested(args))
{
    Environment.ExitCode = await RuntimeHealthProbe.RunAsync(args);
    return;
}

var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = args, WebRootPath = "public" });
builder.WebHost.ConfigureKestrel(options => options.AddServerHeader = false);

var securityOptions = builder.Configuration.GetSection(SecurityOptions.SectionName).Get<SecurityOptions>() ?? new();
builder.Services.AddProblemDetails();
builder.Services.AddSingleton<RuntimeState>();
builder.Services.Configure<PortalProtocolOptions>(builder.Configuration.GetSection(PortalProtocolOptions.SectionName));
builder.Services.AddSingleton<FilePortalRegistry>();
builder.Services.AddSingleton<PortalNonceReplayGuard>();
builder.Services.AddSingleton<PortalRequestAuthenticator>();
builder.Services.AddSingleton<PortalTelemetryStore>();
builder.Services.Configure<SecurityOptions>(builder.Configuration.GetSection(SecurityOptions.SectionName));
builder.Services.AddSingleton<LocalIdentityStore>();
builder.Services.AddSingleton<SecurityAuditLog>();
builder.Services.AddSingleton<BackupKeyStore>();
builder.Services.AddSingleton<BackupArchiveService>();
builder.Services.AddSingleton<EntraSettingsStore>();
builder.Services.AddSingleton<ApprovalStore>();
builder.Services.AddSingleton<TicketStore>();
builder.Services.AddSingleton<TicketCommandStore>();
builder.Services.AddSirkWebAuthn(builder.Configuration);
builder.Services.AddTransient<IStartupFilter, WebAuthnUiStartupFilter>();

var dataProtection = builder.Services.AddDataProtection().SetApplicationName("SIRK Central .NET 10");
if (securityOptions.Enabled)
{
    var keyDirectory = Path.Combine(securityOptions.DataRoot, securityOptions.DataProtectionDirectoryName);
    Directory.CreateDirectory(keyDirectory);
    SecureDirectory(keyDirectory);
    dataProtection.PersistKeysToFileSystem(new DirectoryInfo(keyDirectory));
}

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
    options.Cookie.Name = secureCookies ? "__Host-SIRK-Central-Session" : "SIRK-Central-Session-Development";
    options.Cookie.HttpOnly = true;
    options.Cookie.IsEssential = true;
    options.Cookie.Path = "/";
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy = secureCookies ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;
    options.ExpireTimeSpan = TimeSpan.FromMinutes(securityOptions.SessionMinutes);
    options.SlidingExpiration = false;
    options.Events = new CookieAuthenticationEvents
    {
        OnRedirectToLogin = context => { context.Response.StatusCode = 401; return Task.CompletedTask; },
        OnRedirectToAccessDenied = context => { context.Response.StatusCode = 403; return Task.CompletedTask; },
        OnValidatePrincipal = context =>
        {
            if (context.Principal?.FindFirst("sirk:identity_source")?.Value != "local-break-glass")
                return Task.CompletedTask;
            var current = context.HttpContext.RequestServices.GetRequiredService<LocalIdentityStore>().GetBreakGlassIdentity();
            var currentId = context.Principal?.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
            if (current is null || !string.Equals(current.Id, currentId, StringComparison.Ordinal)) context.RejectPrincipal();
            return Task.CompletedTask;
        }
    };
});
builder.Services.AddSirkEntraAuthentication();

builder.Services.AddAuthorizationBuilder()
    .AddPolicy(SirkPolicies.PortalManagement, policy => policy.RequireAuthenticatedUser().RequireRole(SirkRoles.BreakGlass, SirkRoles.SecAdmin, SirkRoles.Admin))
    .AddPolicy(SirkPolicies.SecurityAdministration, policy => policy.RequireAuthenticatedUser().RequireRole(SirkRoles.BreakGlass, SirkRoles.SecAdmin))
    .AddPolicy(SirkPolicies.AuditRead, policy => policy.RequireAuthenticatedUser().RequireRole(SirkRoles.BreakGlass, SirkRoles.SecAdmin, SirkRoles.Auditor));

builder.Services.AddAntiforgery(options =>
{
    options.HeaderName = "X-SIRK-CSRF";
    options.Cookie.Name = secureCookies ? "__Host-SIRK-Central-CSRF" : "SIRK-Central-CSRF-Development";
    options.Cookie.HttpOnly = true;
    options.Cookie.IsEssential = true;
    options.Cookie.Path = "/";
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy = secureCookies ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;
});

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy(SecurityEndpointNames.BreakGlassLoginRateLimit, context =>
        RateLimitPartition.GetSlidingWindowLimiter(context.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new SlidingWindowRateLimiterOptions
        {
            PermitLimit = Math.Clamp(securityOptions.LoginAttemptsPerFiveMinutes, 1, 100),
            Window = TimeSpan.FromMinutes(5),
            SegmentsPerWindow = 5,
            QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
            QueueLimit = 0,
            AutoReplenishment = true
        }));
});

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedHost | ForwardedHeaders.XForwardedProto;
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
    _ = app.Services.GetRequiredService<LocalIdentityStore>();
    _ = app.Services.GetRequiredService<BackupKeyStore>();
    _ = app.Services.GetRequiredService<BackupArchiveService>();
    _ = app.Services.GetRequiredService<EntraSettingsStore>();
    _ = app.Services.GetRequiredService<ApprovalStore>();
    _ = app.Services.GetRequiredService<TicketStore>();
    _ = app.Services.GetRequiredService<TicketCommandStore>();
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
        context.Response.Headers.TryAdd("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
        return Task.CompletedTask;
    });
    await next();
});
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/healthz", () => Results.Ok(new { status = "healthy", service = "sirk-central", utc = DateTimeOffset.UtcNow }));
app.MapGet("/readyz", () => runtimeState.IsReady
    ? Results.Ok(new { status = "ready", service = "sirk-central", utc = DateTimeOffset.UtcNow })
    : Results.Json(new { status = "starting", service = "sirk-central", utc = DateTimeOffset.UtcNow }, statusCode: 503));
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
if (securityOptions.Enabled)
{
    app.MapSirkAuthentication();
    app.MapSirkEntraAuthentication();
    app.MapSirkWebAuthn();
    app.MapBackupKeyLifecycle();
    app.MapSirkBackup();
    app.MapEntraSettings();
    app.MapApprovals();
    app.MapTickets();
    app.MapTicketCommands();
}
app.MapFallback(() => Results.Problem(statusCode: 404, title: "Resource not found"));
app.Lifetime.ApplicationStarted.Register(runtimeState.MarkReady);
app.Lifetime.ApplicationStopping.Register(runtimeState.MarkStopping);
app.Run();

static void SecureDirectory(string path)
{
    if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
}

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
        return assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? assembly.GetName().Version?.ToString() ?? "unknown";
    }
}
