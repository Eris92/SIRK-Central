using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sirk.Central.Portals;

var dataRoot = Path.Combine(Path.GetTempPath(), $"sirk-central-protocol-{Guid.NewGuid():N}");
const string portalId = "portal-test";
const string portalName = "Portal Test";
const string portalToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

try
{
    var protocolOptions = new PortalProtocolOptions
    {
        DataRoot = dataRoot,
        RegistryFileName = "portals.net10.json",
        TokenHashIterations = 100_000,
        HeartbeatIntervalSeconds = 60,
        OfflineAfterSeconds = 180,
        MaximumClockSkewSeconds = 5,
        MaximumHeartbeatBodyBytes = 65_536,
        BootstrapPortalId = portalId,
        BootstrapPortalName = portalName,
        BootstrapPortalToken = portalToken
    };

    var registry = new FilePortalRegistry(
        Options.Create(protocolOptions),
        NullLogger<FilePortalRegistry>.Instance);
    var nonceGuard = new PortalNonceReplayGuard();
    var authenticator = new PortalRequestAuthenticator(
        registry,
        Options.Create(protocolOptions),
        nonceGuard);

    var registryText = File.ReadAllText(Path.Combine(dataRoot, protocolOptions.RegistryFileName));
    Assert(
        !registryText.Contains(portalToken, StringComparison.Ordinal),
        "Portal registry must never contain the plaintext token.");
    Assert(
        registryText.Contains("PBKDF2-SHA256", StringComparison.Ordinal),
        "Portal registry must identify the PBKDF2-SHA256 token hash.");

    var body = Encoding.UTF8.GetBytes(
        """
        {"protocolVersion":1,"portalVersion":"3.0.0-dev.1","buildCommit":"test","platform":"linux-x64","hostname":"portal-test","publicUrl":"https://portal.example","health":"ok","agentCount":2,"onlineAgents":1,"updateChannel":"dev","availableVersion":"3.0.0-dev.1","capabilities":["signed-heartbeat"]}
        """);
    var parsed = JsonSerializer.Deserialize(
        body,
        PortalJsonContext.Default.PortalHeartbeatRequest);
    Assert(parsed?.ProtocolVersion == 1, "Portal heartbeat JSON contract must deserialize.");

    var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    const string nonce = "MTIzNDU2Nzg5MDEyMzQ1Njc4";
    var validRequest = CreateRequest(body, portalId, portalToken, timestamp, nonce, corruptSignature: false);
    var validResult = authenticator.AuthenticateSignedHeartbeat(validRequest, body);
    Assert(validResult.Succeeded, "Correctly signed Portal heartbeat must authenticate.");
    Assert(validResult.Portal?.Id == portalId, "Authenticated Portal identity must match the credential.");

    var replayResult = authenticator.AuthenticateSignedHeartbeat(validRequest, body);
    Assert(
        !replayResult.Succeeded && replayResult.ErrorCode == "PORTAL_NONCE_REPLAYED",
        "Replayed Portal heartbeat nonce must be rejected.");

    var invalidSignatureRequest = CreateRequest(
        body,
        portalId,
        portalToken,
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        "YWJjZGVmZ2hpamtsbW5vcHFy",
        corruptSignature: true);
    var invalidSignatureResult = authenticator.AuthenticateSignedHeartbeat(invalidSignatureRequest, body);
    Assert(
        !invalidSignatureResult.Succeeded &&
        invalidSignatureResult.ErrorCode == "PORTAL_SIGNATURE_INVALID",
        "Heartbeat with an invalid HMAC must be rejected.");

    var staleTimestamp = DateTimeOffset.UtcNow.AddMinutes(-5).ToUnixTimeMilliseconds();
    var staleRequest = CreateRequest(
        body,
        portalId,
        portalToken,
        staleTimestamp,
        "c3RhbGUtdGltZXN0YW1wLW5vbmNl",
        corruptSignature: false);
    var staleResult = authenticator.AuthenticateSignedHeartbeat(staleRequest, body);
    Assert(
        !staleResult.Succeeded && staleResult.ErrorCode == "PORTAL_TIMESTAMP_OUT_OF_RANGE",
        "Heartbeat outside the clock-skew window must be rejected.");

    var wrongTokenRequest = CreateRequest(
        body,
        portalId,
        new string('f', 64),
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        "d3JvbmctdG9rZW4tbm9uY2UtMTIz",
        corruptSignature: false);
    var wrongTokenResult = authenticator.AuthenticateSignedHeartbeat(wrongTokenRequest, body);
    Assert(
        !wrongTokenResult.Succeeded && wrongTokenResult.ErrorCode == "PORTAL_AUTH_INVALID",
        "Heartbeat with an unknown Portal token must be rejected.");

    Console.WriteLine("SIRK Central Portal protocol contracts: OK");
}
finally
{
    Directory.Delete(dataRoot, recursive: true);
}

static HttpRequest CreateRequest(
    byte[] body,
    string portalId,
    string portalToken,
    long timestamp,
    string nonce,
    bool corruptSignature)
{
    var timestampText = timestamp.ToString(CultureInfo.InvariantCulture);
    var prefix = Encoding.UTF8.GetBytes($"{timestampText}\n{nonce}\n");
    var signedContent = new byte[prefix.Length + body.Length];
    prefix.CopyTo(signedContent, 0);
    body.CopyTo(signedContent, prefix.Length);

    var signature = HMACSHA256.HashData(Encoding.UTF8.GetBytes(portalToken), signedContent);
    if (corruptSignature)
    {
        signature[0] ^= 0xff;
    }

    var context = new DefaultHttpContext();
    context.Request.Headers.Authorization =
        $"SIRK-Portal {Base64Url(Encoding.UTF8.GetBytes($"{portalId}:{portalToken}"))}";
    context.Request.Headers["X-SIRK-Timestamp"] = timestampText;
    context.Request.Headers["X-SIRK-Nonce"] = nonce;
    context.Request.Headers["X-SIRK-Signature"] = Base64Url(signature);
    return context.Request;
}

static string Base64Url(byte[] value) =>
    Convert.ToBase64String(value)
        .TrimEnd('=')
        .Replace('+', '-')
        .Replace('/', '_');

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}
