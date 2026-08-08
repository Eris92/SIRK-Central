using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace Sirk.Central.Demo;

internal sealed record DemoRuntimeConfig(
    bool Enabled,
    string Version,
    int MaxSessions,
    int IdleTtlMinutes,
    int AbsoluteTtlMinutes,
    bool Maintenance);

internal sealed record DemoSession(
    string Id,
    string ContainerId,
    string Version,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset LastActivityUtc);

internal static class DemoOrchestratorHost
{
    private static readonly Regex VersionPattern = new("^0\\.1\\.1\\.[0-9]+$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private static readonly Regex SessionPattern = new("^[a-f0-9]{32}$", RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static bool IsRequested(string[] args) => args.Any(value => value.Equals("--demo-orchestrator", StringComparison.OrdinalIgnoreCase));

    public static async Task<int> RunAsync(string[] args)
    {
        try
        {
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = args });
            builder.WebHost.UseUrls("http://0.0.0.0:8090");
            builder.Services.AddRateLimiter(options =>
            {
                options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
                options.AddPolicy("demo-start", context => RateLimitPartition.GetSlidingWindowLimiter(
                    context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                    _ => new SlidingWindowRateLimiterOptions
                    {
                        PermitLimit = 8,
                        Window = TimeSpan.FromMinutes(1),
                        SegmentsPerWindow = 4,
                        QueueLimit = 0,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        AutoReplenishment = true
                    }));
            });

            var app = builder.Build();
            app.UseRateLimiter();
            var runtime = new Runtime(builder.Configuration, app.Logger);
            await runtime.RemoveOrphansAsync(CancellationToken.None);
            runtime.StartCleanup(app.Lifetime.ApplicationStopping);

            app.MapGet("/healthz", () => Results.Ok(new { status = "healthy", service = "sirk-demo-orchestrator" }));
            app.MapPost("/control/config", (HttpContext context, DemoRuntimeConfig config, CancellationToken ct) =>
                runtime.ConfigureAsync(context, config, ct));
            app.MapGet("/control/status", (HttpContext context) => runtime.Status(context));
            app.MapPost("/control/drain", (HttpContext context, CancellationToken ct) => runtime.DrainAsync(context, ct));
            app.MapGet("/start", (HttpContext context, CancellationToken ct) => runtime.StartSessionAsync(context, ct))
                .RequireRateLimiting("demo-start");
            app.MapMethods("/{sessionId}/{**path}", ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                (HttpContext context, string sessionId, string? path, CancellationToken ct) => runtime.ProxyAsync(context, sessionId, path, ct));

            await app.RunAsync();
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private sealed class Runtime
    {
        private readonly ConcurrentDictionary<string, DemoSession> _sessions = new(StringComparer.Ordinal);
        private readonly SemaphoreSlim _allocationGate = new(1, 1);
        private readonly HttpClient _docker;
        private readonly HttpClient _portal = new(new SocketsHttpHandler
        {
            ConnectTimeout = TimeSpan.FromSeconds(3),
            PooledConnectionLifetime = TimeSpan.FromMinutes(2)
        }) { Timeout = TimeSpan.FromSeconds(30) };
        private readonly ILogger _logger;
        private readonly string _tokenFile;
        private readonly string _imageRepository;
        private readonly string _network;
        private readonly string _publicBase;
        private DemoRuntimeConfig _config;

        public Runtime(IConfiguration configuration, ILogger logger)
        {
            _logger = logger;
            _tokenFile = configuration["Sirk:Demo:ControlTokenFile"] ?? "/run/secrets/sirk-demo-control-token";
            _imageRepository = configuration["Sirk:Demo:PortalImage"] ?? "ghcr.io/eris92/sirk-portal";
            _network = configuration["Sirk:Demo:Network"] ?? "sirk-demo";
            _publicBase = (configuration["Sirk:Demo:PublicBaseUrl"] ?? "https://demo.sirkportal.com").TrimEnd('/');
            _config = new DemoRuntimeConfig(
                configuration.GetValue("Sirk:Demo:Enabled", false),
                configuration["Sirk:Demo:Version"] ?? "0.1.1.1",
                configuration.GetValue("Sirk:Demo:MaxSessions", 4),
                configuration.GetValue("Sirk:Demo:IdleTtlMinutes", 20),
                configuration.GetValue("Sirk:Demo:AbsoluteTtlMinutes", 60),
                configuration.GetValue("Sirk:Demo:Maintenance", false));
            var socketPath = configuration["Sirk:Demo:DockerSocket"] ?? "/var/run/docker.sock";
            var handler = new SocketsHttpHandler
            {
                ConnectCallback = async (_, cancellationToken) =>
                {
                    var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                    try
                    {
                        await socket.ConnectAsync(new UnixDomainSocketEndPoint(socketPath), cancellationToken);
                        return new NetworkStream(socket, ownsSocket: true);
                    }
                    catch
                    {
                        socket.Dispose();
                        throw;
                    }
                }
            };
            _docker = new HttpClient(handler) { BaseAddress = new Uri("http://docker"), Timeout = TimeSpan.FromSeconds(30) };
        }

        public async Task<IResult> ConfigureAsync(HttpContext context, DemoRuntimeConfig config, CancellationToken cancellationToken)
        {
            if (!Authorized(context)) return Results.Unauthorized();
            var error = Validate(config);
            if (error is not null) return Results.BadRequest(new { ok = false, error });
            if (config.Enabled)
            {
                var imageReady = await ImageExistsAsync(config.Version, cancellationToken);
                if (!imageReady)
                    return Results.Json(new { ok = false, code = "DEMO_IMAGE_NOT_READY", version = config.Version }, statusCode: 503);
            }
            Volatile.Write(ref _config, config);
            return Results.Ok(new { ok = true, config, activeSessions = _sessions.Count });
        }

        public IResult Status(HttpContext context)
        {
            if (!Authorized(context)) return Results.Unauthorized();
            var config = Volatile.Read(ref _config);
            var sessions = _sessions.Values.OrderBy(value => value.CreatedAtUtc).Select(value => new
            {
                value.Id,
                value.Version,
                value.CreatedAtUtc,
                value.LastActivityUtc
            }).ToArray();
            return Results.Ok(new
            {
                ok = true,
                config,
                activeSessions = sessions.Length,
                capacityAvailable = config.Enabled && !config.Maintenance && sessions.Length < config.MaxSessions,
                sessions
            });
        }

        public async Task<IResult> DrainAsync(HttpContext context, CancellationToken cancellationToken)
        {
            if (!Authorized(context)) return Results.Unauthorized();
            var current = Volatile.Read(ref _config);
            Volatile.Write(ref _config, current with { Maintenance = true });
            await CleanupExpiredAsync(cancellationToken);
            return Results.Ok(new { ok = true, draining = true, activeSessions = _sessions.Count });
        }

        public async Task<IResult> StartSessionAsync(HttpContext context, CancellationToken cancellationToken)
        {
            var config = Volatile.Read(ref _config);
            if (!config.Enabled) return FriendlyUnavailable(StatusCodes.Status404NotFound, "Demo is disabled.");
            if (config.Maintenance) return FriendlyUnavailable(StatusCodes.Status503ServiceUnavailable, "Demo is in maintenance mode.");

            await _allocationGate.WaitAsync(cancellationToken);
            try
            {
                await CleanupExpiredAsync(cancellationToken);
                config = Volatile.Read(ref _config);
                if (_sessions.Count >= config.MaxSessions)
                    return FriendlyUnavailable(StatusCodes.Status503ServiceUnavailable, "Demo capacity is currently full. Please try again later.");

                var session = await CreateSessionAsync(config, cancellationToken);
                return Results.Redirect($"{_publicBase}/{session.Id}/", permanent: false, preserveMethod: false);
            }
            finally
            {
                _allocationGate.Release();
            }
        }

        public async Task ProxyAsync(HttpContext context, string sessionId, string? path, CancellationToken cancellationToken)
        {
            if (!SessionPattern.IsMatch(sessionId) || !_sessions.TryGetValue(sessionId, out var session))
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }
            var config = Volatile.Read(ref _config);
            var now = DateTimeOffset.UtcNow;
            if (now - session.LastActivityUtc > TimeSpan.FromMinutes(config.IdleTtlMinutes) ||
                now - session.CreatedAtUtc > TimeSpan.FromMinutes(config.AbsoluteTtlMinutes))
            {
                await DestroyAsync(session, cancellationToken);
                context.Response.StatusCode = StatusCodes.Status410Gone;
                return;
            }
            _sessions[sessionId] = session with { LastActivityUtc = now };

            var upstream = new Uri($"http://sirk-demo-{sessionId}:8080/{path ?? string.Empty}{context.Request.QueryString}");
            using var request = new HttpRequestMessage(new HttpMethod(context.Request.Method), upstream);
            if (context.Request.ContentLength is > 0 || context.Request.Headers.ContainsKey("Transfer-Encoding"))
                request.Content = new StreamContent(context.Request.Body);
            foreach (var header in context.Request.Headers)
            {
                if (header.Key.Equals("Host", StringComparison.OrdinalIgnoreCase) ||
                    header.Key.Equals("Connection", StringComparison.OrdinalIgnoreCase) ||
                    header.Key.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase) ||
                    header.Key.StartsWith("X-SIRK-Demo-", StringComparison.OrdinalIgnoreCase)) continue;
                if (!request.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray()) && request.Content is not null)
                    request.Content.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
            }
            request.Headers.TryAddWithoutValidation("X-SIRK-Demo-Prefix", "/" + sessionId);
            request.Headers.TryAddWithoutValidation("X-Forwarded-Proto", "https");
            request.Headers.TryAddWithoutValidation("X-Forwarded-Host", context.Request.Host.Value);

            using var response = await _portal.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            context.Response.StatusCode = (int)response.StatusCode;
            foreach (var header in response.Headers)
            {
                if (header.Key.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase) ||
                    header.Key.Equals("Connection", StringComparison.OrdinalIgnoreCase)) continue;
                context.Response.Headers[header.Key] = header.Value.ToArray();
            }
            foreach (var header in response.Content.Headers)
                context.Response.Headers[header.Key] = header.Value.ToArray();
            context.Response.Headers.Remove("transfer-encoding");
            if (response.Headers.Location is { } location && !location.IsAbsoluteUri && location.OriginalString.StartsWith('/'))
                context.Response.Headers.Location = "/" + sessionId + location.OriginalString;
            await response.Content.CopyToAsync(context.Response.Body, cancellationToken);
        }

        public void StartCleanup(CancellationToken stoppingToken)
        {
            _ = Task.Run(async () =>
            {
                using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
                try
                {
                    while (await timer.WaitForNextTickAsync(stoppingToken))
                        await CleanupExpiredAsync(stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
                catch (Exception error) { _logger.LogError(error, "Demo cleanup loop failed."); }
            }, stoppingToken);
        }

        public async Task RemoveOrphansAsync(CancellationToken cancellationToken)
        {
            var filters = Uri.EscapeDataString("{\"label\":[\"com.sirk.demo=true\"]}");
            using var response = await _docker.GetAsync($"/containers/json?all=1&filters={filters}", cancellationToken);
            if (!response.IsSuccessStatusCode) return;
            using var document = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(cancellationToken));
            foreach (var item in document.RootElement.EnumerateArray())
            {
                if (item.TryGetProperty("Id", out var id) && !string.IsNullOrWhiteSpace(id.GetString()))
                    await DeleteContainerAsync(id.GetString()!, cancellationToken);
            }
        }

        private async Task<DemoSession> CreateSessionAsync(DemoRuntimeConfig config, CancellationToken cancellationToken)
        {
            var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            var name = "sirk-demo-" + id;
            var created = DateTimeOffset.UtcNow;
            var body = new
            {
                Image = _imageRepository + ":" + config.Version,
                User = "65532:65532",
                Env = new[]
                {
                    "ASPNETCORE_ENVIRONMENT=Production",
                    "ASPNETCORE_URLS=http://+:8080",
                    "HOME=/tmp",
                    "Sirk__Demo__Enabled=true",
                    "Sirk__DataRoot=/var/lib/sirk-portal",
                    "Sirk__ReverseProxy__TrustAll=true"
                },
                Labels = new Dictionary<string, string>
                {
                    ["com.sirk.demo"] = "true",
                    ["com.sirk.demo.session"] = id,
                    ["com.sirk.demo.version"] = config.Version,
                    ["com.sirk.demo.created"] = created.ToUnixTimeSeconds().ToString()
                },
                HostConfig = new
                {
                    ReadonlyRootfs = true,
                    CapDrop = new[] { "ALL" },
                    SecurityOpt = new[] { "no-new-privileges:true" },
                    Memory = 384L * 1024 * 1024,
                    NanoCpus = 750_000_000L,
                    PidsLimit = 160,
                    NetworkMode = _network,
                    Tmpfs = new Dictionary<string, string>
                    {
                        ["/tmp"] = "rw,noexec,nosuid,nodev,size=64m",
                        ["/var/lib/sirk-portal"] = "rw,noexec,nosuid,nodev,size=256m"
                    }
                }
            };
            using var create = await _docker.PostAsync(
                "/containers/create?name=" + Uri.EscapeDataString(name),
                new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"), cancellationToken);
            if (!create.IsSuccessStatusCode)
                throw new InvalidOperationException("Docker rejected Demo container creation: " + await create.Content.ReadAsStringAsync(cancellationToken));
            using var document = JsonDocument.Parse(await create.Content.ReadAsStreamAsync(cancellationToken));
            var containerId = document.RootElement.GetProperty("Id").GetString() ?? throw new InvalidDataException("Docker returned no container id.");
            try
            {
                using var start = await _docker.PostAsync($"/containers/{containerId}/start", null, cancellationToken);
                start.EnsureSuccessStatusCode();
                var session = new DemoSession(id, containerId, config.Version, created, created);
                await WaitReadyAsync(name, cancellationToken);
                _sessions[id] = session;
                _logger.LogInformation("Started Demo session {SessionId} version {Version}.", id, config.Version);
                return session;
            }
            catch
            {
                await DeleteContainerAsync(containerId, cancellationToken);
                throw;
            }
        }

        private async Task WaitReadyAsync(string name, CancellationToken cancellationToken)
        {
            var deadline = DateTimeOffset.UtcNow.AddSeconds(25);
            while (DateTimeOffset.UtcNow < deadline)
            {
                try
                {
                    using var response = await _portal.GetAsync($"http://{name}:8080/readyz", cancellationToken);
                    if (response.IsSuccessStatusCode) return;
                }
                catch (HttpRequestException) { }
                await Task.Delay(TimeSpan.FromMilliseconds(500), cancellationToken);
            }
            throw new TimeoutException("Demo Portal did not become ready.");
        }

        private async Task CleanupExpiredAsync(CancellationToken cancellationToken)
        {
            var config = Volatile.Read(ref _config);
            var now = DateTimeOffset.UtcNow;
            foreach (var session in _sessions.Values)
            {
                if (now - session.LastActivityUtc > TimeSpan.FromMinutes(config.IdleTtlMinutes) ||
                    now - session.CreatedAtUtc > TimeSpan.FromMinutes(config.AbsoluteTtlMinutes))
                    await DestroyAsync(session, cancellationToken);
            }
        }

        private async Task DestroyAsync(DemoSession session, CancellationToken cancellationToken)
        {
            if (_sessions.TryRemove(session.Id, out _))
            {
                await DeleteContainerAsync(session.ContainerId, cancellationToken);
                _logger.LogInformation("Destroyed Demo session {SessionId}.", session.Id);
            }
        }

        private async Task DeleteContainerAsync(string containerId, CancellationToken cancellationToken)
        {
            try { await _docker.DeleteAsync($"/containers/{Uri.EscapeDataString(containerId)}?force=true&v=true", cancellationToken); }
            catch (Exception error) { _logger.LogWarning(error, "Failed to remove Demo container {ContainerId}.", containerId); }
        }

        private async Task<bool> ImageExistsAsync(string version, CancellationToken cancellationToken)
        {
            using var response = await _docker.GetAsync($"/images/{Uri.EscapeDataString(_imageRepository + ":" + version)}/json", cancellationToken);
            return response.IsSuccessStatusCode;
        }

        private bool Authorized(HttpContext context)
        {
            var supplied = context.Request.Headers.Authorization.ToString();
            if (!supplied.StartsWith("Bearer ", StringComparison.Ordinal)) return false;
            string expected;
            try { expected = File.ReadAllText(_tokenFile, Encoding.UTF8).Trim(); }
            catch { return false; }
            var actualHash = SHA256.HashData(Encoding.UTF8.GetBytes(supplied[7..].Trim()));
            var expectedHash = SHA256.HashData(Encoding.UTF8.GetBytes(expected));
            return CryptographicOperations.FixedTimeEquals(actualHash, expectedHash);
        }

        private static string? Validate(DemoRuntimeConfig config)
        {
            if (!VersionPattern.IsMatch(config.Version)) return "Demo version must use 0.1.1.X.";
            if (config.MaxSessions is < 1 or > 100) return "MaxSessions must be between 1 and 100.";
            if (config.IdleTtlMinutes is < 5 or > 120) return "Idle TTL must be between 5 and 120 minutes.";
            if (config.AbsoluteTtlMinutes <= config.IdleTtlMinutes || config.AbsoluteTtlMinutes > 480)
                return "Absolute TTL must be greater than idle TTL and no more than 480 minutes.";
            return null;
        }

        private static IResult FriendlyUnavailable(int status, string message) => Results.Content(
            $"<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>SIRK Demo</title></head><body style=\"font-family:Segoe UI,Arial,sans-serif;padding:3rem;max-width:48rem;margin:auto\"><h1>SIRK Portal Demo</h1><p>{WebUtility.HtmlEncode(message)}</p><p><a href=\"https://sirkportal.com\">Back to sirkportal.com</a></p></body></html>",
            "text/html; charset=utf-8", Encoding.UTF8, status);
    }
}
