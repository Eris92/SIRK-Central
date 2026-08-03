using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;
using Sirk.Central.Tickets;

var root = Path.Combine(Path.GetTempPath(), $"sirk-central-tickets-{Guid.NewGuid():N}");
Directory.CreateDirectory(root);

try
{
    var options = new SecurityOptions { Enabled = true, DataRoot = root };
    var configuration = new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Sirk:Tickets:MaxProjections"] = "100",
            ["Sirk:Tickets:EventIdRetention"] = "100",
            ["Sirk:Tickets:MaxCommands"] = "100"
        })
        .Build();
    var store = new TicketStore(Options.Create(options), configuration);
    var timestamp = DateTimeOffset.UtcNow.AddMinutes(-5);
    var ticket = Input("ticket-001", "Initial issue", timestamp, "new", "critical");

    var created = store.ApplyEvent("portal-01", new TicketEventRequest(
        "event-001", "ticket.created", timestamp, ticket));
    Assert(created.Accepted && !created.Duplicate && !created.Stale,
        "Initial ticket event must be accepted.");

    var duplicate = store.ApplyEvent("portal-01", new TicketEventRequest(
        "event-001", "ticket.created", timestamp, ticket));
    Assert(!duplicate.Accepted && duplicate.Duplicate,
        "Replayed event ID must be detected as duplicate.");

    var stale = store.ApplyEvent("portal-01", new TicketEventRequest(
        "event-002", "ticket.updated", timestamp.AddMinutes(-1),
        Input("ticket-001", "Stale issue", timestamp.AddMinutes(-1), "accepted", "high")));
    Assert(!stale.Accepted && stale.Stale && stale.Ticket.Title == "Initial issue",
        "Older ticket version must be ignored.");

    AssertThrows<InvalidOperationException>(() => store.ApplyEvent("portal-01", new TicketEventRequest(
        "event-003", "ticket.updated", timestamp,
        Input("ticket-001", "Conflicting content", timestamp, "accepted", "high"))),
        "Same timestamp with different content must be rejected.");

    var updated = store.ApplyEvent("portal-01", new TicketEventRequest(
        "event-004", "ticket.status_changed", timestamp.AddMinutes(1),
        Input("ticket-001", "Initial issue", timestamp.AddMinutes(1), "in_progress", "critical")));
    Assert(updated.Accepted && updated.Ticket.Status == "in_progress",
        "Newer ticket version must update projection.");

    Assert(store.List("portal-01", "in_progress", "critical", "Initial", false, 10).Count == 1,
        "Ticket filtering failed.");
    var statePath = Path.Combine(root, "ticket-projections.net10.json");
    Assert(File.Exists(statePath), "Ticket projection state was not persisted.");
    AssertProtectedFile(statePath);

    var reloaded = new TicketStore(Options.Create(options), configuration);
    Assert(reloaded.List("portal-01", null, null, null, false, 10).Single().Status == "in_progress",
        "Ticket projection did not survive restart.");
    var replayAfterRestart = reloaded.ApplyEvent("portal-01", new TicketEventRequest(
        "event-004", "ticket.status_changed", timestamp.AddMinutes(1),
        Input("ticket-001", "Initial issue", timestamp.AddMinutes(1), "in_progress", "critical")));
    Assert(replayAfterRestart.Duplicate, "Event replay guard did not survive restart.");

    var commands = new TicketCommandStore(Options.Create(options), configuration);
    var command = commands.Create(
        "portal-01",
        "ticket-001",
        new TicketCommandCreateRequest("ticket.status.change", "ticket-command-key-0001",
            new Dictionary<string, System.Text.Json.JsonElement>()),
        "operator-1");
    Assert(command.State == "pending", "New ticket command must be pending.");
    var idempotent = commands.Create(
        "portal-01",
        "ticket-001",
        new TicketCommandCreateRequest("ticket.status.change", "ticket-command-key-0001",
            new Dictionary<string, System.Text.Json.JsonElement>()),
        "operator-1");
    Assert(idempotent.Id == command.Id, "Ticket command idempotency failed.");
    Assert(commands.Poll("portal-01", 10).Single().Id == command.Id,
        "Portal polling did not return pending command.");
    var acknowledged = commands.Acknowledge(
        "portal-01",
        new TicketCommandAckRequest(command.Id, "completed", null, null));
    Assert(acknowledged.State == "completed" && acknowledged.AcknowledgedAtUtc is not null,
        "Ticket command acknowledgement failed.");
    Assert(commands.Poll("portal-01", 10).Count == 0,
        "Acknowledged command remained in pending polling queue.");
    var replayedAck = commands.Acknowledge(
        "portal-01",
        new TicketCommandAckRequest(command.Id, "completed", null, null));
    Assert(replayedAck.State == "completed", "Idempotent command acknowledgement failed.");
    AssertThrows<InvalidOperationException>(() => commands.Acknowledge(
        "portal-01",
        new TicketCommandAckRequest(command.Id, "failed", "conflict", null)),
        "Conflicting command acknowledgement must be rejected.");

    var commandPath = Path.Combine(root, "ticket-commands.net10.json");
    Assert(File.Exists(commandPath), "Ticket command state was not persisted.");
    AssertProtectedFile(commandPath);
    var reloadedCommands = new TicketCommandStore(Options.Create(options), configuration);
    Assert(reloadedCommands.List("portal-01", "ticket-001", "completed", 10).Single().Id == command.Id,
        "Ticket command did not survive restart.");

    AssertThrows<InvalidDataException>(() => store.ApplyEvent("portal-01", new TicketEventRequest(
        "event-005", "unsupported.event", timestamp.AddMinutes(2), ticket)),
        "Unsupported event type must be rejected.");
    AssertThrows<InvalidDataException>(() => store.ApplyEvent("portal-01", new TicketEventRequest(
        "event-006", "ticket.updated", timestamp.AddMinutes(2),
        Input("ticket-001", "Invalid status", timestamp.AddMinutes(2), "invalid", "normal"))),
        "Unsupported ticket status must be rejected.");

    Console.WriteLine("SIRK Central ticket projection, replay, command and acknowledgement contracts: OK");
}
finally
{
    if (Directory.Exists(root)) Directory.Delete(root, true);
}

static TicketInput Input(string id, string title, DateTimeOffset updated, string status, string priority) =>
    new(
        id, "tenant-01", "customer-01", "site-01", "local", id, title,
        "Ticket test description", status, priority, "test", "portal", null, null,
        "device-01", updated.AddMinutes(-10), updated,
        new TicketSla(null, null, false), new TicketSync("local", null, string.Empty));

static void AssertProtectedFile(string path)
{
    if (OperatingSystem.IsWindows()) return;
    var mode = File.GetUnixFileMode(path);
    var forbidden = UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute |
                    UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;
    Assert((mode & forbidden) == 0, $"Protected file has weak permissions: {mode}");
}

static void AssertThrows<TException>(Action action, string message)
    where TException : Exception
{
    try { action(); }
    catch (TException) { return; }
    throw new InvalidOperationException(message);
}

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
