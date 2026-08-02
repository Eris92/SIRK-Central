using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Sirk.Central.Security;

internal sealed record SecurityAuditEvent(
    string ActorId,
    string ActorName,
    string Action,
    string TargetType,
    string TargetId,
    bool Success,
    string RemoteAddress,
    string CorrelationId,
    IReadOnlyDictionary<string, string>? Details = null);

internal sealed record SecurityAuditPayload(
    int SchemaVersion,
    string Id,
    DateTimeOffset TimestampUtc,
    string ActorId,
    string ActorName,
    string Action,
    string TargetType,
    string TargetId,
    bool Success,
    string RemoteAddress,
    string CorrelationId,
    IReadOnlyDictionary<string, string> Details,
    string PreviousMac);

internal sealed record SecurityAuditRecord(
    int SchemaVersion,
    string Id,
    DateTimeOffset TimestampUtc,
    string ActorId,
    string ActorName,
    string Action,
    string TargetType,
    string TargetId,
    bool Success,
    string RemoteAddress,
    string CorrelationId,
    IReadOnlyDictionary<string, string> Details,
    string PreviousMac,
    string Mac);

internal sealed class SecurityAuditLog
{
    private const int CurrentSchemaVersion = 1;
    private const int KeyBytes = 32;
    private const int MaximumLineBytes = 64 * 1024;

    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };

    private readonly Lock _sync = new();
    private readonly SecurityOptions _options;
    private readonly string _auditPath;
    private readonly string _keyPath;
    private byte[] _key = [];
    private string _headMac = string.Empty;

    public SecurityAuditLog(IOptions<SecurityOptions> options)
    {
        _options = options.Value;
        _auditPath = Path.Combine(_options.DataRoot, _options.AuditFileName);
        _keyPath = Path.Combine(_options.DataRoot, _options.AuditKeyFileName);

        if (!_options.Enabled)
        {
            return;
        }

        Directory.CreateDirectory(_options.DataRoot);
        SecureDirectory(_options.DataRoot);
        _key = LoadOrCreateKey();
        _headMac = VerifyExistingLog();
    }

    public bool Enabled => _options.Enabled;

    public SecurityAuditRecord Write(SecurityAuditEvent auditEvent)
    {
        ArgumentNullException.ThrowIfNull(auditEvent);
        if (!_options.Enabled)
        {
            throw new InvalidOperationException("Security audit log is disabled.");
        }

        var normalized = Normalize(auditEvent);
        lock (_sync)
        {
            var payload = new SecurityAuditPayload(
                CurrentSchemaVersion,
                Guid.NewGuid().ToString("N"),
                DateTimeOffset.UtcNow,
                normalized.ActorId,
                normalized.ActorName,
                normalized.Action,
                normalized.TargetType,
                normalized.TargetId,
                normalized.Success,
                normalized.RemoteAddress,
                normalized.CorrelationId,
                normalized.Details ?? new Dictionary<string, string>(),
                _headMac);
            var mac = ComputeMac(payload);
            var record = new SecurityAuditRecord(
                payload.SchemaVersion,
                payload.Id,
                payload.TimestampUtc,
                payload.ActorId,
                payload.ActorName,
                payload.Action,
                payload.TargetType,
                payload.TargetId,
                payload.Success,
                payload.RemoteAddress,
                payload.CorrelationId,
                payload.Details,
                payload.PreviousMac,
                mac);

            Append(record);
            _headMac = mac;
            return record;
        }
    }

    public string VerifyIntegrity()
    {
        if (!_options.Enabled)
        {
            return string.Empty;
        }

        lock (_sync)
        {
            var verifiedHead = VerifyExistingLog();
            if (!string.Equals(verifiedHead, _headMac, StringComparison.Ordinal))
            {
                throw new InvalidDataException(
                    "Security audit log head changed outside the running process.");
            }

            return verifiedHead;
        }
    }

    private byte[] LoadOrCreateKey()
    {
        if (File.Exists(_keyPath))
        {
            ValidateProtectedFile(_keyPath, 4096);
            var encoded = File.ReadAllText(_keyPath, Encoding.ASCII).Trim();
            byte[] key;
            try
            {
                key = Convert.FromBase64String(encoded);
            }
            catch (FormatException exception)
            {
                throw new InvalidDataException("Security audit key is not valid Base64.", exception);
            }

            if (key.Length != KeyBytes)
            {
                CryptographicOperations.ZeroMemory(key);
                throw new InvalidDataException(
                    $"Security audit key must contain exactly {KeyBytes} bytes.");
            }

            return key;
        }

        if (File.Exists(_auditPath) && new FileInfo(_auditPath).Length > 0)
        {
            throw new InvalidDataException(
                "Security audit log exists, but its integrity key is missing.");
        }

        var keyBytes = RandomNumberGenerator.GetBytes(KeyBytes);
        var temporaryPath = $"{_keyPath}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            File.WriteAllText(
                temporaryPath,
                Convert.ToBase64String(keyBytes),
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            SecureFile(temporaryPath);
            File.Move(temporaryPath, _keyPath, overwrite: false);
            SecureFile(_keyPath);
            return keyBytes;
        }
        finally
        {
            File.Delete(temporaryPath);
        }
    }

    private string VerifyExistingLog()
    {
        if (!File.Exists(_auditPath))
        {
            return string.Empty;
        }

        ValidateProtectedFile(_auditPath, long.MaxValue);
        var previousMac = string.Empty;
        var lineNumber = 0;
        using var stream = new FileStream(
            _auditPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite,
            16_384,
            FileOptions.SequentialScan);
        using var reader = new StreamReader(
            stream,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true),
            detectEncodingFromByteOrderMarks: false,
            bufferSize: 16_384,
            leaveOpen: false);

        while (reader.ReadLine() is { } line)
        {
            lineNumber++;
            if (Encoding.UTF8.GetByteCount(line) > MaximumLineBytes)
            {
                throw new InvalidDataException(
                    $"Security audit record {lineNumber} exceeds {MaximumLineBytes} bytes.");
            }

            SecurityAuditRecord record;
            try
            {
                record = JsonSerializer.Deserialize<SecurityAuditRecord>(line, SerializerOptions)
                         ?? throw new InvalidDataException(
                             $"Security audit record {lineNumber} is empty.");
            }
            catch (JsonException exception)
            {
                throw new InvalidDataException(
                    $"Security audit record {lineNumber} contains invalid JSON.",
                    exception);
            }

            ValidateRecord(record, lineNumber);
            if (!string.Equals(record.PreviousMac, previousMac, StringComparison.Ordinal))
            {
                throw new InvalidDataException(
                    $"Security audit chain is broken at record {lineNumber}.");
            }

            var payload = ToPayload(record);
            var expected = ComputeMac(payload);
            if (!FixedTimeBase64Equals(expected, record.Mac))
            {
                throw new InvalidDataException(
                    $"Security audit MAC is invalid at record {lineNumber}.");
            }

            previousMac = record.Mac;
        }

        return previousMac;
    }

    private void Append(SecurityAuditRecord record)
    {
        var line = JsonSerializer.Serialize(record, SerializerOptions);
        if (Encoding.UTF8.GetByteCount(line) > MaximumLineBytes)
        {
            throw new InvalidOperationException(
                $"Security audit record exceeds {MaximumLineBytes} bytes.");
        }

        using var stream = new FileStream(
            _auditPath,
            FileMode.Append,
            FileAccess.Write,
            FileShare.Read,
            16_384,
            FileOptions.WriteThrough);
        if (stream.Length == 0)
        {
            SecureFile(_auditPath);
        }

        using var writer = new StreamWriter(
            stream,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            bufferSize: 16_384,
            leaveOpen: true);
        writer.WriteLine(line);
        writer.Flush();
        stream.Flush(flushToDisk: true);
        SecureFile(_auditPath);
    }

    private string ComputeMac(SecurityAuditPayload payload)
    {
        var serialized = JsonSerializer.SerializeToUtf8Bytes(payload, SerializerOptions);
        try
        {
            return Convert.ToBase64String(HMACSHA256.HashData(_key, serialized));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(serialized);
        }
    }

    private static SecurityAuditPayload ToPayload(SecurityAuditRecord record) =>
        new(
            record.SchemaVersion,
            record.Id,
            record.TimestampUtc,
            record.ActorId,
            record.ActorName,
            record.Action,
            record.TargetType,
            record.TargetId,
            record.Success,
            record.RemoteAddress,
            record.CorrelationId,
            record.Details,
            record.PreviousMac);

    private static SecurityAuditEvent Normalize(SecurityAuditEvent value)
    {
        var details = new SortedDictionary<string, string>(StringComparer.Ordinal);
        if (value.Details is not null)
        {
            if (value.Details.Count > 32)
            {
                throw new ArgumentException(
                    "Security audit details may contain at most 32 fields.",
                    nameof(value));
            }

            foreach (var item in value.Details)
            {
                details.Add(
                    NormalizeField(item.Key, "detail key", 1, 64),
                    NormalizeField(item.Value, "detail value", 0, 512));
            }
        }

        return value with
        {
            ActorId = NormalizeField(value.ActorId, "actor ID", 1, 128),
            ActorName = NormalizeField(value.ActorName, "actor name", 1, 128),
            Action = NormalizeField(value.Action, "action", 1, 128),
            TargetType = NormalizeField(value.TargetType, "target type", 1, 64),
            TargetId = NormalizeField(value.TargetId, "target ID", 0, 256),
            RemoteAddress = NormalizeField(value.RemoteAddress, "remote address", 1, 128),
            CorrelationId = NormalizeField(value.CorrelationId, "correlation ID", 1, 128),
            Details = details
        };
    }

    private static string NormalizeField(
        string? value,
        string fieldName,
        int minimumLength,
        int maximumLength)
    {
        var normalized = (value ?? string.Empty).Trim();
        if (normalized.Length < minimumLength ||
            normalized.Length > maximumLength ||
            normalized.Contains('\r') ||
            normalized.Contains('\n') ||
            normalized.Contains('\0'))
        {
            throw new ArgumentException(
                $"Security audit {fieldName} is invalid.",
                fieldName);
        }

        return normalized;
    }

    private static void ValidateRecord(SecurityAuditRecord record, int lineNumber)
    {
        if (record.SchemaVersion != CurrentSchemaVersion ||
            string.IsNullOrWhiteSpace(record.Id) ||
            record.TimestampUtc == default ||
            string.IsNullOrWhiteSpace(record.ActorId) ||
            string.IsNullOrWhiteSpace(record.ActorName) ||
            string.IsNullOrWhiteSpace(record.Action) ||
            string.IsNullOrWhiteSpace(record.TargetType) ||
            string.IsNullOrWhiteSpace(record.RemoteAddress) ||
            string.IsNullOrWhiteSpace(record.CorrelationId) ||
            record.Details is null ||
            record.Mac.Length is < 40 or > 64 ||
            record.PreviousMac.Length > 64)
        {
            throw new InvalidDataException(
                $"Security audit record {lineNumber} has an invalid schema.");
        }
    }

    private static bool FixedTimeBase64Equals(string expectedBase64, string actualBase64)
    {
        byte[] expected;
        byte[] actual;
        try
        {
            expected = Convert.FromBase64String(expectedBase64);
            actual = Convert.FromBase64String(actualBase64);
        }
        catch (FormatException)
        {
            return false;
        }

        try
        {
            return expected.Length == actual.Length &&
                   CryptographicOperations.FixedTimeEquals(expected, actual);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(expected);
            CryptographicOperations.ZeroMemory(actual);
        }
    }

    private static void ValidateProtectedFile(string path, long maximumBytes)
    {
        var information = new FileInfo(path);
        if (!information.Exists || information.Length > maximumBytes)
        {
            throw new InvalidDataException($"Protected file is invalid: {path}");
        }

        if ((information.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException(
                $"Protected file must not be a symbolic link or reparse point: {path}");
        }

        if (!OperatingSystem.IsWindows())
        {
            var forbidden =
                UnixFileMode.GroupRead |
                UnixFileMode.GroupWrite |
                UnixFileMode.GroupExecute |
                UnixFileMode.OtherRead |
                UnixFileMode.OtherWrite |
                UnixFileMode.OtherExecute;
            if ((File.GetUnixFileMode(path) & forbidden) != 0)
            {
                throw new InvalidDataException(
                    $"Protected file must not grant permissions to group or other users: {path}");
            }
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
