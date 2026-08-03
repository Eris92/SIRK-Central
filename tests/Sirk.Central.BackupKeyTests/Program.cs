using System.Text;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;

var root = Path.Combine(Path.GetTempPath(), $"sirk-backup-key-{Guid.NewGuid():N}");
Directory.CreateDirectory(root);

const string oldPassword = "Correct-Horse-Battery-Staple-2026";
const string newPassword = "New-Correct-Horse-Battery-Staple-2026";
const string recipient1 = "age1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const string recipient2 = "age1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const string identity1 = "AGE-SECRET-KEY-1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const string identity2 = "AGE-SECRET-KEY-1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

try
{
    var options = Options.Create(new SecurityOptions
    {
        Enabled = true,
        DataRoot = root,
        IdentityFileName = "identity.json",
        AuditFileName = "audit.jsonl",
        AuditKeyFileName = "audit.key",
        DataProtectionDirectoryName = "dp",
        PasswordHashIterations = 100_000,
        SessionMinutes = 30,
        LoginAttemptsPerFiveMinutes = 5
    });
    var store = new BackupKeyStore(options);

    Assert(!store.GetStatus().Configured, "Fresh backup key store must be empty.");
    var created = store.SetIdentity(identity1, recipient1, oldPassword, "breakglass", rotate: true);
    Assert(created.Configured && created.Rotation == 1, "Initial encrypted key generation is invalid.");
    Assert(store.Unlock(oldPassword).Identity.Trim() == identity1, "Initial key cannot be unlocked.");
    AssertThrows<UnauthorizedAccessException>(() => store.Unlock(oldPassword + "x"),
        "Wrong password must not unlock the key.");

    var keyPath = Path.Combine(root, "backup-key.json");
    var encrypted = File.ReadAllText(keyPath, Encoding.UTF8);
    Assert(!encrypted.Contains(identity1, StringComparison.Ordinal), "Persisted store exposes private identity.");
    Assert(!encrypted.Contains(oldPassword, StringComparison.Ordinal), "Persisted store exposes password.");
    AssertProtectedFile(keyPath);

    var rewrapped = store.Rewrap(oldPassword, newPassword, "breakglass");
    Assert(rewrapped.Rotation == 1, "Password rewrap must not rotate the age identity.");
    AssertThrows<UnauthorizedAccessException>(() => store.Unlock(oldPassword),
        "Old password must fail after rewrap.");
    Assert(store.Unlock(newPassword).Identity.Trim() == identity1,
        "New password must unlock the existing identity.");

    var rotated = store.SetIdentity(identity2, recipient2, newPassword, "breakglass", rotate: true);
    Assert(rotated.Rotation == 2, "Explicit key rotation must increment generation.");
    var unlocked = store.Unlock(newPassword);
    Assert(unlocked.Identity.Trim() == identity2 && unlocked.Recipient == recipient2,
        "Rotated identity or recipient is invalid.");

    var export = Encoding.UTF8.GetString(store.ExportEncrypted());
    Assert(export.Contains("sirk-central-encrypted-backup-key", StringComparison.Ordinal),
        "Encrypted export format marker is missing.");
    Assert(!export.Contains(identity2, StringComparison.Ordinal) &&
           !export.Contains(newPassword, StringComparison.Ordinal),
        "Encrypted export exposes a plaintext secret.");

    var restarted = new BackupKeyStore(options);
    Assert(restarted.Unlock(newPassword).Identity.Trim() == identity2,
        "Encrypted key must survive runtime restart.");
    Assert(restarted.GetStatus().Rotation == 2, "Rotation generation must survive restart.");

    Console.WriteLine("SIRK Central encrypted backup key lifecycle contracts: OK");
}
finally
{
    Directory.Delete(root, recursive: true);
}

static void AssertProtectedFile(string path)
{
    if (OperatingSystem.IsWindows()) return;
    var forbidden = UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute |
                    UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;
    Assert((File.GetUnixFileMode(path) & forbidden) == 0,
        $"Protected file has weak permissions: {path}");
}

static void AssertThrows<TException>(Action action, string message) where TException : Exception
{
    try { action(); }
    catch (TException) { return; }
    throw new InvalidOperationException(message);
}

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
