using System.Reflection;
using Microsoft.AspNetCore.HttpOverrides;
using Sirk.Central.Portals;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.UseWebRoot("public");
builder.WebHost.ConfigureKestrel(options => options.AddServerHeader = false);

builder.Services.AddProblemDetails();
builder.Services.AddSingleton<RuntimeState>();
builder.Services.Configure<PortalProtocolOptions>(
    builder.Configuration.GetSection(PortalProtocolOptions.SectionName));
builder.Services.AddSingleton<FilePortalRegistry>();
builder.Services.AddSingleton<PortalNonceReplayGuard>();
builder.Services.AddSingleton<PortalRequestAuthenticator>();
builder.Services.AddSingleton<PortalTelemetryStore>();
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor |
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

app.UseForwardedHeaders();

if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
}

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
        return Task.CompletedTask;
    });

    await next();
});

app.UseDefaultFiles();
app.UseStaticFiles();

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
    : Results.Json(
        new
        {
            status = "starting",
            service = "sirk-central",
            utc = DateTimeOffset.UtcNow
        },
        statusCode: StatusCodes.Status503ServiceUnavailable));

app.MapGet("/api/v1/system/version", () => Results.Ok(new
{
    product = "SIRK Central",
    runtime = ".NET 10",
    framework = AppContext.TargetFrameworkName,
    version = VersionInfo.Current,
    environment = app.Environment.EnvironmentName
}));

app.MapPortalProtocol();

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
                   .GetCustomAttribute<AssemblyInformationalVersionAttribute>()
                   ?.InformationalVersion
               ?? assembly.GetName().Version?.ToString()
               ?? "unknown";
    }
}
