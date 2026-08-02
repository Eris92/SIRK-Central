using System.Security.Claims;
using Microsoft.Extensions.Options;
using Sirk.Central.Access;
using Sirk.Central.Security;

var root = Path.Combine(Path.GetTempPath(), $"sirk-access-tests-{Guid.NewGuid():N}");
Directory.CreateDirectory(root);
try
{
    var options = Options.Create(new SecurityOptions { Enabled = true, DataRoot = root, PasswordHashIterations = 100_000 });
    var store = new IdentityAccessStore(options);
    var breakGlass = Actor("breakglass", SirkRoles.BreakGlass, "local-break-glass");
    var admin = Actor("admin-1", SirkRoles.Admin, "entra");
    var secAdmin = Actor("secadmin-1", SirkRoles.SecAdmin, "entra");

    var engineer = store.CreateLocal(new CreateLocalIdentityRequest("engineer", "Engineer L3", "Correct-Horse-Battery-42", SirkRoles.EngineerL3), admin);
    Assert(engineer.Password is null && engineer.Role == SirkRoles.EngineerL3, "Local identity creation or password redaction failed.");
    Assert(store.AuthenticateLocal("engineer", "Correct-Horse-Battery-42")?.Key == "local:engineer", "Local authentication failed.");
    Assert(store.AuthenticateLocal("engineer", "wrong-password") is null, "Invalid password was accepted.");

    AssertThrows<UnauthorizedAccessException>(() =>
        store.CreateLocal(new CreateLocalIdentityRequest("forbidden", "Forbidden", "Correct-Horse-Battery-43", SirkRoles.SecAdmin), admin),
        "Admin assigned SecAdmin.");
    var secondSecAdmin = store.CreateLocal(new CreateLocalIdentityRequest("secadmin2", "Second SecAdmin", "Correct-Horse-Battery-44", SirkRoles.SecAdmin), secAdmin);
    Assert(secondSecAdmin.Role == SirkRoles.SecAdmin, "SecAdmin could not assign SecAdmin to another identity.");
    AssertThrows<UnauthorizedAccessException>(() => store.SetEnabled(secondSecAdmin.Key, false, secAdmin), "SecAdmin disabled another SecAdmin.");
    Assert(!store.SetEnabled(secondSecAdmin.Key, false, breakGlass).Enabled, "Break Glass could not disable SecAdmin.");

    var tenantId = Guid.NewGuid();
    var objectId = Guid.NewGuid();
    var entra = store.ResolveEntra($"{tenantId:D}:{objectId:D}", "user@example.com", "Entra User", [SirkRoles.SecAdmin]);
    Assert(entra.Status == "pending" && entra.RequestedRole == SirkRoles.SecAdmin && entra.Role is null, "Privileged Entra role bypassed approval.");
    AssertThrows<UnauthorizedAccessException>(() => store.DecideEntraRole(entra.Key, "approve", admin), "Admin approved SecAdmin claim.");
    entra = store.DecideEntraRole(entra.Key, "approve", breakGlass);
    Assert(entra.Status == "active" && entra.Role == SirkRoles.SecAdmin, "Break Glass approval failed.");

    store.SaveTeam(new AccessTeamRequest(
        "support-team", "Support Team", "Scoped support", [engineer.Key], ["portal-001"],
        new Dictionary<string, string> { ["device.files.write"] = "approval" }));
    store.SavePortalPolicy("portal-001", new Dictionary<string, string> { ["device.terminal.execute"] = "deny" });
    var effective = store.Effective(engineer, "portal-001");
    Assert(effective.Allowed, "Assigned team did not grant portal access.");
    Assert(effective.Capabilities["device.terminal.execute"] == "deny", "Portal deny did not override role/team allow.");
    Assert(effective.Capabilities["device.files.write"] == "approval", "Team approval did not restrict role allow.");
    Assert(!store.Effective(engineer, "portal-002").Allowed, "Unassigned portal was accessible.");

    var reloaded = new IdentityAccessStore(options);
    Assert(reloaded.AuthenticateLocal("engineer", "Correct-Horse-Battery-42") is not null, "Identity store did not survive restart.");
    Assert(reloaded.ListTeams().Single().Id == "support-team", "Access store did not survive restart.");
    AssertProtected(Path.Combine(root, "managed-identities.net10.json"));
    AssertProtected(Path.Combine(root, "access-control.net10.json"));

    Console.WriteLine("SIRK Central identity, role separation and effective access contracts: OK");
}
finally
{
    if (Directory.Exists(root)) Directory.Delete(root, true);
}

static ClaimsPrincipal Actor(string id, string role, string source)
{
    var identity = new ClaimsIdentity([
        new Claim(ClaimTypes.NameIdentifier, id),
        new Claim(ClaimTypes.Name, id),
        new Claim(ClaimTypes.Role, role),
        new Claim("sirk:identity_source", source)
    ], "test", ClaimTypes.Name, ClaimTypes.Role);
    return new ClaimsPrincipal(identity);
}

static void AssertProtected(string path)
{
    Assert(File.Exists(path), $"Protected store is missing: {path}");
    if (OperatingSystem.IsWindows()) return;
    var forbidden = UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute |
                    UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;
    Assert((File.GetUnixFileMode(path) & forbidden) == 0, $"Weak permissions on {path}.");
}

static void AssertThrows<T>(Action action, string message) where T : Exception
{
    try { action(); }
    catch (T) { return; }
    throw new InvalidOperationException(message);
}

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
