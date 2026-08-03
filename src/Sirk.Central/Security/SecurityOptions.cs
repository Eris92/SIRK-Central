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
    public string DataProtectionCertificatePath { get; set; } = string.Empty;
    public string DataProtectionCertificatePasswordFile { get; set; } = string.Empty;
    public bool RequireProtectedDataProtectionKeys { get; set; } = true;
    public string BootstrapSecretFile { get; set; } = string.Empty;
    public int PasswordHashIterations { get; set; } = 600_000;
    public int SessionMinutes { get; set; } = 30;
    public int LoginAttemptsPerFiveMinutes { get; set; } = 5;
    public bool RequireSingleWriterLease { get; set; } = true;
    public string WriterLeaseFileName { get; set; } = ".sirk-central-writer.lock";
    public string ReleaseSigningPublicKeyFile { get; set; } = string.Empty;
    public bool RequireSignedReleases { get; set; } = true;
}

internal static class SirkRoles
{
    public const string BreakGlass = "BreakGlass";
    public const string SecAdmin = "SecAdmin";
    public const string Admin = "Admin";
    public const string Auditor = "Auditor";
    public const string OperatorL1 = "OperatorL1";
    public const string SupportL2 = "SupportL2";
    public const string EngineerL3 = "EngineerL3";
    public const string Operator = OperatorL1;

    public static readonly IReadOnlySet<string> Assignable = new HashSet<string>(StringComparer.Ordinal)
    {
        Auditor, OperatorL1, SupportL2, EngineerL3, Admin, SecAdmin
    };

    public static bool IsPrivileged(string? role) => role is Admin or SecAdmin;
}

internal static class SirkPolicies
{
    public const string PortalManagement = "Sirk.PortalManagement";
    public const string SecurityAdministration = "Sirk.SecurityAdministration";
    public const string AuditRead = "Sirk.AuditRead";
}
