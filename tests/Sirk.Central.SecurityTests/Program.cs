using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;

var root = Path.Combine(
    Path.GetTempPath(),
    $"sirk-central-security-{Guid.NewGuid():N}");
Directory.CreateDirectory(root);

const string userName = "breakglass";
const string password = "Correct-Horse-Battery-Staple-2026";
const string accessCode = "0123456789abcdef0123456789ABCDEF";

try
{
    var bootstrapPath = Path.Combine(root, "break-glass-bootstrap.json");
    File.WriteAllText(
        bootstrapPath,
        """
        {
          "userName": "breakglass",
          "password": "Correct-Horse-Battery-Staple-2026",
          "accessCode": "0123456789abcdef0123456789ABCDEF"
        }
        """,
        new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    SecureFile(bootstrapPath);

    var securityOptions = new SecurityOptions
    {
        Enabled = true,
        DataRoot = root,
        IdentityFileName = "identity.net10.json",
        AuditFileName = "security-audit.net10.jsonl",
        AuditKeyFileName = "security-audit.net10.key",
        DataProtectionDirectoryName = "data-protection",
        BootstrapSecretFile = bootstrapPath,
        PasswordHashIterations = 100_000,
        SessionMinutes = 30,
        LoginAttemptsPerFiveMinutes = 5
    };

    var store = new LocalIdentityStore(
        Options.Create(securityOptions),
        NullLogger<LocalIdentityStore>.Instance);

    Assert(!File.Exists(bootstrapPath), "One-time bootstrap secret file must be deleted.");
    var identityPath = Path.Combine(root, securityOptions.IdentityFileName);
    Assert(File.Exists(identityPath), "Break-Glass identity store was not created.");
    AssertProtectedFile(identityPath);

    var identityText = File.ReadAllText(identityPath);
    Assert(!identityText.Contains(password, StringComparison.Ordinal), "Identity store exposes the password.");
    Assert(!identityText.Contains(accessCode, StringComparison.Ordinal), "Identity store exposes the access code.");
    Assert(identityText.Contains("PBKDF2-SHA256", StringComparison.Ordinal), "Identity store hash algorithm is invalid.");

    var identity = store.Authenticate(userName, password, accessCode);
    Assert(identity is not null, "Correct Break-Glass credentials must authenticate.");
    Assert(identity!.Roles.SequenceEqual([SirkRoles.BreakGlass]), "Break-Glass role is invalid.");
    Assert(store.Authenticate(userName, password + "x", accessCode) is null, "Wrong password must fail.");
    Assert(store.Authenticate(userName, password, accessCode + "x") is null, "Wrong access code must fail.");
    Assert(store.Authenticate("other-user", password, accessCode) is null, "Wrong user name must fail.");

    var reloadedStore = new LocalIdentityStore(
        Options.Create(securityOptions),
        NullLogger<LocalIdentityStore>.Instance);
    var reloadedIdentity = reloadedStore.Authenticate(userName, password, accessCode);
    Assert(reloadedIdentity?.Id == identity.Id, "Break-Glass identity must survive restart.");

    var audit = new SecurityAuditLog(Options.Create(securityOptions));
    var first = audit.Write(new SecurityAuditEvent(
        identity.Id,
        identity.UserName,
        "authentication.break-glass",
        "session",
        identity.Id,
        true,
        "127.0.0.1",
        "security-test-1",
        new Dictionary<string, string>
        {
            ["result"] = "accepted"
        }));
    var second = audit.Write(new SecurityAuditEvent(
        identity.Id,
        identity.UserName,
        "portal.token.rotate",
        "portal",
        "portal-test",
        true,
        "127.0.0.1",
        "security-test-2"));

    Assert(!string.IsNullOrWhiteSpace(first.Mac), "First audit MAC is empty.");
    Assert(second.PreviousMac == first.Mac, "Audit chain does not reference the previous MAC.");
    Assert(audit.VerifyIntegrity() == second.Mac, "Audit integrity verification returned the wrong head.");

    var auditPath = Path.Combine(root, securityOptions.AuditFileName);
    var auditKeyPath = Path.Combine(root, securityOptions.AuditKeyFileName);
    AssertProtectedFile(auditPath);
    AssertProtectedFile(auditKeyPath);
    var auditText = File.ReadAllText(auditPath);
    Assert(!auditText.Contains(password, StringComparison.Ordinal), "Audit log exposes the password.");
    Assert(!auditText.Contains(accessCode, StringComparison.Ordinal), "Audit log exposes the access code.");

    var reloadedAudit = new SecurityAuditLog(Options.Create(securityOptions));
    Assert(reloadedAudit.VerifyIntegrity() == second.Mac, "Audit chain must survive restart.");

    var tampered = auditText.Replace(
        "authentication.break-glass",
        "authentication.tampered",
        StringComparison.Ordinal);
    Assert(tampered != auditText, "Audit tamper test did not modify the log.");
    File.WriteAllText(
        auditPath,
        tampered,
        new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    SecureFile(auditPath);
    AssertThrows<InvalidDataException>(
        () => _ = new SecurityAuditLog(Options.Create(securityOptions)),
        "Tampered audit log must be rejected.");

    Console.WriteLine("SIRK Central Break-Glass identity and audit contracts: OK");
}
finally
{
    Directory.Delete(root, recursive: true);
}

static void AssertProtectedFile(string path)
{
    if (OperatingSystem.IsWindows())
    {
        return;
    }

    var mode = File.GetUnixFileMode(path);
    var forbidden =
        UnixFileMode.GroupRead |
        UnixFileMode.GroupWrite |
        UnixFileMode.GroupExecute |
        UnixFileMode.OtherRead |
        UnixFileMode.OtherWrite |
        UnixFileMode.OtherExecute;
    Assert((mode & forbidden) == 0, $"Protected file has weak Unix permissions: {path} ({mode}).");
}

static void SecureFile(string path)
{
    if (!OperatingSystem.IsWindows())
    {
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
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
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}
