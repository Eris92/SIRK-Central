namespace Sirk.Central.Security;

internal sealed class SecurityOptions
{
    public const string SectionName = "Sirk:Security";

    public bool Enabled { get; set; }

    public string DataRoot { get; set; } = Path.Combine(AppContext.BaseDirectory, "data", "security");

    public string IdentityFileName { get; set; } = "identity.net10.json";

    public string AuditFileName { get; set; } = "security-audit.net10.jsonl";

    public string AuditKeyFileName { get; set; } = "security-audit.net10.key";

    public string DataProtectionDirectoryName { get; set; } = "data-protection";

    public string BootstrapSecretFile { get; set; } = string.Empty;

    public int PasswordHashIterations { get; set; } = 600_000;

    public int SessionMinutes { get; set; } = 30;

    public int LoginAttemptsPerFiveMinutes { get; set; } = 5;
}

internal static class SirkRoles
{
    public const string BreakGlass = "BreakGlass";
    public const string SecAdmin = "SecAdmin";
    public const string Admin = "Admin";
    public const string Auditor = "Auditor";
    public const string Operator = "Operator";
}

internal static class SirkPolicies
{
    public const string PortalManagement = "Sirk.PortalManagement";
    public const string SecurityAdministration = "Sirk.SecurityAdministration";
    public const string AuditRead = "Sirk.AuditRead";
}
