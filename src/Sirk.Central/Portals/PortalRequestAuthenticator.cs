using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace Sirk.Central.Portals;

internal sealed record PortalAuthenticationResult(
    bool Succeeded,
    PortalIdentity? Portal,
    string ErrorCode,
    string ErrorMessage)
{
    public static PortalAuthenticationResult Success(PortalIdentity portal) =>
        new(true, portal, string.Empty, string.Empty);

    public static PortalAuthenticationResult Failure(string code, string message) =>
        new(false, null, code, message);
}

internal sealed class PortalRequestAuthenticator
{
    private readonly FilePortalRegistry _registry;
    private readonly PortalProtocolOptions _options;
    private readonly PortalNonceReplayGuard _nonceGuard;

    public PortalRequestAuthenticator(
        FilePortalRegistry registry,
        IOptions<PortalProtocolOptions> options,
        PortalNonceReplayGuard nonceGuard)
    {
        _registry = registry;
        _options = options.Value;
        _nonceGuard = nonceGuard;
    }

    public PortalAuthenticationResult AuthenticateCredentials(HttpRequest request)
    {
        if (!TryReadCredentials(request, out var portalId, out var token))
        {
            return PortalAuthenticationResult.Failure(
                "PORTAL_AUTH_INVALID",
                "Portal authentication failed.");
        }

        try
        {
            var portal = _registry.Authenticate(portalId, token);
            return portal is null
                ? PortalAuthenticationResult.Failure(
                    "PORTAL_AUTH_INVALID",
                    "Portal authentication failed.")
                : PortalAuthenticationResult.Success(portal);
        }
        finally
        {
            token = string.Empty;
        }
    }

    public PortalAuthenticationResult AuthenticateSignedHeartbeat(
        HttpRequest request,
        ReadOnlySpan<byte> rawBody)
    {
        if (!TryReadCredentials(request, out var portalId, out var token))
        {
            return PortalAuthenticationResult.Failure(
                "PORTAL_AUTH_INVALID",
                "Portal authentication failed.");
        }

        try
        {
            var portal = _registry.Authenticate(portalId, token);
            if (portal is null)
            {
                return PortalAuthenticationResult.Failure(
                    "PORTAL_AUTH_INVALID",
                    "Portal authentication failed.");
            }

            if (!TryReadTimestamp(request, out var timestampMilliseconds))
            {
                return PortalAuthenticationResult.Failure(
                    "PORTAL_TIMESTAMP_INVALID",
                    "Portal timestamp is invalid.");
            }

            var maximumSkew = TimeSpan.FromSeconds(_options.MaximumClockSkewSeconds);
            var requestTime = DateTimeOffset.FromUnixTimeMilliseconds(timestampMilliseconds);
            if ((DateTimeOffset.UtcNow - requestTime).Duration() > maximumSkew)
            {
                return PortalAuthenticationResult.Failure(
                    "PORTAL_TIMESTAMP_OUT_OF_RANGE",
                    "Portal timestamp is outside the accepted clock-skew window.");
            }

            var nonce = request.Headers["X-SIRK-Nonce"].ToString();
            if (!IsValidBase64Url(nonce, 16, 256))
            {
                return PortalAuthenticationResult.Failure(
                    "PORTAL_NONCE_INVALID",
                    "Portal nonce is invalid.");
            }

            var signatureText = request.Headers["X-SIRK-Signature"].ToString();
            if (!TryDecodeBase64Url(signatureText, out var suppliedSignature) ||
                suppliedSignature.Length != 32)
            {
                return PortalAuthenticationResult.Failure(
                    "PORTAL_SIGNATURE_INVALID",
                    "Portal signature is invalid.");
            }

            var timestampText = timestampMilliseconds.ToString(CultureInfo.InvariantCulture);
            var prefix = Encoding.UTF8.GetBytes($"{timestampText}\n{nonce}\n");
            var signedContent = new byte[prefix.Length + rawBody.Length];
            prefix.CopyTo(signedContent, 0);
            rawBody.CopyTo(signedContent.AsSpan(prefix.Length));

            var tokenBytes = Encoding.UTF8.GetBytes(token);
            byte[] expectedSignature;
            try
            {
                using var hmac = new HMACSHA256(tokenBytes);
                expectedSignature = hmac.ComputeHash(signedContent);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(tokenBytes);
                CryptographicOperations.ZeroMemory(signedContent);
            }

            if (!CryptographicOperations.FixedTimeEquals(expectedSignature, suppliedSignature))
            {
                return PortalAuthenticationResult.Failure(
                    "PORTAL_SIGNATURE_INVALID",
                    "Portal signature is invalid.");
            }

            if (!_nonceGuard.TryAccept(portal.Id, nonce, requestTime, maximumSkew))
            {
                return PortalAuthenticationResult.Failure(
                    "PORTAL_NONCE_REPLAYED",
                    "Portal nonce has already been used.");
            }

            return PortalAuthenticationResult.Success(portal);
        }
        catch (ArgumentOutOfRangeException)
        {
            return PortalAuthenticationResult.Failure(
                "PORTAL_TIMESTAMP_INVALID",
                "Portal timestamp is invalid.");
        }
        finally
        {
            token = string.Empty;
        }
    }

    private static bool TryReadCredentials(
        HttpRequest request,
        out string portalId,
        out string token)
    {
        portalId = string.Empty;
        token = string.Empty;

        var authorization = request.Headers.Authorization.ToString();
        const string scheme = "SIRK-Portal ";
        if (authorization.Length is < 16 or > 8192 ||
            !authorization.StartsWith(scheme, StringComparison.Ordinal))
        {
            return false;
        }

        var encoded = authorization[scheme.Length..];
        if (!TryDecodeBase64Url(encoded, out var decodedBytes))
        {
            return false;
        }

        var decoded = Encoding.UTF8.GetString(decodedBytes);
        var separator = decoded.IndexOf(':', StringComparison.Ordinal);
        if (separator is < 1 or > 128 || decoded.Length - separator - 1 < 32)
        {
            return false;
        }

        portalId = decoded[..separator];
        token = decoded[(separator + 1)..];
        return true;
    }

    private static bool TryReadTimestamp(HttpRequest request, out long timestampMilliseconds) =>
        long.TryParse(
            request.Headers["X-SIRK-Timestamp"].ToString(),
            NumberStyles.None,
            CultureInfo.InvariantCulture,
            out timestampMilliseconds);

    private static bool IsValidBase64Url(string value, int minimumLength, int maximumLength)
    {
        if (value.Length < minimumLength || value.Length > maximumLength)
        {
            return false;
        }

        foreach (var character in value)
        {
            if (character is not (>= 'a' and <= 'z') and
                not (>= 'A' and <= 'Z') and
                not (>= '0' and <= '9') and
                not '-' and
                not '_')
            {
                return false;
            }
        }

        return true;
    }

    private static bool TryDecodeBase64Url(string value, out byte[] bytes)
    {
        bytes = [];
        if (!IsValidBase64Url(value, 1, 8192))
        {
            return false;
        }

        var normalized = value.Replace('-', '+').Replace('_', '/');
        normalized += normalized.Length % 4 switch
        {
            0 => string.Empty,
            2 => "==",
            3 => "=",
            _ => string.Empty
        };

        if (value.Length % 4 == 1)
        {
            return false;
        }

        try
        {
            bytes = Convert.FromBase64String(normalized);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }
}

internal sealed class PortalNonceReplayGuard
{
    private readonly ConcurrentDictionary<string, long> _nonces = new(StringComparer.Ordinal);
    private long _operations;

    public bool TryAccept(
        string portalId,
        string nonce,
        DateTimeOffset requestTime,
        TimeSpan retention)
    {
        CleanupExpired(retention);
        var key = $"{portalId}:{nonce}";
        return _nonces.TryAdd(key, requestTime.ToUnixTimeMilliseconds());
    }

    private void CleanupExpired(TimeSpan retention)
    {
        if (Interlocked.Increment(ref _operations) % 256 != 0)
        {
            return;
        }

        var cutoff = DateTimeOffset.UtcNow.Subtract(retention).ToUnixTimeMilliseconds();
        foreach (var item in _nonces)
        {
            if (item.Value < cutoff)
            {
                _nonces.TryRemove(item.Key, out _);
            }
        }
    }
}
