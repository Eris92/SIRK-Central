using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Sirk.Central.Security;

internal sealed record WebAuthnCredential(
    string CredentialId,
    string UserId,
    string UserName,
    string DisplayName,
    string PublicKey,
    uint SignatureCounter,
    string CredentialType,
    string UserHandle,
    string AaGuid,
    string[] Transports,
    bool BackupEligible,
    bool BackedUp,
    DateTimeOffset RegisteredAtUtc,
    DateTimeOffset? LastUsedAtUtc);

internal sealed record WebAuthnCredentialState(
    int Schema,
    Dictionary<string, WebAuthnCredential> Credentials);

internal sealed record WebAuthnCeremony(
    string Id,
    string Kind,
    string SubjectId,
    string ProtectedOptions,
    DateTimeOffset ExpiresAtUtc);

internal sealed class WebAuthnCredentialStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly object _sync = new();
    private readonly string _path;
    private WebAuthnCredentialState _state;

    public WebAuthnCredentialStore(IOptions<SecurityOptions> options)
    {
        Directory.CreateDirectory(options.Value.DataRoot);
        _path = Path.Combine(options.Value.DataRoot, "webauthn-credentials.net10.json");
        _state = Load();
    }

    public IReadOnlyList<WebAuthnCredential> ListByUser(string userId)
    {
        lock (_sync)
        {
            return _state.Credentials.Values
                .Where(value => string.Equals(value.UserId, userId, StringComparison.Ordinal))
                .OrderBy(value => value.RegisteredAtUtc)
                .ToArray();
        }
    }

    public WebAuthnCredential? Get(byte[] credentialId)
    {
        var key = Base64Url(credentialId);
        lock (_sync)
        {
            return _state.Credentials.GetValueOrDefault(key);
        }
    }

    public bool Exists(byte[] credentialId) => Get(credentialId) is not null;

    public bool Owns(byte[] credentialId, byte[] userHandle)
    {
        var credential = Get(credentialId);
        return credential is not null && CryptographicOperations.FixedTimeEquals(
            Decode(credential.UserHandle), userHandle);
    }

    public WebAuthnCredential Add(WebAuthnCredential credential)
    {
        lock (_sync)
        {
            if (_state.Credentials.ContainsKey(credential.CredentialId))
                throw new InvalidOperationException("WebAuthn credential already exists.");
            if (_state.Credentials.Values.Count(value => value.UserId == credential.UserId) >= 10)
                throw new InvalidOperationException("Maximum number of WebAuthn credentials was reached.");
            _state.Credentials.Add(credential.CredentialId, credential);
            Persist();
            return credential;
        }
    }

    public WebAuthnCredential UpdateCounter(byte[] credentialId, uint counter, bool backedUp)
    {
        var key = Base64Url(credentialId);
        lock (_sync)
        {
            if (!_state.Credentials.TryGetValue(key, out var credential))
                throw new KeyNotFoundException("WebAuthn credential was not found.");
            if (counter != 0 && credential.SignatureCounter != 0 && counter <= credential.SignatureCounter)
                throw new InvalidOperationException("WebAuthn signature counter did not increase.");
            credential = credential with
            {
                SignatureCounter = counter,
                BackedUp = backedUp,
                LastUsedAtUtc = DateTimeOffset.UtcNow
            };
            _state.Credentials[key] = credential;
            Persist();
            return credential;
        }
    }

    public void Remove(string credentialId, string userId)
    {
        lock (_sync)
        {
            if (!_state.Credentials.TryGetValue(credentialId, out var value))
                throw new KeyNotFoundException("WebAuthn credential was not found.");
            if (!string.Equals(value.UserId, userId, StringComparison.Ordinal))
                throw new UnauthorizedAccessException("Credential does not belong to the current identity.");
            _state.Credentials.Remove(credentialId);
            Persist();
        }
    }

    private WebAuthnCredentialState Load()
    {
        if (!File.Exists(_path)) return new WebAuthnCredentialState(1, []);
        using var stream = File.OpenRead(_path);
        var value = JsonSerializer.Deserialize<WebAuthnCredentialState>(stream, JsonOptions)
            ?? throw new InvalidDataException("WebAuthn credential store is empty.");
        if (value.Schema != 1) throw new InvalidDataException("WebAuthn credential store schema is unsupported.");
        foreach (var item in value.Credentials)
        {
            if (!string.Equals(item.Key, item.Value.CredentialId, StringComparison.Ordinal) ||
                Decode(item.Key).Length is < 16 or > 1024 || Decode(item.Value.PublicKey).Length < 16 ||
                Decode(item.Value.UserHandle).Length is < 16 or > 64)
                throw new InvalidDataException("WebAuthn credential store contains an invalid record.");
        }
        return value;
    }

    private void Persist()
    {
        var temporary = $"{_path}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                JsonSerializer.Serialize(stream, _state, JsonOptions);
            SecureFile(temporary);
            File.Move(temporary, _path, true);
            SecureFile(_path);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    internal static string Base64Url(byte[] value) =>
        Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    internal static byte[] Decode(string value)
    {
        var normalized = value.Replace('-', '+').Replace('_', '/');
        normalized += (normalized.Length % 4) switch { 2 => "==", 3 => "=", _ => string.Empty };
        return Convert.FromBase64String(normalized);
    }

    private static void SecureFile(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}

internal sealed class WebAuthnCeremonyStore
{
    private readonly ConcurrentDictionary<string, WebAuthnCeremony> _items = new(StringComparer.Ordinal);
    private readonly IDataProtector _protector;

    public WebAuthnCeremonyStore(IDataProtectionProvider provider)
    {
        _protector = provider.CreateProtector("SIRK.Central.WebAuthn.Ceremony.v1");
    }

    public (string Id, DateTimeOffset ExpiresAtUtc) Create(string kind, string subjectId, string optionsJson)
    {
        Cleanup();
        var id = WebAuthnCredentialStore.Base64Url(RandomNumberGenerator.GetBytes(32));
        var expires = DateTimeOffset.UtcNow.AddMinutes(3);
        var protectedOptions = _protector.Protect(optionsJson);
        if (!_items.TryAdd(id, new WebAuthnCeremony(id, kind, subjectId, protectedOptions, expires)))
            throw new InvalidOperationException("Could not allocate WebAuthn ceremony.");
        return (id, expires);
    }

    public string Consume(string id, string kind, string subjectId)
    {
        Cleanup();
        if (!_items.TryRemove(id ?? string.Empty, out var value) ||
            value.ExpiresAtUtc <= DateTimeOffset.UtcNow ||
            !string.Equals(value.Kind, kind, StringComparison.Ordinal) ||
            !string.Equals(value.SubjectId, subjectId, StringComparison.Ordinal))
            throw new UnauthorizedAccessException("WebAuthn ceremony is invalid, expired or already used.");
        return _protector.Unprotect(value.ProtectedOptions);
    }

    private void Cleanup()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var item in _items)
            if (item.Value.ExpiresAtUtc <= now) _items.TryRemove(item.Key, out _);
    }
}
