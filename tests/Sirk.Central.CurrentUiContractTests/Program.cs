var root = FindRepositoryRoot();
var endpointRegistration = File.ReadAllText(Path.Combine(root, "src", "Sirk.Central", "Access", "IdentityAccessV2Endpoints.cs"));
var adapter = File.ReadAllText(Path.Combine(root, "src", "Sirk.Central", "Ui", "CurrentUiEndpoints.cs"));
var bootstrap = File.ReadAllText(Path.Combine(root, "public", "workspace-bootstrap.js"));
var csrf = File.ReadAllText(Path.Combine(root, "public", "csrf-bootstrap.js"));
var classic = File.ReadAllText(Path.Combine(root, "public", "app.js"));

Require(endpointRegistration.Contains("endpoints.MapCurrentUiApi();", StringComparison.Ordinal),
    "The current permissions UI API is not registered with the canonical identity/access module.");
Require(adapter.Contains("MapGroup(\"/api/access-control\")", StringComparison.Ordinal),
    "The classic permissions UI access-control adapter is missing.");
Require(adapter.Contains("access.MapPost(\"/teams\", SaveTeamAsync);", StringComparison.Ordinal) &&
        adapter.Contains("access.MapPut(\"/teams\", SaveTeamAsync);", StringComparison.Ordinal),
    "The classic team form must be able to save through its current POST shape and canonical PUT shape.");
Require(adapter.Contains("NormalizeClassicMemberKey", StringComparison.Ordinal) &&
        adapter.Contains("local:local:", StringComparison.Ordinal) &&
        adapter.Contains("entra:entra:", StringComparison.Ordinal),
    "The compatibility layer must normalize legacy duplicate member-key prefixes.");
Require(adapter.Contains("ConnectPortalAsync", StringComparison.Ordinal) &&
        adapter.Contains("ValidateCsrfAsync(context, antiforgery)", StringComparison.Ordinal) &&
        adapter.Contains("ResolveEffectiveAccess", StringComparison.Ordinal),
    "Classic Portal connect must preserve CSRF and effective-access enforcement.");
Require(adapter.Contains("users = UiUsers(store)", StringComparison.Ordinal) &&
        adapter.Contains("portals,", StringComparison.Ordinal) &&
        adapter.Contains("teams = store.ListTeams()", StringComparison.Ordinal) &&
        adapter.Contains("capabilities = IdentityAccessStore.Capabilities", StringComparison.Ordinal),
    "The team editor snapshot must contain users, Portals, teams and capabilities.");
Require(bootstrap.Contains("/api/v1/auth/local/login", StringComparison.Ordinal) &&
        bootstrap.Contains("managed-local", StringComparison.Ordinal) &&
        bootstrap.Contains("permissionsForRole", StringComparison.Ordinal),
    "Managed local accounts must be able to sign in through the current UI without a Break-Glass access code.");
Require(bootstrap.Contains("normalizeClassicAccessSnapshot", StringComparison.Ordinal),
    "Classic team-member identity keys must be normalized before rendering checkboxes.");
Require(csrf.Contains("path === \"/api/v1/auth/local/login\"", StringComparison.Ordinal),
    "Managed local login must remain an anonymous write in the CSRF bootstrap.");
Require(classic.Contains("api(\"/api/access-control\")", StringComparison.Ordinal) &&
        classic.Contains("method:\"POST\"", StringComparison.Ordinal),
    "The regression contract must continue to cover the currently deployed classic permissions UI shape.");

Console.WriteLine("SIRK Central current permissions UI team, local-login and RBAC contracts: OK");

static string FindRepositoryRoot()
{
    var current = new DirectoryInfo(Directory.GetCurrentDirectory());
    while (current is not null)
    {
        if (File.Exists(Path.Combine(current.FullName, "Directory.Build.props")) &&
            Directory.Exists(Path.Combine(current.FullName, "src", "Sirk.Central")))
            return current.FullName;
        current = current.Parent;
    }
    throw new DirectoryNotFoundException("Repository root was not found.");
}

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
