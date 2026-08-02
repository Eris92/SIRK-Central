using System.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sirk.Central.Backup;
using Sirk.Central.Security;

var root = Path.Combine(Path.GetTempPath(), $"sirk-central-backup-archive-{Guid.NewGuid():N}");
Directory.CreateDirectory(root);

const string password = "Correct-Horse-Battery-Staple-2026";
const string wrongPassword = "Wrong-Horse-Battery-Staple-2026";

try
{
    var identityFile = Path.Combine(root, "age-identity.txt");
    await RunAsync("age-keygen", ["-o", identityFile]);
    var recipient = (await RunAsync("age-keygen", ["-y", identityFile])).Trim();
    var identity = await File.ReadAllTextAsync(identityFile);
    File.Delete(identityFile);

    var options = new SecurityOptions
    {
        Enabled = true,
        DataRoot = root,
        IdentityFileName = "identity.net10.json",
        AuditFileName = "security-audit.net10.jsonl",
        AuditKeyFileName = "security-audit.net10.key",
        DataProtectionDirectoryName = "data-protection",
        PasswordHashIterations = 100_000,
        SessionMinutes = 30,
        LoginAttemptsPerFiveMinutes = 5
    };

    var markerPath = Path.Combine(root, "payload", "marker.txt");
    Directory.CreateDirectory(Path.GetDirectoryName(markerPath)!);
    await File.WriteAllTextAsync(markerPath, "before-backup");
    await File.WriteAllTextAsync(Path.Combine(root, options.IdentityFileName), "identity-state");

    var keyStore = new BackupKeyStore(Options.Create(options));
    keyStore.SetIdentity(identity, recipient, password, "backup-archive-test", rotate: true);

    var service = new BackupArchiveService(
        Options.Create(options),
        keyStore,
        NullLogger<BackupArchiveService>.Instance);

    var backup = await service.CreateAsync(CancellationToken.None);
    Assert(backup.Size > 0, "Encrypted backup is empty.");
    Assert(service.List().Count == 1, "Encrypted backup was not listed.");

    await File.WriteAllTextAsync(markerPath, "after-backup");
    await File.WriteAllTextAsync(Path.Combine(root, "unexpected.txt"), "must-disappear");

    await AssertThrowsAsync<UnauthorizedAccessException>(
        () => service.RestoreAsync(backup.FileName, wrongPassword, CancellationToken.None),
        "Restore with a wrong Break-Glass password must fail closed.");
    Assert(await File.ReadAllTextAsync(markerPath) == "after-backup",
        "Failed restore changed live data.");

    await service.RestoreAsync(backup.FileName, password, CancellationToken.None);
    Assert(await File.ReadAllTextAsync(markerPath) == "before-backup",
        "Restore did not recover the archived payload.");
    Assert(!File.Exists(Path.Combine(root, "unexpected.txt")),
        "Restore did not remove data created after the backup.");
    Assert(Directory.EnumerateDirectories(Path.GetTempPath(), "sirk-central-restore-*", SearchOption.TopDirectoryOnly)
        .All(path => !Directory.Exists(path)), "Restore transaction directory was not cleaned up.");

    Console.WriteLine("SIRK Central encrypted archive create/restore contracts: OK");
}
finally
{
    if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
}

static async Task<string> RunAsync(string fileName, IReadOnlyList<string> arguments)
{
    var start = new ProcessStartInfo(fileName)
    {
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false,
        CreateNoWindow = true
    };
    foreach (var argument in arguments) start.ArgumentList.Add(argument);
    using var process = Process.Start(start) ?? throw new InvalidOperationException($"Could not start {fileName}.");
    var stdout = process.StandardOutput.ReadToEndAsync();
    var stderr = process.StandardError.ReadToEndAsync();
    await process.WaitForExitAsync();
    var output = await stdout;
    var error = await stderr;
    if (process.ExitCode != 0)
        throw new InvalidOperationException($"{fileName} failed: {error}");
    return output;
}

static async Task AssertThrowsAsync<TException>(Func<Task> action, string message)
    where TException : Exception
{
    try
    {
        await action();
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
