using System.Diagnostics;
using System.Formats.Tar;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;

namespace Sirk.Central.Backup;

internal sealed record BackupArchiveInfo(
    string FileName,
    long Size,
    string Sha256,
    string Recipient,
    int KeyRotation,
    DateTimeOffset CreatedAtUtc);

internal sealed class BackupArchiveService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly SemaphoreSlim _operationLock = new(1, 1);
    private readonly SecurityOptions _security;
    private readonly BackupKeyStore _keyStore;
    private readonly ILogger<BackupArchiveService> _logger;
    private readonly string _backupRoot;

    public BackupArchiveService(
        IOptions<SecurityOptions> options,
        BackupKeyStore keyStore,
        ILogger<BackupArchiveService> logger)
    {
        _security = options.Value;
        _keyStore = keyStore;
        _logger = logger;
        _backupRoot = Path.Combine(_security.DataRoot, "backups");
        Directory.CreateDirectory(_backupRoot);
        SecureDirectory(_backupRoot);
    }

    public IReadOnlyList<BackupArchiveInfo> List()
    {
        Directory.CreateDirectory(_backupRoot);
        return Directory.EnumerateFiles(_backupRoot, "*.tar.gz.age", SearchOption.TopDirectoryOnly)
            .Select(ReadInfo)
            .Where(item => item is not null)
            .Cast<BackupArchiveInfo>()
            .OrderByDescending(item => item.CreatedAtUtc)
            .ToArray();
    }

    public async Task<BackupArchiveInfo> CreateAsync(CancellationToken cancellationToken)
    {
        await _operationLock.WaitAsync(cancellationToken);
        try
        {
            var status = _keyStore.GetStatus();
            if (!status.Configured)
                throw new InvalidOperationException("Encrypted backup key is not configured.");

            var stamp = DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmss");
            var baseName = $"sirk-central-{stamp}-{Guid.NewGuid():N}";
            var temporaryTar = Path.Combine(_backupRoot, $".{baseName}.tar.gz.tmp");
            var temporaryEncrypted = Path.Combine(_backupRoot, $".{baseName}.age.tmp");
            var finalEncrypted = Path.Combine(_backupRoot, $"{baseName}.tar.gz.age");
            var metadataPath = finalEncrypted + ".json";

            try
            {
                await CreateTarGzipAsync(_security.DataRoot, temporaryTar, cancellationToken);
                await RunProcessAsync(
                    "age",
                    ["--encrypt", "--recipient", status.Recipient, "--output", temporaryEncrypted, temporaryTar],
                    cancellationToken);
                SecureFile(temporaryEncrypted);
                var sha256 = await ComputeSha256Async(temporaryEncrypted, cancellationToken);
                File.Move(temporaryEncrypted, finalEncrypted, overwrite: false);
                SecureFile(finalEncrypted);

                var info = new BackupArchiveInfo(
                    Path.GetFileName(finalEncrypted),
                    new FileInfo(finalEncrypted).Length,
                    sha256,
                    status.Recipient,
                    status.Rotation,
                    DateTimeOffset.UtcNow);
                await AtomicJsonAsync(metadataPath, info, cancellationToken);
                return info;
            }
            finally
            {
                File.Delete(temporaryTar);
                File.Delete(temporaryEncrypted);
            }
        }
        finally
        {
            _operationLock.Release();
        }
    }

    public async Task RestoreAsync(
        string fileName,
        string breakGlassPassword,
        CancellationToken cancellationToken)
    {
        await _operationLock.WaitAsync(cancellationToken);
        try
        {
            var archivePath = ResolveArchive(fileName);
            var info = ReadInfo(archivePath)
                ?? throw new InvalidDataException("Backup metadata is missing or invalid.");
            var actualSha256 = await ComputeSha256Async(archivePath, cancellationToken);
            if (!CryptographicOperations.FixedTimeEquals(
                    Convert.FromHexString(actualSha256),
                    Convert.FromHexString(info.Sha256)))
                throw new InvalidDataException("Backup checksum validation failed.");

            var unlocked = _keyStore.Unlock(breakGlassPassword);
            if (!string.Equals(unlocked.Recipient, info.Recipient, StringComparison.Ordinal))
                throw new InvalidDataException("Backup recipient does not match the active encrypted key.");

            var operationRoot = Path.Combine(Path.GetTempPath(), $"sirk-central-restore-{Guid.NewGuid():N}");
            var identityPath = Path.Combine(operationRoot, "identity.agekey");
            var decryptedTar = Path.Combine(operationRoot, "restore.tar.gz");
            var stagingRoot = Path.Combine(operationRoot, "staging");
            var safetyRoot = Path.Combine(operationRoot, "safety");
            Directory.CreateDirectory(operationRoot);
            SecureDirectory(operationRoot);

            try
            {
                await File.WriteAllTextAsync(identityPath, unlocked.Identity, new UTF8Encoding(false), cancellationToken);
                SecureFile(identityPath);
                await RunProcessAsync(
                    "age",
                    ["--decrypt", "--identity", identityPath, "--output", decryptedTar, archivePath],
                    cancellationToken);

                Directory.CreateDirectory(stagingRoot);
                await ExtractValidatedAsync(decryptedTar, stagingRoot, cancellationToken);
                ValidateStaging(stagingRoot);

                CopyDirectory(_security.DataRoot, safetyRoot, excludeBackups: true);
                try
                {
                    ReplaceData(stagingRoot);
                }
                catch
                {
                    ReplaceData(safetyRoot);
                    throw;
                }
            }
            finally
            {
                TryDeleteDirectory(operationRoot);
            }
        }
        finally
        {
            _operationLock.Release();
        }
    }

    private async Task CreateTarGzipAsync(string sourceRoot, string destination, CancellationToken cancellationToken)
    {
        await using var file = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 128 * 1024, true);
        await using var gzip = new GZipStream(file, CompressionLevel.SmallestSize, leaveOpen: false);
        using var writer = new TarWriter(gzip, leaveOpen: false);

        foreach (var path in Directory.EnumerateFileSystemEntries(sourceRoot, "*", SearchOption.AllDirectories))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (IsBackupPath(path)) continue;
            var relative = Path.GetRelativePath(sourceRoot, path).Replace('\\', '/');
            if (relative.StartsWith("../", StringComparison.Ordinal) || Path.IsPathRooted(relative))
                throw new InvalidDataException("Backup source escaped the data root.");

            if (Directory.Exists(path))
            {
                writer.WriteEntry(new PaxTarEntry(TarEntryType.Directory, relative));
                continue;
            }

            var entry = new PaxTarEntry(TarEntryType.RegularFile, relative)
            {
                DataStream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, true)
            };
            writer.WriteEntry(entry);
            entry.DataStream.Dispose();
        }
    }

    private static async Task ExtractValidatedAsync(string archive, string destination, CancellationToken cancellationToken)
    {
        await using var file = new FileStream(archive, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, true);
        await using var gzip = new GZipStream(file, CompressionMode.Decompress, leaveOpen: false);
        using var reader = new TarReader(gzip, leaveOpen: false);
        TarEntry? entry;
        var root = Path.GetFullPath(destination) + Path.DirectorySeparatorChar;
        while ((entry = reader.GetNextEntry()) is not null)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (entry.EntryType is TarEntryType.SymbolicLink or TarEntryType.HardLink or TarEntryType.BlockDevice or TarEntryType.CharacterDevice or TarEntryType.Fifo)
                throw new InvalidDataException("Backup archive contains an unsupported entry type.");
            var target = Path.GetFullPath(Path.Combine(destination, entry.Name.Replace('/', Path.DirectorySeparatorChar)));
            if (!target.StartsWith(root, StringComparison.Ordinal))
                throw new InvalidDataException("Backup archive contains a path traversal entry.");
            if (entry.EntryType == TarEntryType.Directory)
            {
                Directory.CreateDirectory(target);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            await using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None, 128 * 1024, true);
            if (entry.DataStream is not null)
                await entry.DataStream.CopyToAsync(output, cancellationToken);
        }
    }

    private void ValidateStaging(string stagingRoot)
    {
        var required = Path.Combine(stagingRoot, _security.IdentityFileName);
        if (!File.Exists(required))
            throw new InvalidDataException("Backup does not contain the required identity store.");
    }

    private void ReplaceData(string source)
    {
        foreach (var path in Directory.EnumerateFileSystemEntries(_security.DataRoot, "*", SearchOption.TopDirectoryOnly))
        {
            if (string.Equals(Path.GetFullPath(path), Path.GetFullPath(_backupRoot), StringComparison.Ordinal)) continue;
            if (Directory.Exists(path)) Directory.Delete(path, true); else File.Delete(path);
        }
        CopyDirectory(source, _security.DataRoot, excludeBackups: false);
    }

    private static void CopyDirectory(string source, string destination, bool excludeBackups)
    {
        Directory.CreateDirectory(destination);
        foreach (var directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
        {
            if (excludeBackups && Path.GetFileName(directory).Equals("backups", StringComparison.Ordinal)) continue;
            Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(source, directory)));
        }
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            if (excludeBackups && file.Contains($"{Path.DirectorySeparatorChar}backups{Path.DirectorySeparatorChar}", StringComparison.Ordinal)) continue;
            var target = Path.Combine(destination, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
        }
    }

    private string ResolveArchive(string fileName)
    {
        var leaf = Path.GetFileName(fileName ?? string.Empty);
        if (!string.Equals(leaf, fileName, StringComparison.Ordinal) || !leaf.EndsWith(".tar.gz.age", StringComparison.Ordinal))
            throw new InvalidDataException("Backup file name is invalid.");
        var path = Path.GetFullPath(Path.Combine(_backupRoot, leaf));
        var root = Path.GetFullPath(_backupRoot) + Path.DirectorySeparatorChar;
        if (!path.StartsWith(root, StringComparison.Ordinal) || !File.Exists(path))
            throw new FileNotFoundException("Backup archive was not found.", leaf);
        return path;
    }

    private BackupArchiveInfo? ReadInfo(string archivePath)
    {
        try
        {
            var metadataPath = archivePath + ".json";
            using var stream = new FileStream(metadataPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            var info = JsonSerializer.Deserialize<BackupArchiveInfo>(stream, JsonOptions);
            if (info is null || !string.Equals(info.FileName, Path.GetFileName(archivePath), StringComparison.Ordinal) || info.Size != new FileInfo(archivePath).Length)
                return null;
            return info;
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
            _logger.LogWarning(exception, "Ignored invalid backup metadata for {ArchivePath}.", archivePath);
            return null;
        }
    }

    private static async Task AtomicJsonAsync(string path, object value, CancellationToken cancellationToken)
    {
        var temporary = $"{path}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            await using var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 8192, true);
            await JsonSerializer.SerializeAsync(stream, value, JsonOptions, cancellationToken);
            await stream.FlushAsync(cancellationToken);
            SecureFile(temporary);
            File.Move(temporary, path, false);
            SecureFile(path);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    private static async Task<string> ComputeSha256Async(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, true);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
    }

    private static async Task RunProcessAsync(string fileName, IReadOnlyList<string> arguments, CancellationToken cancellationToken)
    {
        var start = new ProcessStartInfo(fileName)
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException($"Could not start {fileName}.");
        var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);
        var error = await errorTask;
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"{fileName} failed with exit code {process.ExitCode}: {error[..Math.Min(error.Length, 1000)]}");
    }

    private bool IsBackupPath(string path) =>
        Path.GetFullPath(path).StartsWith(Path.GetFullPath(_backupRoot) + Path.DirectorySeparatorChar, StringComparison.Ordinal);

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, true); }
        catch { }
    }

    private static void SecureDirectory(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    private static void SecureFile(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}
