using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Sirk.Central.Security;

internal sealed record BreakGlassLoginTransaction(
    string Token,
    LocalIdentity Identity,
    string RemoteAddress,
    string UserAgentHash,
    DateTimeOffset ExpiresAtUtc);

internal sealed class BreakGlassLoginTransactionStore
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);
    private readonly ConcurrentDictionary<string, BreakGlassLoginTransaction> _items = new(StringComparer.Ordinal);

    public BreakGlassLoginTransaction Issue(LocalIdentity identity, HttpContext context)
    {
        Cleanup();
        var token = WebAuthnCredentialStore.Base64Url(RandomNumberGenerator.GetBytes(32));
        var transaction = new BreakGlassLoginTransaction(
            token,
            identity,
            RemoteAddress(context),
            UserAgentHash(context),
            DateTimeOffset.UtcNow.Add(Lifetime));
        if (!_items.TryAdd(token, transaction))
            throw new InvalidOperationException("Could not allocate a Break-Glass login transaction.");
        return transaction;
    }

    public LocalIdentity? Inspect(string? token, HttpContext context)
    {
        Cleanup();
        return TryResolve(token, context, remove: false);
    }

    public LocalIdentity? Consume(string? token, HttpContext context)
    {
        Cleanup();
        return TryResolve(token, context, remove: true);
    }

    private LocalIdentity? TryResolve(string? token, HttpContext context, bool remove)
    {
        var normalized = (token ?? string.Empty).Trim();
        if (normalized.Length is < 32 or > 256 || !_items.TryGetValue(normalized, out var transaction))
            return null;
        if (transaction.ExpiresAtUtc <= DateTimeOffset.UtcNow ||
            !string.Equals(transaction.RemoteAddress, RemoteAddress(context), StringComparison.Ordinal) ||
            !CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(transaction.UserAgentHash),
                Encoding.ASCII.GetBytes(UserAgentHash(context))))
            return null;
        if (!remove) return transaction.Identity;
        return _items.TryRemove(normalized, out var removed) && removed == transaction
            ? transaction.Identity
            : null;
    }

    private void Cleanup()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var item in _items)
            if (item.Value.ExpiresAtUtc <= now) _items.TryRemove(item.Key, out _);
    }

    private static string RemoteAddress(HttpContext context)
    {
        var value = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return value[..Math.Min(value.Length, 128)];
    }

    private static string UserAgentHash(HttpContext context)
    {
        var value = context.Request.Headers.UserAgent.ToString();
        if (value.Length > 2048) value = value[..2048];
        return WebAuthnCredentialStore.Base64Url(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    }
}

internal sealed record BreakGlassRecoveryCodeDocument(
    int Schema,
    string UserId,
    List<string> CodeHashes,
    DateTimeOffset? RotatedAtUtc,
    DateTimeOffset? LastUsedAtUtc);

internal sealed record BreakGlassRecoveryCodeStatus(
    bool Configured,
    int Remaining,
    DateTimeOffset? RotatedAtUtc,
    DateTimeOffset? LastUsedAtUtc);

internal sealed class BreakGlassRecoveryCodeStore
{
    private const int CurrentSchema = 1;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly object _sync = new();
    private readonly string _path;
    private BreakGlassRecoveryCodeDocument _document;

    public BreakGlassRecoveryCodeStore(IOptions<SecurityOptions> options)
    {
        Directory.CreateDirectory(options.Value.DataRoot);
        _path = Path.Combine(options.Value.DataRoot, "break-glass-recovery-codes.net10.json");
        _document = Load();
    }

    public BreakGlassRecoveryCodeStatus Status(string userId)
    {
        lock (_sync)
        {
            if (!string.Equals(_document.UserId, userId, StringComparison.Ordinal))
                return new BreakGlassRecoveryCodeStatus(false, 0, null, null);
            return new BreakGlassRecoveryCodeStatus(
                _document.CodeHashes.Count > 0,
                _document.CodeHashes.Count,
                _document.RotatedAtUtc,
                _document.LastUsedAtUtc);
        }
    }

    public bool IsConfigured(string userId) => Status(userId).Configured;

    public IReadOnlyList<string> Rotate(string userId, int count)
    {
        if (string.IsNullOrWhiteSpace(userId)) throw new ArgumentException("User ID is required.", nameof(userId));
        count = Math.Clamp(count, 5, 20);
        var codes = Enumerable.Range(0, count)
            .Select(_ => WebAuthnCredentialStore.Base64Url(RandomNumberGenerator.GetBytes(18)))
            .ToArray();
        var now = DateTimeOffset.UtcNow;
        lock (_sync)
        {
            _document = new BreakGlassRecoveryCodeDocument(
                CurrentSchema,
                userId,
                codes.Select(Hash).ToList(),
                now,
                null);
            Persist();
        }
        return codes;
    }

    public int VerifyAndConsume(string userId, string? code)
    {
        var candidate = Hash(code);
        lock (_sync)
        {
            if (!string.Equals(_document.UserId, userId, StringComparison.Ordinal))
                throw new UnauthorizedAccessException("Recovery code verification failed.");
            var index = -1;
            for (var current = 0; current < _document.CodeHashes.Count; current++)
            {
                var stored = Convert.FromBase64String(_document.CodeHashes[current]);
                if (CryptographicOperations.FixedTimeEquals(stored, candidate))
                {
                    index = current;
                    break;
                }
            }
            if (index < 0) throw new UnauthorizedAccessException("Recovery code verification failed.");
            _document.CodeHashes.RemoveAt(index);
            _document = _document with { LastUsedAtUtc = DateTimeOffset.UtcNow };
            Persist();
            return _document.CodeHashes.Count;
        }
    }

    public int Revoke(string userId)
    {
        lock (_sync)
        {
            if (!string.Equals(_document.UserId, userId, StringComparison.Ordinal)) return 0;
            var removed = _document.CodeHashes.Count;
            _document = new BreakGlassRecoveryCodeDocument(CurrentSchema, userId, [], null, null);
            Persist();
            return removed;
        }
    }

    private BreakGlassRecoveryCodeDocument Load()
    {
        if (!File.Exists(_path)) return new BreakGlassRecoveryCodeDocument(CurrentSchema, string.Empty, [], null, null);
        using var stream = File.OpenRead(_path);
        var document = JsonSerializer.Deserialize<BreakGlassRecoveryCodeDocument>(stream, JsonOptions)
            ?? throw new InvalidDataException("Break-Glass recovery-code store is empty.");
        if (document.Schema != CurrentSchema || document.CodeHashes.Count > 20 ||
            document.CodeHashes.Any(value => !IsHash(value)))
            throw new InvalidDataException("Break-Glass recovery-code store is invalid.");
        return document;
    }

    private void Persist()
    {
        var temporary = $"{_path}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                JsonSerializer.Serialize(stream, _document, JsonOptions);
            SecureFile(temporary);
            File.Move(temporary, _path, true);
            SecureFile(_path);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    private static byte[] Hash(string? code)
    {
        var normalized = (code ?? string.Empty).Trim();
        return SHA256.HashData(Encoding.UTF8.GetBytes(normalized));
    }

    private static string Hash(string code) => Convert.ToBase64String(Hash((string?)code));

    private static bool IsHash(string value)
    {
        try { return Convert.FromBase64String(value).Length == 32; }
        catch (FormatException) { return false; }
    }

    private static void SecureFile(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}

internal sealed class BreakGlassSessionService
{
    private readonly SecurityOptions _options;

    public BreakGlassSessionService(IOptions<SecurityOptions> options)
    {
        _options = options.Value;
    }

    public async Task<DateTimeOffset> SignInAsync(
        HttpContext context,
        LocalIdentity identity,
        string authenticationMethod)
    {
        var expiresAt = DateTimeOffset.UtcNow.AddMinutes(_options.SessionMinutes);
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, identity.Id),
            new(ClaimTypes.Name, identity.UserName),
            new("amr", authenticationMethod),
            new("sirk:identity_source", "local-break-glass"),
            new("sirk:expires_at_utc", expiresAt.ToString("O"))
        };
        claims.AddRange(identity.Roles.Select(role => new Claim(ClaimTypes.Role, role)));
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            claims,
            SirkAuthenticationSchemes.Session,
            ClaimTypes.Name,
            ClaimTypes.Role));
        await context.SignInAsync(
            SirkAuthenticationSchemes.Session,
            principal,
            new AuthenticationProperties
            {
                AllowRefresh = false,
                IsPersistent = false,
                IssuedUtc = DateTimeOffset.UtcNow,
                ExpiresUtc = expiresAt
            });
        return expiresAt;
    }

    public static object CompatibilityIdentity(LocalIdentity identity, bool enrollmentRecommended)
    {
        var role = identity.Roles.FirstOrDefault() ?? string.Empty;
        return new
        {
            id = identity.Id,
            username = identity.UserName,
            displayName = identity.UserName,
            role,
            roles = identity.Roles,
            permissions = new[] { "*" },
            source = "local",
            builtIn = true,
            mfaRequired = false,
            mfaEnrollmentRecommended = enrollmentRecommended
        };
    }
}
