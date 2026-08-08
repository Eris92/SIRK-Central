using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;
using Sirk.Central.Updates;

var root = Path.Combine(Path.GetTempPath(), "sirk-central-update-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    var security = Options.Create(new SecurityOptions
    {
        DataRoot = Path.Combine(root, "security")
    });
    var configuration = new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Sirk:AgentUpdates:PublicBaseUrl"] = "https://central.example.test"
        })
        .Build();

    var tickets = new AgentUpdateTicketService(security, configuration);
    var request = new AgentUpdateTicketRequest("device-001", "win-x64", "stable", "0.1.1.10");
    var discover = tickets.CreateDiscover("portal-001", request);

    var first = tickets.ValidateAndConsume(discover.Ticket, "discover");
    Require(first is not null, "discover ticket must validate once");
    Require(tickets.ValidateAndConsume(discover.Ticket, "discover") is null,
        "discover ticket replay must be rejected");
    Require(tickets.ValidateAndConsume(discover.Ticket + "x", "discover") is null,
        "tampered discover ticket must be rejected");

    var descriptor = new PlatformReleaseDescriptor(
        1,
        "sirk-agent",
        "SIRK Agent",
        "0.1.1.11",
        "win-x64",
        "stable",
        "SIRK-Agent-0.1.1.11-net10-win-x64-framework-dependent.zip",
        1234,
        new string('a', 64),
        new string('b', 40),
        new DateTimeOffset(2026, 8, 8, 5, 0, 0, TimeSpan.Zero),
        new UpdateSignature("ES256", "test", "x"));
    var canonicalDescriptor = Encoding.UTF8.GetString(
        CanonicalUpdateJson.SerializeWithoutTopLevelSignature(descriptor));
    Require(
        canonicalDescriptor.Contains(
            "\"publishedAtUtc\":\"2026-08-08T05:00:00\\u002B00:00\"",
            StringComparison.Ordinal),
        "signed release timestamp canonical form must preserve System.Text.Json escaping");

    var cached = new CachedPlatformUpdate(
        "sirk-agent",
        "0.1.1.11",
        "win-x64",
        "stable",
        new string('a', 64),
        1234,
        Path.Combine(root, "package.zip"),
        descriptor);
    var download = tickets.CreateDownload(first!, cached);
    var downloadFirst = tickets.ValidateAndConsume(download.Ticket, "download");
    Require(downloadFirst is { Version: "0.1.1.11" }, "download ticket must be bound to version");
    Require(downloadFirst?.Sha256 == new string('a', 64), "download ticket must be bound to SHA256");
    Require(tickets.ValidateAndConsume(download.Ticket, "download") is null,
        "download ticket replay must be rejected");

    Require(PlatformUpdateVersion.IsValid("0.1.1.999"), "0.1.1.X must be accepted");
    Require(!PlatformUpdateVersion.IsValid("1.0.0"), "1.0.0 must be rejected by the pre-1.0 gate");
    Require(!PlatformUpdateVersion.IsValid("0.2.0.1"), "non-canonical pre-1.0 version must be rejected");
    Require(PlatformUpdateVersion.Compare("0.1.1.11", "0.1.1.10") > 0, "upgrade ordering is invalid");
    Require(PlatformUpdateVersion.Compare("0.1.1.9", "0.1.1.10") < 0, "rollback ordering is invalid");

    try
    {
        _ = PlatformUpdateDefinitions.Get("sirk-updater");
        throw new InvalidOperationException("SIRK Updater must not be distributed through the Central product cache.");
    }
    catch (KeyNotFoundException)
    {
        // Expected: Updater is the transaction executor, not a cached SIRK product payload.
    }

    Console.WriteLine("SIRK_CENTRAL_AGENT_UPDATE_CONTRACT_OK");
    return 0;
}
finally
{
    try { Directory.Delete(root, recursive: true); } catch { }
}

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
