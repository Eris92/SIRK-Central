using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Sirk.Central.Portals;
using Sirk.Central.Security;

namespace Sirk.Central.Updates;

internal sealed record AgentUpdateTicketRequest(
    string DeviceId,
    string Runtime,
    string Channel,
    string CurrentVersion);

internal sealed record AgentUpdateTicketResponse(
    string CentralBaseUrl,
    string Ticket,
    DateTimeOffset ExpiresAtUtc);

internal sealed record AgentUpdateLatestResponse(
    string Version,
    string Runtime,
    string Channel,
    long Size,
    string Sha256,
    PlatformReleaseDescriptor Descriptor,
    string DownloadTicket,
    DateTimeOffset DownloadTicketExpiresAtUtc);

internal sealed record AgentUpdateTicketPayload(
    int SchemaVersion,
    string Scope,
    string PortalId,
    string DeviceId,
    string Runtime,
    string Channel,
    string CurrentVersion,
    string? Version,
    string? Sha256,
    long IssuedAtUnixSeconds,
    long ExpiresAtUnixSeconds,
    string Nonce);

internal sealed class AgentUpdateTicketService
{
    private static readonly ConcurrentDictionary<string, long> ConsumedNonces =
        new(StringComparer.Ordinal);
    private static readonly object SecretSync = new();
    private readonly byte[] _secret;
    private readonly string _centralBaseUrl;

    public AgentUpdateTicketService(
        IOptions<SecurityOptions> security,
        IConfiguration configuration)
    {
        var root = Path.Combine(security.Value.DataRoot, "agent-updates");
        Directory.CreateDirectory(root);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(
                root,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        _secret = LoadOrCreateSecret(Path.Combine(root, "delegation-ticket.key"));
        _centralBaseUrl = (configuration["Sirk:AgentUpdates:PublicBaseUrl"] ??
                           "https://central.sirkportal.com").TrimEnd('/');
        if (!Uri.TryCreate(_centralBaseUrl, UriKind.Absolute, out var baseUri) ||
            baseUri.Scheme != Uri.UriSchemeHttps ||
            !string.IsNullOrEmpty(baseUri.UserInfo))
            throw new InvalidDataException(
                "Sirk:AgentUpdates:PublicBaseUrl must be an HTTPS URL.");
    }

    public AgentUpdateTicketResponse CreateDiscover(
        string portalId,
        AgentUpdateTicketRequest request)
    {
        ValidateRequest(request);
        var expires = DateTimeOffset.UtcNow.AddMinutes(5);
        var payload = CreatePayload(
            "discover",
            portalId,
            request.DeviceId,
            request.Runtime,
            request.Channel,
            request.CurrentVersion,
            null,
            null,
            expires);
        return new AgentUpdateTicketResponse(_centralBaseUrl, Encode(payload), expires);
    }

    public (string Ticket, DateTimeOffset ExpiresAtUtc) CreateDownload(
        AgentUpdateTicketPayload discover,
        CachedPlatformUpdate update)
    {
        var expires = DateTimeOffset.UtcNow.AddMinutes(10);
        var payload = CreatePayload(
            "download",
            discover.PortalId,
            discover.DeviceId,
            discover.Runtime,
            discover.Channel,
            discover.CurrentVersion,
            update.Version,
            update.Sha256,
            expires);
        return (Encode(payload), expires);
    }

    public AgentUpdateTicketPayload? ValidateAndConsume(
        string? token,
        string expectedScope)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        var parts = token.Split('.', 2);
        if (parts.Length != 2) return null;

        byte[] payloadBytes;
        byte[] supplied;
        try
        {
            payloadBytes = Base64UrlDecode(parts[0]);
            supplied = Base64UrlDecode(parts[1]);
        }
        catch (FormatException)
        {
            return null;
        }

        if (payloadBytes.Length is <= 0 or > 4096 || supplied.Length != 32)
            return null;
        var expected = HMACSHA256.HashData(_secret, payloadBytes);
        try
        {
            if (!CryptographicOperations.FixedTimeEquals(expected, supplied)) return null;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(expected);
            CryptographicOperations.ZeroMemory(supplied);
        }

        AgentUpdateTicketPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<AgentUpdateTicketPayload>(
                payloadBytes,
                JsonDefaults.Options);
        }
        catch (JsonException)
        {
            return null;
        }

        if (payload is null || payload.SchemaVersion != 1 || payload.Scope != expectedScope ||
            string.IsNullOrWhiteSpace(payload.PortalId) ||
            string.IsNullOrWhiteSpace(payload.DeviceId) ||
            payload.Runtime != "win-x64" ||
            payload.Channel is not ("stable" or "preview") ||
            !PlatformUpdateVersion.IsValid(payload.CurrentVersion) ||
            payload.Nonce.Length is < 20 or > 80)
            return null;
        if (expectedScope == "download" &&
            (!PlatformUpdateVersion.IsValid(payload.Version) || !IsSha256(payload.Sha256)))
            return null;

        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (payload.IssuedAtUnixSeconds > now + 60 ||
            payload.ExpiresAtUnixSeconds < now ||
            payload.ExpiresAtUnixSeconds - payload.IssuedAtUnixSeconds is <= 0 or > 900)
            return null;
        CleanupNonces(now);
        return ConsumedNonces.TryAdd(payload.Nonce, payload.ExpiresAtUnixSeconds)
            ? payload
            : null;
    }

    private AgentUpdateTicketPayload CreatePayload(
        string scope,
        string portalId,
        string deviceId,
        string runtime,
        string channel,
        string currentVersion,
        string? version,
        string? sha256,
        DateTimeOffset expires)
    {
        var now = DateTimeOffset.UtcNow;
        return new AgentUpdateTicketPayload(
            1,
            scope,
            portalId,
            deviceId,
            runtime,
            channel,
            currentVersion,
            version,
            sha256,
            now.ToUnixTimeSeconds(),
            expires.ToUnixTimeSeconds(),
            Base64Url(RandomNumberGenerator.GetBytes(24)));
    }

    private string Encode(AgentUpdateTicketPayload payload)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(payload, JsonDefaults.Options);
        var signature = HMACSHA256.HashData(_secret, body);
        try
        {
            return Base64Url(body) + "." + Base64Url(signature);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(signature);
        }
    }

    private static void ValidateRequest(AgentUpdateTicketRequest request)
    {
        if (request.DeviceId is null || request.DeviceId.Length is < 3 or > 128 ||
            request.DeviceId.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.')))
            throw new InvalidDataException("Agent device id is invalid.");
        if (request.Runtime != "win-x64")
            throw new InvalidDataException("Only win-x64 updates are supported.");
        if (request.Channel is not ("stable" or "preview"))
            throw new InvalidDataException("Agent update channel is invalid.");
        if (!PlatformUpdateVersion.IsValid(request.CurrentVersion))
            throw new InvalidDataException("Current Agent version must use 0.1.1.X.");
    }

    private static byte[] LoadOrCreateSecret(string path)
    {
        lock (SecretSync)
        {
            if (!File.Exists(path))
            {
                var value = RandomNumberGenerator.GetBytes(32);
                var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
                try
                {
                    File.WriteAllBytes(temporary, value);
                    if (!OperatingSystem.IsWindows())
                        File.SetUnixFileMode(
                            temporary,
                            UnixFileMode.UserRead | UnixFileMode.UserWrite);
                    try
                    {
                        File.Move(temporary, path, overwrite: false);
                    }
                    catch (IOException) when (File.Exists(path))
                    {
                    }
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(value);
                    File.Delete(temporary);
                }
            }

            var secret = File.ReadAllBytes(path);
            if (secret.Length != 32)
                throw new InvalidDataException("Agent update delegation secret is invalid.");
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            return secret;
        }
    }

    private static void CleanupNonces(long now)
    {
        if (ConsumedNonces.Count < 256) return;
        foreach (var item in ConsumedNonces)
            if (item.Value < now) ConsumedNonces.TryRemove(item.Key, out _);
    }

    private static bool IsSha256(string? value) =>
        value is { Length: 64 } && value.All(Uri.IsHexDigit);

    private static string Base64Url(byte[] value) =>
        Convert.ToBase64String(value)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');

    private static byte[] Base64UrlDecode(string value)
    {
        var normalized = value.Replace('-', '+').Replace('_', '/');
        normalized += new string('=', (4 - normalized.Length % 4) % 4);
        return Convert.FromBase64String(normalized);
    }
}

internal static class AgentUpdateDistributionEndpoints
{
    public static void Map(IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/portal/v1/update/agent/ticket", CreateTicketAsync);
        endpoints.MapGet("/api/v1/agent-updates/latest", LatestAsync);
        endpoints.MapGet("/api/v1/agent-updates/{version}/package", DownloadAsync);
        endpoints.MapGet(
                "/api/v1/updates/agent/status",
                (PlatformUpdateCache cache) =>
                    Results.Ok(cache.Status("sirk-agent", "win-x64", "stable")))
            .RequireAuthorization(SirkPolicies.PortalManagement);
    }

    private static async Task<IResult> CreateTicketAsync(
        HttpContext context,
        PortalRequestAuthenticator authenticator,
        AgentUpdateTicketService tickets,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        var authentication = authenticator.AuthenticateCredentials(context.Request);
        if (!authentication.Succeeded || authentication.Portal is null)
            return Results.NotFound();

        AgentUpdateTicketRequest? request;
        try
        {
            request = await context.Request.ReadFromJsonAsync<AgentUpdateTicketRequest>(
                JsonDefaults.Options,
                cancellationToken);
        }
        catch (JsonException)
        {
            return Results.BadRequest(new { ok = false, code = "AGENT_UPDATE_TICKET_INVALID" });
        }
        if (request is null)
            return Results.BadRequest(new { ok = false, code = "AGENT_UPDATE_TICKET_INVALID" });

        try
        {
            return Results.Ok(tickets.CreateDiscover(authentication.Portal.Id, request));
        }
        catch (InvalidDataException error)
        {
            return Results.BadRequest(new
            {
                ok = false,
                code = "AGENT_UPDATE_TICKET_INVALID",
                error = error.Message
            });
        }
    }

    private static async Task<IResult> LatestAsync(
        HttpContext context,
        AgentUpdateTicketService tickets,
        PlatformUpdateCache cache,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        var payload = tickets.ValidateAndConsume(Bearer(context.Request), "discover");
        if (payload is null) return Results.Unauthorized();
        if (context.Request.Query["runtime"].ToString() != payload.Runtime ||
            context.Request.Query["channel"].ToString() != payload.Channel)
            return Results.BadRequest(new
            {
                ok = false,
                code = "AGENT_UPDATE_SCOPE_MISMATCH"
            });

        try
        {
            var latest = await cache.GetLatestAsync(
                "sirk-agent",
                payload.Runtime,
                payload.Channel,
                cancellationToken);
            if (latest is null ||
                PlatformUpdateVersion.Compare(latest.Version, payload.CurrentVersion) <= 0)
                return Results.NoContent();

            var download = tickets.CreateDownload(payload, latest);
            return Results.Ok(new AgentUpdateLatestResponse(
                latest.Version,
                latest.Runtime,
                latest.Channel,
                latest.Size,
                latest.Sha256,
                latest.Descriptor,
                download.Ticket,
                download.ExpiresAtUtc));
        }
        catch (Exception error) when (
            error is HttpRequestException or IOException or InvalidDataException or
            CryptographicException or KeyNotFoundException)
        {
            return Results.Json(
                new
                {
                    ok = false,
                    code = "AGENT_UPDATE_UNAVAILABLE",
                    error = error.Message
                },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }

    private static IResult DownloadAsync(
        string version,
        HttpContext context,
        AgentUpdateTicketService tickets,
        PlatformUpdateCache cache)
    {
        context.Response.Headers.CacheControl = "private, no-store";
        var payload = tickets.ValidateAndConsume(Bearer(context.Request), "download");
        if (payload is null) return Results.Unauthorized();
        if (payload.Version != version ||
            !PlatformUpdateVersion.IsValid(version) ||
            payload.Sha256 is null)
            return Results.BadRequest(new
            {
                ok = false,
                code = "AGENT_UPDATE_SCOPE_MISMATCH"
            });

        try
        {
            var update = cache.GetPackage(
                "sirk-agent",
                version,
                payload.Runtime,
                payload.Channel,
                payload.Sha256);
            context.Response.Headers.ETag = '"' + update.Sha256 + '"';
            return Results.File(
                update.PackagePath,
                "application/zip",
                enableRangeProcessing: true);
        }
        catch (FileNotFoundException)
        {
            return Results.NotFound();
        }
        catch (InvalidDataException error)
        {
            return Results.BadRequest(new
            {
                ok = false,
                code = "AGENT_UPDATE_INVALID",
                error = error.Message
            });
        }
    }

    private static string? Bearer(HttpRequest request)
    {
        var value = request.Headers.Authorization.ToString();
        return value.StartsWith("Bearer ", StringComparison.Ordinal)
            ? value[7..].Trim()
            : null;
    }
}
