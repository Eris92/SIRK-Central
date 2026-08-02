using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Sirk.Central.Portals;

internal sealed class FilePortalRegistry
{
    private const int CurrentSchemaVersion = 2;
    private const int DerivedKeyLength = 32;
    private const int SaltLength = 32;
    private const int GeneratedTokenBytes = 32;

    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly Lock _sync = new();
    private readonly PortalProtocolOptions _options;
    private readonly ILogger<FilePortalRegistry> _logger;
    private readonly string _registryPath;
    private PortalRegistryDocument _document = null!;

    public FilePortalRegistry(
        IOptions<PortalProtocolOptions> options,
        ILogger<FilePortalRegistry> logger)
    {
        _options = options.Value;
        _logger = logger;

        ValidateOptions(_options);
        Directory.CreateDirectory(_options.DataRoot);
        SecureDirectory(_options.DataRoot);
        _registryPath = Path.Combine(_options.DataRoot, _options.RegistryFileName);

        lock (_sync)
        {
            _document = LoadOrCreateDocument();
            EnsureBootstrapPortal();
        }
    }

    public IReadOnlyList<PortalSummary> List()
    {
        lock (_sync)
        {
            return _document.Portals
                .OrderBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
                .ThenBy(item => item.Id, StringComparer.Ordinal)
                .Select(ToSummary)
                .ToArray();
        }
    }

    public PortalSummary? Get(string portalId)
    {
        if (!TryNormalizePortalId(portalId, out var normalizedId))
        {
            return null;
        }

        lock (_sync)
        {
            var portal = FindPortal(normalizedId);
            return portal is null ? null : ToSummary(portal);
        }
    }

    public PortalCredentialIssue Create(string portalId, string portalName)
    {
        var normalizedId = NormalizePortalId(portalId);
        var normalizedName = NormalizePortalName(portalName);
        var token = GenerateToken();
        var tokenHash = HashToken(token);
        var now = DateTimeOffset.UtcNow;

        lock (_sync)
        {
            if (FindPortal(normalizedId) is not null)
            {
                throw new PortalRegistryConflictException("Portal ID already exists.");
            }

            var record = new PortalCredentialRecord(
                normalizedId,
                normalizedName,
                tokenHash,
                now,
                now,
                now);
            var portals = _document.Portals.Append(record).ToArray();
            WriteAndSwap(new PortalRegistryDocument(CurrentSchemaVersion, portals));
            return new PortalCredentialIssue(ToSummary(record), token);
        }
    }

    public PortalSummary Rename(string portalId, string portalName)
    {
        var normalizedId = NormalizePortalId(portalId);
        var normalizedName = NormalizePortalName(portalName);

        lock (_sync)
        {
            var existing = FindPortal(normalizedId)
                ?? throw new PortalRegistryNotFoundException("Portal was not found.");
            var updated = existing with
            {
                Name = normalizedName,
                UpdatedAtUtc = DateTimeOffset.UtcNow
            };
            ReplacePortal(updated);
            return ToSummary(updated);
        }
    }

    public PortalCredentialIssue RotateToken(string portalId)
    {
        var normalizedId = NormalizePortalId(portalId);
        var token = GenerateToken();
        var tokenHash = HashToken(token);

        lock (_sync)
        {
            var existing = FindPortal(normalizedId)
                ?? throw new PortalRegistryNotFoundException("Portal was not found.");
            var now = DateTimeOffset.UtcNow;
            var updated = existing with
            {
                TokenHash = tokenHash,
                UpdatedAtUtc = now,
                TokenRotatedAtUtc = now
            };
            ReplacePortal(updated);
            return new PortalCredentialIssue(ToSummary(updated), token);
        }
    }

    public PortalSummary? Remove(string portalId)
    {
        var normalizedId = NormalizePortalId(portalId);

        lock (_sync)
        {
            var existing = FindPortal(normalizedId);
            if (existing is null)
            {
                return null;
            }

            var portals = _document.Portals
                .Where(item => !string.Equals(item.Id, normalizedId, StringComparison.Ordinal))
                .ToArray();
            WriteAndSwap(new PortalRegistryDocument(CurrentSchemaVersion, portals));
            return ToSummary(existing);
        }
    }

    public PortalIdentity? Authenticate(string portalId, string token)
    {
        if (!TryNormalizePortalId(portalId, out var normalizedId) ||
            !IsValidBase64UrlSecret(token, 32, 512))
        {
            return null;
        }

        PortalCredentialRecord? candidate;
        lock (_sync)
        {
            candidate = FindPortal(normalizedId);
        }

        if (candidate is null || !VerifyToken(token, candidate.TokenHash))
        {
            return null;
        }

        lock (_sync)
        {
            var current = FindPortal(normalizedId);
            if (current is null || current.TokenHash != candidate.TokenHash)
            {
                return null;
            }

            return new PortalIdentity(current.Id, current.Name);
        }
    }

    private PortalRegistryDocument LoadOrCreateDocument()
    {
        if (File.Exists(_registryPath))
        {
            return ReadDocument();
        }

        var document = new PortalRegistryDocument(CurrentSchemaVersion, []);
        WriteDocument(document);
        return document;
    }

    private void EnsureBootstrapPortal()
    {
        var idText = _options.BootstrapPortalId.Trim();
        var nameText = _options.BootstrapPortalName.Trim();
        var token = _options.BootstrapPortalToken.Trim();

        if (idText.Length == 0 && nameText.Length == 0 && token.Length == 0)
        {
            return;
        }

        var id = NormalizePortalId(idText);
        var name = NormalizePortalName(nameText);
        if (!IsValidBase64UrlSecret(token, 32, 512))
        {
            throw new InvalidOperationException(
                "Sirk:PortalProtocol:BootstrapPortalToken must be a 32-512 character Base64URL secret.");
        }

        if (FindPortal(id) is not null)
        {
            return;
        }

        var now = DateTimeOffset.UtcNow;
        var record = new PortalCredentialRecord(
            id,
            name,
            HashToken(token),
            now,
            now,
            now);
        var portals = _document.Portals.Append(record).ToArray();
        WriteAndSwap(new PortalRegistryDocument(CurrentSchemaVersion, portals));
        _logger.LogInformation("Created bootstrap Portal credential for {PortalId}.", id);
    }

    private PortalRegistryDocument ReadDocument()
    {
        try
        {
            using var stream = new FileStream(
                _registryPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                16_384,
                FileOptions.SequentialScan);
            var document = JsonSerializer.Deserialize<PortalRegistryDocument>(stream, SerializerOptions);
            ValidateDocument(document);
            return document!;
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("Portal registry JSON is invalid.", exception);
        }
    }

    private static void ValidateDocument(PortalRegistryDocument? document)
    {
        if (document is null ||
            document.SchemaVersion != CurrentSchemaVersion ||
            document.Portals is null)
        {
            throw new InvalidDataException("Portal registry has an unsupported format.");
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var portal in document.Portals)
        {
            if (!TryNormalizePortalId(portal.Id, out var normalizedId) ||
                !string.Equals(normalizedId, portal.Id, StringComparison.Ordinal) ||
                NormalizePortalName(portal.Name) != portal.Name ||
                !ids.Add(portal.Id) ||
                !IsValidTokenHash(portal.TokenHash) ||
                portal.CreatedAtUtc == default ||
                portal.UpdatedAtUtc < portal.CreatedAtUtc ||
                portal.TokenRotatedAtUtc < portal.CreatedAtUtc ||
                portal.TokenRotatedAtUtc > portal.UpdatedAtUtc)
            {
                throw new InvalidDataException("Portal registry contains an invalid record.");
            }
        }
    }

    private void ReplacePortal(PortalCredentialRecord updated)
    {
        var portals = _document.Portals
            .Select(item => string.Equals(item.Id, updated.Id, StringComparison.Ordinal) ? updated : item)
            .ToArray();
        WriteAndSwap(new PortalRegistryDocument(CurrentSchemaVersion, portals));
    }

    private PortalCredentialRecord? FindPortal(string normalizedId) =>
        _document.Portals.FirstOrDefault(
            item => string.Equals(item.Id, normalizedId, StringComparison.Ordinal));

    private void WriteAndSwap(PortalRegistryDocument document)
    {
        WriteDocument(document);
        _document = document;
    }

    private void WriteDocument(PortalRegistryDocument document)
    {
        var temporaryPath = $"{_registryPath}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            using (var stream = new FileStream(
                       temporaryPath,
                       FileMode.CreateNew,
                       FileAccess.Write,
                       FileShare.None,
                       16_384,
                       FileOptions.WriteThrough))
            {
                JsonSerializer.Serialize(stream, document, SerializerOptions);
                stream.Flush(flushToDisk: true);
            }

            SecureFile(temporaryPath);
            File.Move(temporaryPath, _registryPath, overwrite: true);
            SecureFile(_registryPath);
        }
        finally
        {
            File.Delete(temporaryPath);
        }
    }

    private PortalTokenHash HashToken(string token)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltLength);
        var tokenBytes = Encoding.UTF8.GetBytes(token);
        try
        {
            var hash = Rfc2898DeriveBytes.Pbkdf2(
                tokenBytes,
                salt,
                _options.TokenHashIterations,
                HashAlgorithmName.SHA256,
                DerivedKeyLength);

            return new PortalTokenHash(
                "PBKDF2-SHA256",
                _options.TokenHashIterations,
                Convert.ToBase64String(salt),
                Convert.ToBase64String(hash));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(tokenBytes);
        }
    }

    private static bool VerifyToken(string token, PortalTokenHash tokenHash)
    {
        if (!IsValidTokenHash(tokenHash))
        {
            return false;
        }

        var salt = Convert.FromBase64String(tokenHash.SaltBase64);
        var expected = Convert.FromBase64String(tokenHash.HashBase64);
        var tokenBytes = Encoding.UTF8.GetBytes(token);
        try
        {
            var actual = Rfc2898DeriveBytes.Pbkdf2(
                tokenBytes,
                salt,
                tokenHash.Iterations,
                HashAlgorithmName.SHA256,
                expected.Length);
            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(tokenBytes);
            CryptographicOperations.ZeroMemory(expected);
            CryptographicOperations.ZeroMemory(salt);
        }
    }

    private static bool IsValidTokenHash(PortalTokenHash? tokenHash)
    {
        if (tokenHash is null ||
            !string.Equals(tokenHash.Algorithm, "PBKDF2-SHA256", StringComparison.Ordinal) ||
            tokenHash.Iterations < 100_000)
        {
            return false;
        }

        try
        {
            var salt = Convert.FromBase64String(tokenHash.SaltBase64);
            var hash = Convert.FromBase64String(tokenHash.HashBase64);
            return salt.Length >= 16 && hash.Length == DerivedKeyLength;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static string GenerateToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(GeneratedTokenBytes))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');

    private static string NormalizePortalId(string value)
    {
        var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (!IsValidPortalId(normalized))
        {
            throw new ArgumentException(
                "Portal ID must contain 3-63 lowercase letters, digits or hyphens.",
                nameof(value));
        }

        return normalized;
    }

    private static string NormalizePortalName(string value)
    {
        var normalized = (value ?? string.Empty).Trim();
        if (normalized.Length is < 2 or > 100)
        {
            throw new ArgumentException(
                "Portal name must contain 2-100 characters.",
                nameof(value));
        }

        return normalized;
    }

    private static bool TryNormalizePortalId(string? value, out string normalized)
    {
        normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        return IsValidPortalId(normalized);
    }

    private static bool IsValidPortalId(string value)
    {
        if (value.Length is < 3 or > 63 || !IsLowercaseLetterOrDigit(value[0]))
        {
            return false;
        }

        foreach (var character in value)
        {
            if (!IsLowercaseLetterOrDigit(character) && character != '-')
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsValidBase64UrlSecret(string? value, int minimum, int maximum)
    {
        if (value is null || value.Length < minimum || value.Length > maximum)
        {
            return false;
        }

        foreach (var character in value)
        {
            if (character is not (>= 'a' and <= 'z') and
                not (>= 'A' and <= 'Z') and
                not (>= '0' and <= '9') and
                not '-' and
                not '_')
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsLowercaseLetterOrDigit(char value) =>
        value is >= 'a' and <= 'z' or >= '0' and <= '9';

    private static PortalSummary ToSummary(PortalCredentialRecord portal) =>
        new(
            portal.Id,
            portal.Name,
            portal.CreatedAtUtc,
            portal.UpdatedAtUtc,
            portal.TokenRotatedAtUtc);

    private static void ValidateOptions(PortalProtocolOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.DataRoot))
        {
            throw new InvalidOperationException("Sirk:PortalProtocol:DataRoot is required.");
        }

        if (Path.GetFileName(options.RegistryFileName) != options.RegistryFileName)
        {
            throw new InvalidOperationException("Portal registry file name must not contain a path.");
        }

        if (options.TokenHashIterations < 100_000)
        {
            throw new InvalidOperationException("Portal token hash iterations must be at least 100000.");
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

internal sealed class PortalRegistryConflictException(string message)
    : InvalidOperationException(message);

internal sealed class PortalRegistryNotFoundException(string message)
    : InvalidOperationException(message);
