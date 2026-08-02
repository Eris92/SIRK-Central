using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sirk.Central.Organizations;
using Sirk.Central.Portals;
using Sirk.Central.Security;

var root = Path.Combine(Path.GetTempPath(), $"sirk-central-organizations-{Guid.NewGuid():N}");
Directory.CreateDirectory(root);
try
{
    var security = Options.Create(new SecurityOptions { Enabled = true, DataRoot = Path.Combine(root, "security") });
    var organizations = new OrganizationStore(security);
    var tenant = organizations.Create("tenant", new OrganizationCreateRequest("tenant-a", "Tenant A", null, null), "admin");
    var customer = organizations.Create("customer", new OrganizationCreateRequest("customer-a", "Customer A", tenant.Id, null), "admin");
    var site = organizations.Create("site", new OrganizationCreateRequest("site-a", "Site A", null, customer.Id), "admin");

    organizations.ValidateHierarchy(tenant.Id, customer.Id, site.Id);
    AssertThrows<InvalidOperationException>(() => organizations.SetStatus(tenant.Id, "disabled", "admin"),
        "Active child objects must block tenant disable.");
    AssertThrows<InvalidOperationException>(() => organizations.Remove(customer.Id, "admin"),
        "Customer with a site must not be deleted.");
    AssertThrows<InvalidOperationException>(() => organizations.Create(
        "customer", new OrganizationCreateRequest("customer-a", "Duplicate", tenant.Id, null), "admin"),
        "Duplicate customer code in tenant must be rejected.");

    var portalRoot = Path.Combine(root, "portal");
    var portalOptions = Options.Create(new PortalProtocolOptions
    {
        DataRoot = portalRoot,
        TokenHashIterations = 100_000
    });
    var portals = new FilePortalRegistry(portalOptions, NullLogger<FilePortalRegistry>.Instance);
    portals.Create("portal-01", "Portal 01");
    var assignments = new PortalAssignmentStore(security, organizations, portals);
    var assignment = assignments.Assign(
        "portal-01",
        new PortalAssignmentRequest(tenant.Id, customer.Id, site.Id),
        "admin");
    Assert(assignment.SiteId == site.Id, "Portal assignment did not preserve canonical hierarchy.");

    var otherTenant = organizations.Create("tenant", new OrganizationCreateRequest("tenant-b", "Tenant B", null, null), "admin");
    AssertThrows<InvalidOperationException>(() => assignments.Assign(
        "portal-01",
        new PortalAssignmentRequest(otherTenant.Id, customer.Id, site.Id),
        "admin"),
        "Cross-tenant Portal assignment must be rejected.");
    AssertThrows<KeyNotFoundException>(() => assignments.Assign(
        "portal-missing",
        new PortalAssignmentRequest(tenant.Id, customer.Id, site.Id),
        "admin"),
        "Unknown Portal assignment must be rejected.");

    var reloadedOrganizations = new OrganizationStore(security);
    reloadedOrganizations.ValidateHierarchy(tenant.Id, customer.Id, site.Id);
    var reloadedAssignments = new PortalAssignmentStore(security, reloadedOrganizations, portals);
    Assert(reloadedAssignments.Get("portal-01")?.CustomerId == customer.Id,
        "Portal assignment did not survive restart.");

    AssertProtected(Path.Combine(security.Value.DataRoot, "organizations.net10.json"));
    AssertProtected(Path.Combine(security.Value.DataRoot, "portal-assignments.net10.json"));
    Console.WriteLine("SIRK Central organization hierarchy and Portal assignment contracts: OK");
}
finally
{
    if (Directory.Exists(root)) Directory.Delete(root, true);
}

static void AssertProtected(string path)
{
    if (OperatingSystem.IsWindows()) return;
    var forbidden = UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute |
                    UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;
    Assert((File.GetUnixFileMode(path) & forbidden) == 0, "Protected organization file permissions are too broad.");
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
