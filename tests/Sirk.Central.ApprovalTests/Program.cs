using Microsoft.Extensions.Options;
using Sirk.Central.Approvals;
using Sirk.Central.Security;

var root = Path.Combine(Path.GetTempPath(), $"sirk-central-approvals-{Guid.NewGuid():N}");
Directory.CreateDirectory(root);

try
{
    var options = new SecurityOptions
    {
        Enabled = true,
        DataRoot = root
    };
    var store = new ApprovalStore(Options.Create(options));
    var request = store.Submit(new ApprovalSubmitRequest(
        "operation.high-risk",
        "Rotate production credentials",
        "Required before rotating tenant credentials.",
        60,
        2,
        null,
        null), "requester");

    Assert(request.State == "pending", "New request must be pending.");
    Assert(request.RequiredApprovals == 2, "Required approval quorum was not preserved.");
    AssertThrows<InvalidOperationException>(
        () => store.Decide(request.Id, new ApprovalDecisionRequest("approve", null), "requester"),
        "Requester must not approve their own request.");

    var first = store.Decide(request.Id, new ApprovalDecisionRequest("approve", "reviewed"), "reviewer-1");
    Assert(first.State == "pending", "First approval must not satisfy a two-person quorum.");
    AssertThrows<InvalidOperationException>(
        () => store.Decide(request.Id, new ApprovalDecisionRequest("approve", null), "reviewer-1"),
        "Reviewer must not decide twice.");

    var approved = store.Decide(request.Id, new ApprovalDecisionRequest("approve", "approved"), "reviewer-2");
    Assert(approved.State == "approved", "Second independent approval must satisfy quorum.");
    Assert(approved.FinishedAtUtc is not null, "Approved request must have completion timestamp.");

    var rejectedRequest = store.Submit(new ApprovalSubmitRequest(
        "role.assignment", "Assign SecAdmin", "Privileged role assignment.", 60, 2, null, null), "requester");
    var rejected = store.Decide(rejectedRequest.Id, new ApprovalDecisionRequest("reject", "not authorized"), "reviewer-1");
    Assert(rejected.State == "rejected", "One rejection must terminate the request.");

    var cancelledRequest = store.Submit(new ApprovalSubmitRequest(
        "portal.enrollment", "Enroll Portal", "Portal enrollment was requested by mistake.", 60, 1, null, null), "requester");
    AssertThrows<InvalidOperationException>(
        () => store.Cancel(cancelledRequest.Id, "other-user"),
        "Only requester may cancel a request.");
    var cancelled = store.Cancel(cancelledRequest.Id, "requester");
    Assert(cancelled.State == "cancelled", "Requester cancellation failed.");

    var statePath = Path.Combine(root, "approvals.net10.json");
    Assert(File.Exists(statePath), "Approval state was not persisted.");
    AssertProtectedFile(statePath);
    var reloaded = new ApprovalStore(Options.Create(options));
    Assert(reloaded.List("approved", null).Any(value => value.Id == request.Id),
        "Approved request did not survive restart.");
    Assert(reloaded.List(null, "role.assignment").Any(value => value.Id == rejectedRequest.Id),
        "Type filtering or persistence failed.");

    AssertThrows<InvalidDataException>(
        () => store.Submit(new ApprovalSubmitRequest(
            "unsupported", "Invalid", "Invalid type.", 60, 1, null, null), "requester"),
        "Unsupported approval type must be rejected.");

    Console.WriteLine("SIRK Central approval quorum and separation-of-duties contracts: OK");
}
finally
{
    if (Directory.Exists(root)) Directory.Delete(root, true);
}

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
    try
    {
        action();
    }
    catch (TException)
    {
        return;
    }
    throw new InvalidOperationException(message);
}

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
