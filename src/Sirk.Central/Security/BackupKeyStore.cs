using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Sirk.Central.Security;

internal sealed record BackupKeyStatus(
    bool Configured,
    string Recipient,
    int Rotation,
    DateTimeOffset? CreatedAtUtc,
    DateTimeOffset? UpdatedAtUtc,
    string UpdatedBy);

internal sealed record UnlockedBackupKey(string Identity, string Recipient);

internal sealed record BackupKeyDocument(
    int SchemaVersion,
    string Recipient,
    string Algorithm,
    string Kdf,
    int Iterations,
    string SaltBase64,
    string NonceBase64,
    string CiphertextBase64,
    string TagBase64,
    int Rotation,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc,
    string UpdatedBy);

internal sealed class BackupKeyStore
{
    private const int SchemaVersion = 1;
    private const int Iterations = 600_000;
    private const int SaltLength = 32;
    private const int NonceLength = 12;
    private const int TagLength = 16;
    private const int KeyLength = 32;
    private const string AadPrefix = "SIRK-Central/backup-key/v1\n";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly object _sync = new();
    private readonly string _path;

    public BackupKeyStore(IOptions<SecurityOptions> options)
    {
        var security = options.Value;
        _path = Path.Combine(security.DataRoot, "backup-key.json");
    }

    public BackupKeyStatus GetStatus()
    {
        lock (_sync)
        {
            var document = ReadOrNull();
            return document is null
                ? new BackupKeyStatus(false, string.Empty, 0, null, null, string.Empty)
                : new BackupKeyStatus(true, document.Recipient, document.Rotation,
                    document.CreatedAtUtc, document.UpdatedAtUtc, document.UpdatedBy);
        }
    }

    public BackupKeyStatus SetIdentity(
        string identity,
        string recipient,
        string password,
        string actor,
        bool rotate)
    {
        ValidateIdentity(identity);
        ValidateRecipient(recipient);
        ValidatePassword(password);

        lock (_sync)
        {
            var existing = ReadOrNull();
            if (existing is not null && !rotate)
            {
                _ = Decrypt(existing, password);
            }

            var now = DateTimeOffset.UtcNow;
            var document = Encrypt(
                identity,
                recipient,
                password,
                existing is null ? 1 : existing.Rotation + (rotate ? 1 : 0),
                existing?.CreatedAtUtc ?? now,
                now,
                actor);
            Write(document);
            return GetStatusUnsafe(document);
        }
    }

    public UnlockedBackupKey Unlock(string password)
    {
        ValidatePassword(password);
        lock (_sync)
        {
            var document = ReadOrNull() ?? throw new InvalidOperationException(
                "Encrypted backup key is not configured.");
            return new UnlockedBackupKey(Decrypt(document, password), document.Recipient);
        }
    }

    public BackupKeyStatus Rewrap(string currentPassword, string newPassword, string actor)
    {
        ValidatePassword(currentPassword);
        ValidatePassword(newPassword);
        lock (_sync)
        {
            var document = ReadOrNull();
            if (document is null)
            {
                return new BackupKeyStatus(false, string.Empty, 0, null, null, string.Empty);
            }

            var identity = Decrypt(document, currentPassword);
            var rewrapped = Encrypt(identity, document.Recipient, newPassword,
                document.Rotation, document.CreatedAtUtc, DateTimeOffset.UtcNow, actor);
            Write(rewrapped);
            return GetStatusUnsafe(rewrapped);
        }
    }

    public byte[] ExportEncrypted()
    {
        lock (_sync)
        {
            var document = ReadOrNull() ?? throw new InvalidOperationException(
                "Encrypted backup key is not configured.");
            var envelope = new
            {
                format = "sirk-central-encrypted-backup-key",
                exportedAtUtc = DateTimeOffset.UtcNow,
                key = document
            };
            return JsonSerializer.SerializeToUtf8Bytes(envelope, JsonOptions);
        }
    }

    private BackupKeyDocument? ReadOrNull()
    {
        if (!File.Exists(_path)) return null;
        using var stream = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var document = JsonSerializer.Deserialize<BackupKeyDocument>(stream, JsonOptions)
            ?? throw new InvalidDataException("Encrypted backup key document is empty.");
        ValidateDocument(document);
        return document;
    }

    private void Write(BackupKeyDocument document)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temporary = $"{_path}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write,
                       FileShare.None, 8192, FileOptions.WriteThrough))
            {
                JsonSerializer.Serialize(stream, document, JsonOptions);
                stream.Flush(true);
            }
            SecureFile(temporary);
            File.Move(temporary, _path, true);
            SecureFile(_path);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    private static BackupKeyDocument Encrypt(string identity, string recipient, string password,
        int rotation, DateTimeOffset created, DateTimeOffset updated, string actor)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltLength);
        var nonce = RandomNumberGenerator.GetBytes(NonceLength);
        var key = Derive(password, salt);
        var plaintext = Encoding.UTF8.GetBytes(identity.Trim() + "\n");
        var ciphertext = new byte[plaintext.Length];
        var tag = new byte[TagLength];
        try
        {
            using var aes = new AesGcm(key, TagLength);
            aes.Encrypt(nonce, plaintext, ciphertext, tag,
                Encoding.UTF8.GetBytes(AadPrefix + recipient));
            return new BackupKeyDocument(SchemaVersion, recipient, "AES-256-GCM",
                "PBKDF2-SHA256", Iterations, Convert.ToBase64String(salt),
                Convert.ToBase64String(nonce), Convert.ToBase64String(ciphertext),
                Convert.ToBase64String(tag), rotation, created, updated,
                (actor ?? "break-glass")[..Math.Min((actor ?? "break-glass").Length, 200)]);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    private static string Decrypt(BackupKeyDocument document, string password)
    {
        var salt = Convert.FromBase64String(document.SaltBase64);
        var nonce = Convert.FromBase64String(document.NonceBase64);
        var ciphertext = Convert.FromBase64String(document.CiphertextBase64);
        var tag = Convert.FromBase64String(document.TagBase64);
        var plaintext = new byte[ciphertext.Length];
        var key = Derive(password, salt);
        try
        {
            using var aes = new AesGcm(key, TagLength);
            aes.Decrypt(nonce, ciphertext, tag, plaintext,
                Encoding.UTF8.GetBytes(AadPrefix + document.Recipient));
            var identity = Encoding.UTF8.GetString(plaintext);
            ValidateIdentity(identity);
            return identity.Trim() + "\n";
        }
        catch (CryptographicException exception)
        {
            throw new UnauthorizedAccessException(
                "Break-Glass password cannot unlock the backup key.", exception);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    private static byte[] Derive(string password, byte[] salt)
    {
        var bytes = Encoding.UTF8.GetBytes(password);
        try
        {
            return Rfc2898DeriveBytes.Pbkdf2(bytes, salt, Iterations,
                HashAlgorithmName.SHA256, KeyLength);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private static void ValidateDocument(BackupKeyDocument document)
    {
        if (document.SchemaVersion != SchemaVersion || document.Algorithm != "AES-256-GCM" ||
            document.Kdf != "PBKDF2-SHA256" || document.Iterations < 600_000 ||
            document.Rotation < 1)
            throw new InvalidDataException("Encrypted backup key document is unsupported.");
        ValidateRecipient(document.Recipient);
        if (Convert.FromBase64String(document.SaltBase64).Length != SaltLength ||
            Convert.FromBase64String(document.NonceBase64).Length != NonceLength ||
            Convert.FromBase64String(document.TagBase64).Length != TagLength ||
            Convert.FromBase64String(document.CiphertextBase64).Length < 32)
            throw new InvalidDataException("Encrypted backup key document is invalid.");
    }

    private static void ValidateIdentity(string? value)
    {
        var identity = (value ?? string.Empty).Trim();
        if (!identity.StartsWith("AGE-SECRET-KEY-1", StringComparison.Ordinal) || identity.Length < 40)
            throw new InvalidDataException("Age backup identity is invalid.");
    }

    private static void ValidateRecipient(string? value)
    {
        var recipient = value ?? string.Empty;
        if (!recipient.StartsWith("age1", StringComparison.Ordinal) || recipient.Length != 62 ||
            recipient.Any(character => !(character is >= '0' and <= '9' or >= 'a' and <= 'z')))
            throw new InvalidDataException("Age backup recipient is invalid.");
    }

    private static void ValidatePassword(string? value)
    {
        if (value is null || value.Length is < 16 or > 256 || value.Contains('\0'))
            throw new InvalidDataException("Break-Glass password must contain 16-256 characters.");
    }

    private static BackupKeyStatus GetStatusUnsafe(BackupKeyDocument document) =>
        new(true, document.Recipient, document.Rotation, document.CreatedAtUtc,
            document.UpdatedAtUtc, document.UpdatedBy);

    private static void SecureFile(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}
