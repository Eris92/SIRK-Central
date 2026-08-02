using Microsoft.Extensions.Options;
using Sirk.Central.Operations;
using Sirk.Central.Portals;
using Sirk.Central.Security;

var root = Path.Combine(Path.GetTempPath(), "sirk-operations-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    var options = Options.Create(new SecurityOptions { DataRoot = root, PasswordHashIterations = 100_000 });
    var store = new OperationsStore(options);
    var policy = store.SavePolicy(new MaintenancePolicy(true, "dev", 5, "Sat 01:00-02:00", default, ""), "tester");
    Assert(policy.AutomaticUpdates && policy.Channel == "dev" && policy.RetainBackups == 5, "maintenance policy");
    var job = store.Queue(new UpdateRequest("2.0.0", "dev", true, "UPDATE SIRK CENTRAL"), "tester");
    Assert(job.State == "queued" && job.DryRun, "update queue");
    Expect<InvalidOperationException>(() => store.Queue(new UpdateRequest("2.0.1", "dev", true, "UPDATE SIRK CENTRAL"), "tester"));
    store.Complete(job.Id, true, null);
    var reopened = new OperationsStore(options);
    Assert(reopened.Jobs().Single().State == "completed", "operations persistence");

    var publicKey = Convert.FromBase64String("nWG8YCVQdKDVL7AEBI8HsNVat3uwNl9WMQ1oMa2j09Y=");
    var metadata = PortalReleaseCatalog.Validate(new PortalReleaseMetadata(
        1, "sirk-portal", "2.0.0", "stable",
        "https://github.com/Eris92/SIRK-Portal/releases/download/v2.0.0/SIRK-Portal-2.0.0-win-x64.zip",
        new string('A', 64), "win-x64", DateTimeOffset.UtcNow, "abcdef", "release-key-2026-01",
        "MbE7Q2zt/NwjLrjINUQkT1tqOnbO9IclaUKLL/Z0EX7cpSdWIzcL5OYUivwRZk4Z0gW47jbMh+S175RbspZmBA=="),
        "stable", publicKey, requireSignature: true);
    Assert(metadata.Channel == "stable" && metadata.Sha256 == new string('A', 64), "signed release metadata validation");
    Expect<InvalidDataException>(() => PortalReleaseCatalog.Validate(metadata with { PackageUrl = "https://evil.invalid/file.zip" }, "stable", publicKey, true));
    Expect<InvalidDataException>(() => PortalReleaseCatalog.Validate(metadata with { Version = "2.0.1" }, "stable", publicKey, true));
    Expect<InvalidDataException>(() => PortalReleaseCatalog.Validate(metadata with { Signature = null }, "stable", publicKey, true));

    var relay = new PortalTunnelRelay();
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    var pending = relay.RequestAsync("portal-one", "GET", "/healthz", [], [], timeout.Token);
    var request = relay.Poll("portal-one").Single();
    Assert(request.Path == "/healthz", "tunnel poll");
    Assert(!relay.Complete("portal-two", request.Id, new TunnelResponseInput(200, "application/json", null, Convert.ToBase64String("{}"u8.ToArray()))), "cross-portal response blocked");
    Assert(relay.Complete("portal-one", request.Id, new TunnelResponseInput(200, "application/json", null, Convert.ToBase64String("{}"u8.ToArray()))), "tunnel completion");
    var response = await pending;
    Assert(response.StatusCode == 200 && response.ContentType == "application/json", "tunnel response");

    var leaseOptions = Options.Create(new SecurityOptions { Enabled = true, DataRoot = root, RequireSingleWriterLease = true });
    using (var lease = new SingleWriterLease(leaseOptions))
    {
        Expect<InvalidOperationException>(() => new SingleWriterLease(leaseOptions));
    }
    using var reopenedLease = new SingleWriterLease(leaseOptions);

    if (!OperatingSystem.IsWindows())
    {
        var mode = File.GetUnixFileMode(Path.Combine(root, "operations.net10.json"));
        Assert((mode & (UnixFileMode.GroupRead | UnixFileMode.OtherRead | UnixFileMode.GroupWrite | UnixFileMode.OtherWrite)) == 0, "operations mode 0600");
        var leaseMode = File.GetUnixFileMode(Path.Combine(root, ".sirk-central-writer.lock"));
        Assert((leaseMode & (UnixFileMode.GroupRead | UnixFileMode.OtherRead | UnixFileMode.GroupWrite | UnixFileMode.OtherWrite)) == 0, "lease mode 0600");
    }

    Console.WriteLine("OPERATIONS_TUNNEL_TESTS_PASS");
}
finally
{
    Directory.Delete(root, true);
}

static void Assert(bool condition, string name)
{
    if (!condition) throw new Exception("Assertion failed: " + name);
}

static void Expect<T>(Action action) where T : Exception
{
    try { action(); }
    catch (T) { return; }
    throw new Exception("Expected exception: " + typeof(T).Name);
}
