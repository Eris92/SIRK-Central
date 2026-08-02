using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Sirk.Central.Security;

internal sealed record LocalIdentity(
    string Id,
    string UserName,
    IReadOnlyList<string> Roles);

internal sealed record LocalIdentityDocument(
    int SchemaVersion,
    LocalAccountRecord BreakGlass);

internal sealed record LocalAccountRecord(
    string Id,
    string UserName,
    CredentialHash PasswordHash,
    CredentialHash AccessCodeHash,
    bool Enabled,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc);

internal sealed record CredentialHash(
    string Algorithm,
    int Iterations,
    string SaltBase64,
    string HashBase64);

internal sealed record BreakGlassBootstrapSecret(
    string UserName,
    string Password,
    string AccessCode);

internal sealed class LocalIdentityStore
{
    private const int CurrentSchemaVersion = 1;
    private const int SaltLength = 32;
    private const int DerivedKeyLength = 32;
    private const long MaximumBootstrapBytes = 16 * 1024;

    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private static readonly UnixFileMode ForbiddenUnixModes =
        UnixFileMode.GroupRead |
        UnixFileMode.GroupWrite |
        UnixFileMode.GroupExecute |
        UnixFileMode.OtherRead |
        UnixFileMode.OtherWrite |
        UnixFileMode.OtherExecute;

    private readonly SecurityOptions _options;
    private readonly ILogger<LocalIdentityStore> _logger;
    private readonly string _identityPath;
    private LocalIdentityDocument? _document;

    public LocalIdentityStore(
        IOptions<SecurityOptions> options,
        ILogger<LocalIdentityStore> logger)
    {
        _options = options.Value;
        _logger = logger;
        ValidateOptions(_options);

        _identityPath = Path.Combine(_options.DataRoot, _options.IdentityFileName);
        if (!_options.Enabled)
        {
            return;
        }

        Directory.CreateDirectory(_options.DataRoot);
        SecureDirectory(_options.DataRoot);

        if (File.Exists(_identityPath))
        {
            _document = ReadIdentityDocument();
            RemoveStaleBootstrapSecret();
            return;
        }

        _document = BootstrapIdentity();
    }

    public bool Enabled => _options.Enabled;

    public LocalIdentity? Authenticate(
        string userName,
        string password,
        string accessCode)
    {
        if (!_options.Enabled || _document is null)
        {
            return null;
        }

        var account = _document.BreakGlass;
        var normalizedUserName = NormalizeUserName(userName, throwOnInvalid: false);
        var passwordAccepted = VerifyCredential(password, account.PasswordHash);
        var accessCodeAccepted = VerifyCredential(accessCode, account.AccessCodeHash);
        var userAccepted = string.Equals(
            normalizedUserName,
            account.UserName,
            StringComparison.Ordinal);

        if (!account.Enabled ||
            !userAccepted ||
            !passwordAccepted ||
            !accessCodeAccepted)
        {
            return null;
        }

        return new LocalIdentity(
            account.Id,
            account.UserName,
            [SirkRoles.BreakGlass]);
    }

    public LocalIdentity? GetBreakGlassIdentity()
    {
        if (!_options.Enabled || _document is null || !_document.BreakGlass.Enabled)
        {
            return null;
        }

        return new LocalIdentity(
            _document.BreakGlass.Id,
            _document.BreakGlass.UserName,
            [SirkRoles.BreakGlass]);
    }

    private LocalIdentityDocument BootstrapIdentity()
    {
        var bootstrapPath = ResolveBootstrapPath();
        if (!File.Exists(bootstrapPath))
        {
            throw new InvalidOperationException(
                $"Central security is enabled, but the one-time Break-Glass bootstrap secret file does not exist: {bootstrapPath}");
        }

        ValidateProtectedFile(bootstrapPath, MaximumBootstrapBytes);
        BreakGlassBootstrapSecret secret;
        try
        {
            using var stream = new FileStream(
                bootstrapPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                4096,
                FileOptions.SequentialScan);
            secret = JsonSerializer.Deserialize<BreakGlassBootstrapSecret>(stream, SerializerOptions)
                     ?? throw new InvalidDataException("Break-Glass bootstrap secret file is empty.");
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException(
                "Break-Glass bootstrap secret file contains invalid JSON.",
                exception);
        }

        var userName = NormalizeUserName(secret.UserName, throwOnInvalid: true);
        ValidatePassword(secret.Password);
        ValidateAccessCode(secret.AccessCode);

        var now = DateTimeOffset.UtcNow;
        var document = new LocalIdentityDocument(
            CurrentSchemaVersion,
            new LocalAccountRecord(
                Guid.NewGuid().ToString("N"),
                userName,
                HashCredential(secret.Password),
                HashCredential(secret.AccessCode),
                true,
                now,
                now));

        WriteIdentityDocument(document);
        File.Delete(bootstrapPath);
        _logger.LogWarning(
            "Initialized the .NET 10 Break-Glass identity and removed one-time bootstrap file {BootstrapPath}.",
            bootstrapPath);
        return document;
    }

    private LocalIdentityDocument ReadIdentityDocument()
    {
        ValidateProtectedFile(_identityPath, 64 * 1024);
        try
        {
            using var stream = new FileStream(
                _identityPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                8192,
                FileOptions.SequentialScan);
            var document = JsonSerializer.Deserialize<LocalIdentityDocument>(stream, SerializerOptions);
            ValidateDocument(document);
            return document!;
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("Local identity store contains invalid JSON.", exception);
        }
    }

    private void WriteIdentityDocument(LocalIdentityDocument document)
    {
        var temporaryPath = $"{_identityPath}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            using (var stream = new FileStream(
                       temporaryPath,
                       FileMode.CreateNew,
                       FileAccess.Write,
                       FileShare.None,
                       8192,
                       FileOptions.WriteThrough))
            {
                JsonSerializer.Serialize(stream, document, SerializerOptions);
                stream.Flush(flushToDisk: true);
            }

            SecureFile(temporaryPath);
            File.Move(temporaryPath, _identityPath, overwrite: false);
            SecureFile(_identityPath);
        }
        finally
        {
            File.Delete(temporaryPath);
        }
    }

    private void RemoveStaleBootstrapSecret()
    {
        var bootstrapPath = ResolveBootstrapPath();
        if (!File.Exists(bootstrapPath))
        {
            return;
        }

        ValidateProtectedFile(bootstrapPath, MaximumBootstrapBytes);
        File.Delete(bootstrapPath);
        _logger.LogWarning(
            "Removed a stale one-time Break-Glass bootstrap secret file because the identity store already exists: {BootstrapPath}.",
            bootstrapPath);
    }

    private CredentialHash HashCredential(string secret)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltLength);
        var secretBytes = Encoding.UTF8.GetBytes(secret);
        try
        {
            var hash = Rfc2898DeriveBytes.Pbkdf2(
                secretBytes,
                salt,
                _options.PasswordHashIterations,
                HashAlgorithmName.SHA256,
                DerivedKeyLength);
            return new CredentialHash(
                "PBKDF2-SHA256",
                _options.PasswordHashIterations,
                Convert.ToBase64String(salt),
                Convert.ToBase64String(hash));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(secretBytes);
        }
    }

    private static bool VerifyCredential(string secret, CredentialHash credential)
    {
        if (!IsValidCredentialHash(credential) || secret.Length is < 1 or > 512)
        {
            return false;
        }

        var salt = Convert.FromBase64String(credential.SaltBase64);
        var expected = Convert.FromBase64String(credential.HashBase64);
        var secretBytes = Encoding.UTF8.GetBytes(secret);
        try
        {
            var actual = Rfc2898DeriveBytes.Pbkdf2(
                secretBytes,
                salt,
                credential.Iterations,
                HashAlgorithmName.SHA256,
                expected.Length);
            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(secretBytes);
            CryptographicOperations.ZeroMemory(salt);
            CryptographicOperations.ZeroMemory(expected);
        }
    }

    private static void ValidateDocument(LocalIdentityDocument? document)
    {
        if (document is null || document.SchemaVersion != CurrentSchemaVersion)
        {
            throw new InvalidDataException("Local identity store has an unsupported schema.");
        }

        var account = document.BreakGlass;
        if (string.IsNullOrWhiteSpace(account.Id) ||
            account.Id.Length > 128 ||
            NormalizeUserName(account.UserName, throwOnInvalid: false) != account.UserName ||
            !IsValidCredentialHash(account.PasswordHash) ||
            !IsValidCredentialHash(account.AccessCodeHash) ||
            account.CreatedAtUtc == default ||
            account.UpdatedAtUtc < account.CreatedAtUtc)
        {
            throw new InvalidDataException("Local identity store contains an invalid Break-Glass account.");
        }
    }

    private static bool IsValidCredentialHash(CredentialHash? credential)
    {
        if (credential is null ||
            !string.Equals(credential.Algorithm, "PBKDF2-SHA256", StringComparison.Ordinal) ||
            credential.Iterations < 100_000)
        {
            return false;
        }

        try
        {
            return Convert.FromBase64String(credential.SaltBase64).Length >= 16 &&
                   Convert.FromBase64String(credential.HashBase64).Length == DerivedKeyLength;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private string ResolveBootstrapPath()
    {
        if (!string.IsNullOrWhiteSpace(_options.BootstrapSecretFile))
        {
            return Path.GetFullPath(
                Environment.ExpandEnvironmentVariables(_options.BootstrapSecretFile.Trim()));
        }

        return OperatingSystem.IsWindows()
            ? Path.Combine(_options.DataRoot, "break-glass-bootstrap.json")
            : "/run/secrets/sirk-central-breakglass-bootstrap.json";
    }

    private static string NormalizeUserName(string? value, bool throwOnInvalid)
    {
        var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        var valid = normalized.Length is >= 3 and <= 64;
        foreach (var character in normalized)
        {
            if (character is not (>= 'a' and <= 'z') and
                not (>= '0' and <= '9') and
                not '.' and
                not '_' and
                not '-')
            {
                valid = false;
                break;
            }
        }

        if (!valid && throwOnInvalid)
        {
            throw new InvalidDataException(
                "Break-Glass user name must contain 3-64 lowercase letters, digits, dot, underscore or hyphen.");
        }

        return valid ? normalized : string.Empty;
    }

    private static void ValidatePassword(string? value)
    {
        if (value is null ||
            value.Length is < 16 or > 256 ||
            value.Contains('\0', StringComparison.Ordinal))
        {
            throw new InvalidDataException(
                "Break-Glass password must contain 16-256 characters and no NUL characters.");
        }
    }

    private static void ValidateAccessCode(string? value)
    {
        if (value is null || value.Length is < 24 or > 128)
        {
            throw new InvalidDataException(
                "Break-Glass access code must contain 24-128 Base64URL characters.");
        }

        foreach (var character in value)
        {
            if (character is not (>= 'a' and <= 'z') and
                not (>= 'A' and <= 'Z') and
                not (>= '0' and <= '9') and
                not '-' and
                not '_')
            {
                throw new InvalidDataException(
                    "Break-Glass access code must contain only Base64URL characters.");
            }
        }
    }

    private static void ValidateProtectedFile(string path, long maximumBytes)
    {
        var information = new FileInfo(path);
        if (!information.Exists || information.Length is <= 0 or > maximumBytes)
        {
            throw new InvalidDataException(
                $"Protected file must contain 1-{maximumBytes} bytes: {path}");
        }

        if ((information.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException(
                $"Protected file must not be a symbolic link or reparse point: {path}");
        }

        if (!OperatingSystem.IsWindows() &&
            (File.GetUnixFileMode(path) & ForbiddenUnixModes) != 0)
        {
            throw new InvalidDataException(
                $"Protected file must not grant permissions to group or other users: {path}");
        }
    }

    private static void ValidateOptions(SecurityOptions options)
    {
        if (!options.Enabled)
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(options.DataRoot))
        {
            throw new InvalidOperationException("Sirk:Security:DataRoot is required.");
        }

        foreach (var fileName in new[]
                 {
                     options.IdentityFileName,
                     options.AuditFileName,
                     options.AuditKeyFileName
                 })
        {
            if (string.IsNullOrWhiteSpace(fileName) || Path.GetFileName(fileName) != fileName)
            {
                throw new InvalidOperationException(
                    "Security file names must be non-empty leaf file names.");
            }
        }

        if (options.PasswordHashIterations < 100_000)
        {
            throw new InvalidOperationException(
                "Break-Glass password hash iterations must be at least 100000.");
        }

        if (options.SessionMinutes is < 5 or > 240)
        {
            throw new InvalidOperationException(
                "Break-Glass session duration must be between 5 and 240 minutes.");
        }

        if (options.LoginAttemptsPerFiveMinutes is < 1 or > 100)
        {
            throw new InvalidOperationException(
                "Break-Glass login rate limit must be between 1 and 100 attempts per five minutes.");
        }
    }

    private static void SecureDirectory(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                path,
                UnixFileMode.UserRead |
                UnixFileMode.UserWrite |
                UnixFileMode.UserExecute);
        }
    }

    private static void SecureFile(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }
}
