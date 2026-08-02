using System.Collections.Concurrent;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Sirk.Central.Access;
using Sirk.Central.Security;

namespace Sirk.Central.Portals;

internal sealed record TunnelRequest(string Id, string PortalId, string Method, string Path, Dictionary<string, string> Headers, string BodyBase64, DateTimeOffset CreatedAtUtc, DateTimeOffset ExpiresAtUtc);
internal sealed record TunnelResponse(string RequestId, int StatusCode, string ContentType, Dictionary<string, string[]> Headers, string BodyBase64);
internal sealed record TunnelResponseInput(int StatusCode, string? ContentType, Dictionary<string, string[]>? Headers, string? BodyBase64);

internal sealed class PortalTunnelRelay
{
    private const int MaxBody = 8 * 1024 * 1024;
    private readonly ConcurrentDictionary<string, ConcurrentQueue<TunnelRequest>> _queues = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<TunnelResponse>> _pending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> _owners = new(StringComparer.Ordinal);

    public async Task<TunnelResponse> RequestAsync(string portalId, string method, string path, Dictionary<string, string> headers, byte[] body, CancellationToken ct)
    {
        if (body.Length > MaxBody) throw new InvalidDataException("Request body is too large.");
        path = NormalizePath(path);
        var request = new TunnelRequest("tun-" + Guid.NewGuid().ToString("N"), portalId, method, path, RequestHeaders(headers), Convert.ToBase64String(body), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddSeconds(30));
        var completion = new TaskCompletionSource<TunnelResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_pending.TryAdd(request.Id, completion) || !_owners.TryAdd(request.Id, portalId)) throw new InvalidOperationException("Tunnel request collision.");
        _queues.GetOrAdd(portalId, _ => new ConcurrentQueue<TunnelRequest>()).Enqueue(request);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var registration = timeout.Token.Register(() => completion.TrySetCanceled(timeout.Token));
        try { return await completion.Task; }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new TimeoutException("Portal request timed out."); }
        finally { _pending.TryRemove(request.Id, out _); _owners.TryRemove(request.Id, out _); }
    }

    public IReadOnlyList<TunnelRequest> Poll(string portalId, int limit = 16)
    {
        var result = new List<TunnelRequest>();
        if (!_queues.TryGetValue(portalId, out var queue)) return result;
        while (result.Count < Math.Clamp(limit, 1, 64) && queue.TryDequeue(out var request))
        {
            if (request.ExpiresAtUtc > DateTimeOffset.UtcNow) result.Add(request);
            else { _owners.TryRemove(request.Id, out _); if (_pending.TryRemove(request.Id, out var pending)) pending.TrySetException(new TimeoutException("Portal request expired.")); }
        }
        return result;
    }

    public bool Complete(string portalId, string requestId, TunnelResponseInput input)
    {
        if (!_owners.TryGetValue(requestId, out var owner) || owner != portalId || !_pending.TryGetValue(requestId, out var completion)) return false;
        var body = Decode(input.BodyBase64, MaxBody);
        var response = new TunnelResponse(requestId, input.StatusCode is >= 100 and <= 599 ? input.StatusCode : 502, ContentType(input.ContentType), ResponseHeaders(input.Headers), Convert.ToBase64String(body));
        return completion.TrySetResult(response);
    }

    private static string NormalizePath(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || !value.StartsWith("/", StringComparison.Ordinal) || value.StartsWith("//", StringComparison.Ordinal) || value.Contains('\\') || value.Length > 8192 || value.Any(char.IsControl))
            throw new InvalidDataException("Portal path is invalid.");
        return value;
    }
    private static Dictionary<string, string> RequestHeaders(Dictionary<string, string> source)
    {
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "accept", "accept-language", "content-type", "user-agent", "x-sirk-csrf", "cookie" };
        return source.Where(x => allowed.Contains(x.Key) && x.Value.Length <= 8192 && !x.Value.Any(ch => ch is '\r' or '\n')).ToDictionary(x => x.Key.ToLowerInvariant(), x => x.Value, StringComparer.OrdinalIgnoreCase);
    }
    private static Dictionary<string, string[]> ResponseHeaders(Dictionary<string, string[]>? source)
    {
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "location", "set-cookie", "etag", "last-modified" };
        var result = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in source ?? [])
        {
            if (!allowed.Contains(item.Key)) continue;
            var values = (item.Value ?? []).Where(v => v.Length <= 8192 && !v.Any(ch => ch is '\r' or '\n')).Take(16).ToArray();
            if (values.Length > 0) result[item.Key] = values;
        }
        return result;
    }
    private static string ContentType(string? value)
    {
        var result = (value ?? "application/octet-stream").Trim();
        return result.Length is > 0 and <= 200 && !result.Any(ch => ch is '\r' or '\n') ? result : "application/octet-stream";
    }
    private static byte[] Decode(string? value, int limit)
    {
        try { var bytes = Convert.FromBase64String(value ?? string.Empty); return bytes.Length <= limit ? bytes : throw new InvalidDataException("Portal response body is too large."); }
        catch (FormatException) { throw new InvalidDataException("Portal response body is invalid Base64."); }
    }
}

internal sealed class PortalTunnelMiddleware
{
    private readonly PortalTunnelRelay _relay = new();
    private readonly PortalRequestAuthenticator _portalAuth;
    private readonly FilePortalRegistry _portals;
    private readonly IdentityAccessStore _access;

    public PortalTunnelMiddleware(PortalRequestAuthenticator portalAuth, FilePortalRegistry portals, IdentityAccessStore access)
    { _portalAuth = portalAuth; _portals = portals; _access = access; }

    public async Task<bool> TryHandleAsync(HttpContext context)
    {
        if (context.Request.Path.StartsWithSegments("/api/v1/portal-tunnel", out var portalRemainder)) return await PortalAsync(context, portalRemainder);
        if (context.Request.Path.StartsWithSegments("/api/v1/portals", out var apiRemainder))
        {
            await AuthenticateSession(context);
            return await ConnectAsync(context, apiRemainder);
        }
        if (context.Request.Path.StartsWithSegments("/connect", out var proxyRemainder))
        {
            await AuthenticateSession(context);
            return await ProxyAsync(context, proxyRemainder);
        }
        return false;
    }

    private static async Task AuthenticateSession(HttpContext context)
    {
        var result = await context.AuthenticateAsync(SirkAuthenticationSchemes.Session);
        if (result.Principal is not null) context.User = result.Principal;
    }

    private async Task<bool> PortalAsync(HttpContext context, PathString remainder)
    {
        var identity = await _portalAuth.AuthenticateAsync(context.Request, context.RequestAborted);
        if (identity is null) { context.Response.StatusCode = 401; return true; }
        if (HttpMethods.IsGet(context.Request.Method) && remainder == "/poll")
        { await context.Response.WriteAsJsonAsync(new { requests = _relay.Poll(identity.PortalId) }, context.RequestAborted); return true; }
        if (HttpMethods.IsPost(context.Request.Method) && remainder.StartsWithSegments("/responses", out var tail))
        {
            var requestId = tail.Value?.Trim('/');
            if (string.IsNullOrWhiteSpace(requestId) || requestId.Length > 80) { context.Response.StatusCode = 400; return true; }
            var input = await context.Request.ReadFromJsonAsync<TunnelResponseInput>(cancellationToken: context.RequestAborted) ?? throw new InvalidDataException("Response body is required.");
            context.Response.StatusCode = _relay.Complete(identity.PortalId, requestId, input) ? 204 : 404; return true;
        }
        context.Response.StatusCode = 404; return true;
    }

    private async Task<bool> ConnectAsync(HttpContext context, PathString remainder)
    {
        if (!HttpMethods.IsPost(context.Request.Method)) return false;
        var segments = remainder.Value?.Split('/', StringSplitOptions.RemoveEmptyEntries) ?? [];
        if (segments.Length != 2 || segments[1] != "connect") return false;
        var portalId = segments[0];
        var denied = AccessError(context, portalId);
        if (denied is not null) { await WriteError(context, denied.Value); return true; }
        var response = await _relay.RequestAsync(portalId, "GET", "/api/v1/system/info", [], [], context.RequestAborted);
        if (response.StatusCode is < 200 or >= 300) { context.Response.StatusCode = 502; return true; }
        await context.Response.WriteAsJsonAsync(new { ok = true, portalId, url = $"/connect/{portalId}/" }, context.RequestAborted); return true;
    }

    private async Task<bool> ProxyAsync(HttpContext context, PathString remainder)
    {
        var value = remainder.Value ?? string.Empty;
        var slash = value.IndexOf('/', 1);
        var portalId = slash < 0 ? value.Trim('/') : value[1..slash];
        if (string.IsNullOrWhiteSpace(portalId)) { context.Response.StatusCode = 404; return true; }
        var denied = AccessError(context, portalId);
        if (denied is not null) { await WriteError(context, denied.Value); return true; }
        var path = (slash < 0 ? "/" : value[slash..]) + context.Request.QueryString.Value;
        var body = await ReadBody(context.Request, 8 * 1024 * 1024, context.RequestAborted);
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["accept"] = context.Request.Headers.Accept.ToString(), ["accept-language"] = context.Request.Headers.AcceptLanguage.ToString(),
            ["content-type"] = context.Request.ContentType ?? string.Empty, ["user-agent"] = context.Request.Headers.UserAgent.ToString(),
            ["x-sirk-csrf"] = context.Request.Headers["X-SIRK-CSRF"].ToString(), ["cookie"] = FilterCookie(context.Request.Headers.Cookie.ToString())
        };
        try
        {
            var response = await _relay.RequestAsync(portalId, context.Request.Method, path, headers, body, context.RequestAborted);
            context.Response.StatusCode = response.StatusCode; context.Response.ContentType = response.ContentType; context.Response.Headers.CacheControl = "no-store";
            foreach (var item in response.Headers)
            {
                if (item.Key.Equals("location", StringComparison.OrdinalIgnoreCase)) context.Response.Headers.Location = RewriteLocation(item.Value.FirstOrDefault(), portalId);
                else if (item.Key.Equals("set-cookie", StringComparison.OrdinalIgnoreCase)) foreach (var cookie in item.Value) context.Response.Headers.Append("Set-Cookie", RewriteCookie(cookie, portalId));
            }
            if (!HttpMethods.IsHead(context.Request.Method)) await context.Response.Body.WriteAsync(Convert.FromBase64String(response.BodyBase64), context.RequestAborted);
        }
        catch (TimeoutException) { context.Response.StatusCode = 504; await context.Response.WriteAsJsonAsync(new { code = "PORTAL_TUNNEL_TIMEOUT" }); }
        return true;
    }

    private (int Status, string Error, bool Approval)? AccessError(HttpContext context, string portalId)
    {
        if (context.User.Identity?.IsAuthenticated != true) return (401, "Authentication required.", false);
        if (_portals.Get(portalId) is null) return (404, "Portal not found.", false);
        ManagedIdentity? identity;
        if (context.User.IsInRole(SirkRoles.BreakGlass)) identity = new ManagedIdentity("break-glass", "local", "break-glass", "Break Glass", SirkRoles.BreakGlass, null, [], "active", true, null, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, "");
        else { var key = context.User.FindFirstValue(ClaimTypes.NameIdentifier); identity = key is null ? null : _access.Get(key); }
        if (identity is null) return (403, "Identity is not managed.", false);
        var effective = _access.Effective(identity, portalId);
        var state = effective.Capabilities.GetValueOrDefault("portal.connect");
        if (!effective.Allowed || state == "deny") return (403, "Portal access denied by policy.", false);
        return state == "approval" ? (409, "Portal connection requires approval.", true) : null;
    }

    private static async Task WriteError(HttpContext context, (int Status, string Error, bool Approval) error)
    { context.Response.StatusCode = error.Status; await context.Response.WriteAsJsonAsync(new { error = error.Error, approvalRequired = error.Approval }); }
    private static async Task<byte[]> ReadBody(HttpRequest request, int limit, CancellationToken ct)
    {
        using var output = new MemoryStream(); var buffer = new byte[81920];
        while (true) { var read = await request.Body.ReadAsync(buffer, ct); if (read == 0) break; if (output.Length + read > limit) throw new InvalidDataException("Request body is too large."); await output.WriteAsync(buffer.AsMemory(0, read), ct); }
        return output.ToArray();
    }
    private static string FilterCookie(string value) => string.Join("; ", value.Split(';', StringSplitOptions.RemoveEmptyEntries).Select(x => x.Trim()).Where(x => !x.StartsWith("__Host-SIRK-Central-Session=", StringComparison.OrdinalIgnoreCase) && !x.StartsWith("SIRK-Central-Session-Development=", StringComparison.OrdinalIgnoreCase)));
    private static string RewriteLocation(string? value, string portalId)
    { if (string.IsNullOrWhiteSpace(value)) return string.Empty; var prefix = $"/connect/{portalId}"; if (value.StartsWith('/')) return prefix + value; return Uri.TryCreate(value, UriKind.Absolute, out var uri) ? prefix + uri.PathAndQuery + uri.Fragment : value; }
    private static string RewriteCookie(string value, string portalId)
    { var parts = value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Where(x => !x.StartsWith("Domain=", StringComparison.OrdinalIgnoreCase) && !x.StartsWith("Path=", StringComparison.OrdinalIgnoreCase)).ToList(); parts.Add($"Path=/connect/{portalId}/"); return string.Join("; ", parts); }
}
