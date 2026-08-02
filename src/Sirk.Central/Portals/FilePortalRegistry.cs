using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Sirk.Central.Portals;

internal sealed class FilePortalRegistry
{
    private const int DerivedKeyLength = 32;
    private const int SaltLength = 32;

    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly Lock _sync = new();
    private readonly PortalProtocolOptions _options;
    private readonly ILogger<FilePortalRegistry> _logger;
    private readonly string _registryPath;

    public FilePortalRegistry(
        IOptions<PortalProtocolOptions> options,
        ILogger<FilePortalRegistry> logger)
    {
        _options = options.Value;
        _logger = logger;

        ValidateOptions(_options);
        Directory.CreateDirectory(_options.DataRoot);
        _registryPath = Path.Combine(_options.DataRoot, _options.RegistryFileName);

        lock (_sync)
        {
            EnsureRegistryExists();
            EnsureBootstrapPortal();
        }
    }

    public PortalIdentity? Authenticate(string portalId, string token)
    {
        if (!IsValidPortalId(portalId) || token.Length is < 32 or > 512)
        {
            return null;
        }

        lock (_sync)
        {
            var document = ReadDocument();
            var portal = document.Portals.FirstOrDefault(
                item => string.Equals(item.Id, portalId, StringComparison.Ordinal));

            if (portal is null || !VerifyToken(token, portal.TokenHash))
            {
                return null;
            }

            return new PortalIdentity(portal.Id, portal.Name);
        }
    }

    private void EnsureRegistryExists()
    {
        if (File.Exists(_registryPath))
        {
            _ = ReadDocument();
            return;
        }

        WriteDocument(new PortalRegistryDocument(1, []));
    }

    private void EnsureBootstrapPortal()
    {
        var id = _options.BootstrapPortalId.Trim().ToLowerInvariant();
        var name = _options.BootstrapPortalName.Trim();
        var token = _options.BootstrapPortalToken.Trim();

        if (id.Length == 0 && name.Length == 0 && token.Length == 0)
        {
            return;
        }

        if (!IsValidPortalId(id))
        {
            throw new InvalidOperationException(
                "Sirk:PortalProtocol:BootstrapPortalId must contain 3-63 lowercase letters, digits or hyphens.");
        }

        if (name.Length is < 2 or > 100)
        {
            throw new InvalidOperationException(
                "Sirk:PortalProtocol:BootstrapPortalName must contain 2-100 characters.");
        }

        if (token.Length is < 32 or > 512)
        {
            throw new InvalidOperationException(
                "Sirk:PortalProtocol:BootstrapPortalToken must contain 32-512 characters.");
        }

        var document = ReadDocument();
        if (document.Portals.Any(item => string.Equals(item.Id, id, StringComparison.Ordinal)))
        {
            return;
        }

        var now = DateTimeOffset.UtcNow;
        var portals = document.Portals.ToList();
        portals.Add(new PortalCredentialRecord(
            id,
            name,
            HashToken(token),
            now,
            now));

        WriteDocument(new PortalRegistryDocument(1, portals));
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
                FileShare.Read);
            var document = JsonSerializer.Deserialize<PortalRegistryDocument>(stream, SerializerOptions);
            if (document is null || document.SchemaVersion != 1 || document.Portals is null)
            {
                throw new InvalidDataException("Portal registry has an unsupported format.");
            }

            foreach (var portal in document.Portals)
            {
                if (!IsValidPortalId(portal.Id) || portal.Name.Length is < 2 or > 100)
                {
                    throw new InvalidDataException("Portal registry contains an invalid identity.");
                }
            }

            return document;
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("Portal registry JSON is invalid.", exception);
        }
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
        if (!string.Equals(tokenHash.Algorithm, "PBKDF2-SHA256", StringComparison.Ordinal) ||
            tokenHash.Iterations < 100_000)
        {
            return false;
        }

        byte[] salt;
        byte[] expected;
        try
        {
            salt = Convert.FromBase64String(tokenHash.SaltBase64);
            expected = Convert.FromBase64String(tokenHash.HashBase64);
        }
        catch (FormatException)
        {
            return false;
        }

        if (salt.Length < 16 || expected.Length != DerivedKeyLength)
        {
            return false;
        }

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
        }
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

    private static bool IsLowercaseLetterOrDigit(char value) =>
        value is >= 'a' and <= 'z' or >= '0' and <= '9';

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

    private static void SecureFile(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}
