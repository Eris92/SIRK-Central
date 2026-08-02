using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Sirk.Central.Access;
using Sirk.Central.Security;

namespace Sirk.Central.Portals;

internal sealed record TunnelRequest(
    string Id,
    string PortalId,
    string Method,
    string Path,
    Dictionary<string, string> Headers,
    string BodyBase64,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset ExpiresAtUtc);

internal sealed record TunnelResponse(
    string RequestId,
    int StatusCode,
    string ContentType,
    Dictionary<string, string[]> Headers,
    string BodyBase64);

internal sealed record TunnelResponseInput(
    int StatusCode,
    string? ContentType,
    Dictionary<string, string[]>? Headers,
    string? BodyBase64);

internal sealed record PendingTunnelRequest(
    string PortalId,
    TaskCompletionSource<TunnelResponse> Completion);

internal sealed class PortalTunnelRelay
{
    private const int MaximumBodyBytes = 8 * 1024 * 1024;
    private const int MaximumPendingRequests = 4096;
    private const int MaximumQueuedRequestsPerPortal = 128;
    private readonly ConcurrentDictionary<string, ConcurrentQueue<TunnelRequest>> _queues = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, PendingTunnelRequest> _pending = new(StringComparer.Ordinal);

    public async Task<TunnelResponse> RequestAsync(
        string portalId,
        string method,
        string path,
        Dictionary<string, string> headers,
        byte[] body,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(portalId);
        if (body.Length > MaximumBodyBytes) throw new InvalidDataException("Request body is too large.");
        if (_pending.Count >= MaximumPendingRequests) throw new InvalidOperationException("Tunnel capacity is exhausted.");

        var queue = _queues.GetOrAdd(portalId, static _ => new ConcurrentQueue<TunnelRequest>());
        if (queue.Count >= MaximumQueuedRequestsPerPortal)
            throw new InvalidOperationException("Portal tunnel queue is full.");

        var request = new TunnelRequest(
            "tun-" + Guid.NewGuid().ToString("N"),
            portalId,
            NormalizeMethod(method),
            NormalizePath(path),
            SanitizeRequestHeaders(headers),
            Convert.ToBase64String(body),
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow.AddSeconds(30));

        var completion = new TaskCompletionSource<TunnelResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_pending.TryAdd(request.Id, new PendingTunnelRequest(portalId, completion)))
            throw new InvalidOperationException("Tunnel request collision.");

        queue.Enqueue(request);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var registration = timeout.Token.Register(static state =>
        {
            var source = (TaskCompletionSource<TunnelResponse>)state!;
            source.TrySetCanceled();
        }, completion);

        try
        {
            return await completion.Task.ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException("Portal request timed out.");
        }
        finally
        {
            _pending.TryRemove(request.Id, out _);
        }
    }

    public IReadOnlyList<TunnelRequest> Poll(string portalId, int limit = 16)
    {
        var result = new List<TunnelRequest>();
        if (!_queues.TryGetValue(portalId, out var queue)) return result;

        while (result.Count < Math.Clamp(limit, 1, 64) && queue.TryDequeue(out var request))
        {
            if (request.ExpiresAtUtc > DateTimeOffset.UtcNow &&
                _pending.TryGetValue(request.Id, out var pending) &&
                string.Equals(pending.PortalId, portalId, StringComparison.Ordinal))
            {
                result.Add(request);
                continue;
            }

            if (_pending.TryRemove(request.Id, out var expired))
                expired.Completion.TrySetException(new TimeoutException("Portal request expired."));
        }

        if (queue.IsEmpty) _queues.TryRemove(new KeyValuePair<string, ConcurrentQueue<TunnelRequest>>(portalId, queue));
        return result;
    }

    public bool Complete(string portalId, string requestId, TunnelResponseInput input)
    {
        if (!_pending.TryGetValue(requestId, out var pending)) return false;
        if (!string.Equals(pending.PortalId, portalId, StringComparison.Ordinal)) return false;

        var status = input.StatusCode is >= 100 and <= 599 ? input.StatusCode : 502;
        var contentType = NormalizeContentType(input.ContentType);
        var headers = SanitizeResponseHeaders(input.Headers);
        var body = DecodeBody(input.BodyBase64, MaximumBodyBytes);
        return pending.Completion.TrySetResult(new TunnelResponse(
            requestId,
            status,
            contentType,
            headers,
            Convert.ToBase64String(body)));
    }

    private static string NormalizeMethod(string value)
    {
        var method = (value ?? string.Empty).Trim().ToUpperInvariant();
        return method is "GET" or "HEAD" or "POST" or "PUT" or "PATCH" or "DELETE" or "OPTIONS"
            ? method
            : throw new InvalidDataException("Portal method is invalid.");
    }

    private static string NormalizePath(string value)
    {
        if (string.IsNullOrWhiteSpace(value) ||
            !value.StartsWith('/', StringComparison.Ordinal) ||
            value.StartsWith("//", StringComparison.Ordinal) ||
            value.Contains('\\') ||
            value.Length > 8192 ||
            value.Any(char.IsControl))
        {
            throw new InvalidDataException("Portal path is invalid.");
        }
        return value;
    }

    private static Dictionary<string, string> SanitizeRequestHeaders(Dictionary<string, string> source)
    {
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "accept", "accept-language", "content-type", "user-agent", "x-sirk-csrf", "cookie"
        };
        return source
            .Where(item => allowed.Contains(item.Key) && item.Value.Length <= 8192 && !item.Value.Any(ch => ch is '\r' or '\n'))
            .ToDictionary(item => item.Key.ToLowerInvariant(), item => item.Value, StringComparer.OrdinalIgnoreCase);
    }

    private static Dictionary<string, string[]> SanitizeResponseHeaders(Dictionary<string, string[]>? source)
    {
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "location", "set-cookie", "etag", "last-modified"
        };
        var result = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in source ?? [])
        {
            if (!allowed.Contains(item.Key)) continue;
            var values = (item.Value ?? [])
                .Where(value => value.Length <= 8192 && !value.Any(ch => ch is '\r' or '\n'))
                .Take(16)
                .ToArray();
            if (values.Length > 0) result[item.Key] = values;
        }
        return result;
    }

    private static string NormalizeContentType(string? value)
    {
        var result = (value ?? "application/octet-stream").Trim();
        return result.Length is > 0 and <= 200 && !result.Any(ch => ch is '\r' or '\n')
            ? result
            : "application/octet-stream";
    }

    private static byte[] DecodeBody(string? value, int limit)
    {
        try
        {
            var body = Convert.FromBase64String(value ?? string.Empty);
            if (body.Length > limit) throw new InvalidDataException("Portal response body is too large.");
            return body;
        }
        catch (FormatException)
        {
            throw new InvalidDataException("Portal response body is invalid Base64.");
        }
    }
}

internal sealed class PortalTunnelMiddleware
{
    private readonly PortalTunnelRelay _relay = new();
    private readonly PortalRequestAuthenticator _portalAuth;
    private readonly FilePortalRegistry _portals;
    private readonly IdentityAccessStore _access;
    private readonly IAntiforgery _antiforgery;

    public PortalTunnelMiddleware(
        PortalRequestAuthenticator portalAuth,
        FilePortalRegistry portals,
        IdentityAccessStore access,
        IAntiforgery antiforgery)
    {
        _portalAuth = portalAuth;
        _portals = portals;
        _access = access;
        _antiforgery = antiforgery;
    }

    public async Task<bool> TryHandleAsync(HttpContext context)
    {
        if (context.Request.Path.StartsWithSegments("/api/v1/portal-tunnel", out var portalRemainder))
            return await HandlePortalAsync(context, portalRemainder);
        if (context.Request.Path.StartsWithSegments("/api/v1/portals", out var apiRemainder))
            return await HandleConnectAsync(context, apiRemainder);
        if (context.Request.Path.StartsWithSegments("/connect", out var proxyRemainder))
            return await HandleProxyAsync(context, proxyRemainder);
        return false;
    }

    private async Task<bool> HandlePortalAsync(HttpContext context, PathString remainder)
    {
        var identity = await _portalAuth.AuthenticateAsync(context.Request, context.RequestAborted);
        if (identity is null)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return true;
        }

        if (HttpMethods.IsGet(context.Request.Method) && remainder == "/poll")
        {
            context.Response.Headers.CacheControl = "no-store";
            await context.Response.WriteAsJsonAsync(new { requests = _relay.Poll(identity.PortalId) }, context.RequestAborted);
            return true;
        }

        if (HttpMethods.IsPost(context.Request.Method) && remainder.StartsWithSegments("/responses", out var tail))
        {
            var requestId = tail.Value?.Trim('/');
            if (string.IsNullOrWhiteSpace(requestId) || requestId.Length > 80)
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                return true;
            }

            var input = await context.Request.ReadFromJsonAsync<TunnelResponseInput>(cancellationToken: context.RequestAborted)
                ?? throw new InvalidDataException("Response body is required.");
            context.Response.StatusCode = _relay.Complete(identity.PortalId, requestId, input)
                ? StatusCodes.Status204NoContent
                : StatusCodes.Status404NotFound;
            return true;
        }

        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return true;
    }

    private async Task<bool> HandleConnectAsync(HttpContext context, PathString remainder)
    {
        if (!HttpMethods.IsPost(context.Request.Method)) return false;
        var segments = remainder.Value?.Split('/', StringSplitOptions.RemoveEmptyEntries) ?? [];
        if (segments.Length != 2 || !string.Equals(segments[1], "connect", StringComparison.Ordinal)) return false;

        try
        {
            await _antiforgery.ValidateRequestAsync(context);
        }
        catch (AntiforgeryValidationException)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsJsonAsync(new { code = "CSRF_VALIDATION_FAILED" }, context.RequestAborted);
            return true;
        }

        var portalId = segments[0];
        var access = ResolveAccess(context, portalId);
        if (access is not null)
        {
            await WriteAccessError(context, access.Value);
            return true;
        }

        var response = await _relay.RequestAsync(
            portalId,
            "GET",
            "/api/v1/system/info",
            [],
            [],
            context.RequestAborted);
        if (response.StatusCode is < 200 or >= 300)
        {
            context.Response.StatusCode = StatusCodes.Status502BadGateway;
            return true;
        }

        await context.Response.WriteAsJsonAsync(new { ok = true, portalId, url = $"/connect/{portalId}/" }, context.RequestAborted);
        return true;
    }

    private async Task<bool> HandleProxyAsync(HttpContext context, PathString remainder)
    {
        var value = remainder.Value ?? string.Empty;
        var slash = value.IndexOf('/', 1);
        var portalId = slash < 0 ? value.Trim('/') : value[1..slash];
        if (string.IsNullOrWhiteSpace(portalId))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return true;
        }

        var access = ResolveAccess(context, portalId);
        if (access is not null)
        {
            await WriteAccessError(context, access.Value);
            return true;
        }

        var portalPath = slash < 0 ? "/" : value[slash..];
        portalPath += context.Request.QueryString.Value;
        var body = await ReadBodyAsync(context.Request, MaximumProxyBodyBytes, context.RequestAborted);
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["accept"] = context.Request.Headers.Accept.ToString(),
            ["accept-language"] = context.Request.Headers.AcceptLanguage.ToString(),
            ["content-type"] = context.Request.ContentType ?? string.Empty,
            ["user-agent"] = context.Request.Headers.UserAgent.ToString(),
            ["x-sirk-csrf"] = context.Request.Headers["X-SIRK-CSRF"].ToString(),
            ["cookie"] = FilterCentralCookie(context.Request.Headers.Cookie.ToString())
        };

        try
        {
            var response = await _relay.RequestAsync(
                portalId,
                context.Request.Method,
                portalPath,
                headers,
                body,
                context.RequestAborted);
            context.Response.StatusCode = response.StatusCode;
            context.Response.ContentType = response.ContentType;
            context.Response.Headers.CacheControl = "no-store";
            foreach (var item in response.Headers)
            {
                if (item.Key.Equals("location", StringComparison.OrdinalIgnoreCase))
                {
                    var rewritten = RewriteLocation(item.Value.FirstOrDefault(), portalId);
                    if (!string.IsNullOrWhiteSpace(rewritten)) context.Response.Headers.Location = rewritten;
                }
                else if (item.Key.Equals("set-cookie", StringComparison.OrdinalIgnoreCase))
                {
                    foreach (var cookie in item.Value)
                    {
                        var rewritten = RewriteCookie(cookie, portalId);
                        if (!string.IsNullOrWhiteSpace(rewritten)) context.Response.Headers.Append("Set-Cookie", rewritten);
                    }
                }
            }

            if (!HttpMethods.IsHead(context.Request.Method))
                await context.Response.Body.WriteAsync(Convert.FromBase64String(response.BodyBase64), context.RequestAborted);
        }
        catch (TimeoutException)
        {
            context.Response.StatusCode = StatusCodes.Status504GatewayTimeout;
            await context.Response.WriteAsJsonAsync(new { code = "PORTAL_TUNNEL_TIMEOUT" }, context.RequestAborted);
        }
        catch (InvalidOperationException)
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            await context.Response.WriteAsJsonAsync(new { code = "PORTAL_TUNNEL_CAPACITY" }, context.RequestAborted);
        }

        return true;
    }

    private (int Status, string Error, bool Approval)? ResolveAccess(HttpContext context, string portalId)
    {
        if (context.User.Identity?.IsAuthenticated != true)
            return (StatusCodes.Status401Unauthorized, "Authentication required.", false);
        if (_portals.Get(portalId) is null)
            return (StatusCodes.Status404NotFound, "Portal not found.", false);

        var key = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
        ManagedIdentity? identity;
        if (context.User.IsInRole(SirkRoles.BreakGlass))
        {
            identity = new ManagedIdentity(
                "break-glass",
                "local",
                "break-glass",
                "Break Glass",
                SirkRoles.BreakGlass,
                null,
                [],
                "active",
                true,
                null,
                DateTimeOffset.UtcNow,
                DateTimeOffset.UtcNow,
                string.Empty);
        }
        else
        {
            identity = key is null ? null : _access.Get(key);
        }

        if (identity is null) return (StatusCodes.Status403Forbidden, "Identity is not managed.", false);
        var effective = _access.Effective(identity, portalId);
        if (!effective.Allowed || effective.Capabilities.GetValueOrDefault("portal.connect") == "deny")
            return (StatusCodes.Status403Forbidden, "Portal access denied by policy.", false);
        if (effective.Capabilities.GetValueOrDefault("portal.connect") == "approval")
            return (StatusCodes.Status409Conflict, "Portal connection requires approval.", true);
        return null;
    }

    private static async Task WriteAccessError(HttpContext context, (int Status, string Error, bool Approval) error)
    {
        context.Response.StatusCode = error.Status;
        await context.Response.WriteAsJsonAsync(
            new { error = error.Error, approvalRequired = error.Approval },
            context.RequestAborted);
    }

    private const int MaximumProxyBodyBytes = 8 * 1024 * 1024;

    private static async Task<byte[]> ReadBodyAsync(HttpRequest request, int limit, CancellationToken cancellationToken)
    {
        using var output = new MemoryStream();
        var buffer = new byte[81920];
        while (true)
        {
            var read = await request.Body.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            if (output.Length + read > limit) throw new InvalidDataException("Request body is too large.");
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
        return output.ToArray();
    }

    private static string FilterCentralCookie(string value) => string.Join(
        "; ",
        value.Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Select(item => item.Trim())
            .Where(item =>
                !item.StartsWith("__Host-SIRK-Central-Session=", StringComparison.OrdinalIgnoreCase) &&
                !item.StartsWith("SIRK-Central-Session-Development=", StringComparison.OrdinalIgnoreCase) &&
                !item.StartsWith("__Host-SIRK-Central-CSRF=", StringComparison.OrdinalIgnoreCase) &&
                !item.StartsWith("SIRK-Central-CSRF-Development=", StringComparison.OrdinalIgnoreCase)));

    private static string RewriteLocation(string? value, string portalId)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var prefix = $"/connect/{portalId}";
        if (value.StartsWith('/')) return prefix + value;
        return Uri.TryCreate(value, UriKind.Absolute, out var uri)
            ? prefix + uri.PathAndQuery + uri.Fragment
            : string.Empty;
    }

    private static string RewriteCookie(string value, string portalId)
    {
        var parts = value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
        if (parts.Count == 0) return string.Empty;
        var name = parts[0].Split('=', 2)[0].Trim();
        if (name.Equals("__Host-SIRK-Central-Session", StringComparison.OrdinalIgnoreCase) ||
            name.Equals("SIRK-Central-Session-Development", StringComparison.OrdinalIgnoreCase) ||
            name.Equals("__Host-SIRK-Central-CSRF", StringComparison.OrdinalIgnoreCase) ||
            name.Equals("SIRK-Central-CSRF-Development", StringComparison.OrdinalIgnoreCase))
        {
            return string.Empty;
        }

        parts = parts
            .Where(item =>
                !item.StartsWith("Domain=", StringComparison.OrdinalIgnoreCase) &&
                !item.StartsWith("Path=", StringComparison.OrdinalIgnoreCase))
            .ToList();
        parts.Add($"Path=/connect/{portalId}/");
        return string.Join("; ", parts);
    }
}
