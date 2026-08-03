using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Options;

namespace Sirk.Central.Security;

internal sealed record EntraSettingsPublic(
    bool Enabled,
    string Tenant,
    string ClientId,
    bool ClientSecretConfigured,
    IReadOnlyList<string> AllowedIdentities,
    string RedirectUri,
    string FrontChannelLogoutUri,
    DateTimeOffset? UpdatedAtUtc);

internal sealed record EntraSettingsUpdate(
    bool Enabled,
    string Tenant,
    string ClientId,
    string? ClientSecret,
    IReadOnlyList<string>? AllowedIdentities,
    string PublicOrigin);

internal sealed record EntraSettingsPrivate(
    int Schema,
    bool Enabled,
    string Tenant,
    string ClientId,
    string ProtectedClientSecret,
    IReadOnlyList<string> AllowedIdentities,
    string PublicOrigin,
    DateTimeOffset UpdatedAtUtc);

internal sealed class EntraSettingsStore
{
    private static readonly Regex IdentityPattern = new(
        "^[0-9a-fA-F-]{36}:[0-9a-fA-F-]{36}$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly object _sync = new();
    private readonly string _path;
    private readonly IDataProtector _protector;

    public EntraSettingsStore(
        IOptions<SecurityOptions> options,
        IDataProtectionProvider dataProtectionProvider)
    {
        Directory.CreateDirectory(options.Value.DataRoot);
        _path = Path.Combine(options.Value.DataRoot, "entra-settings.net10.json");
        _protector = dataProtectionProvider.CreateProtector("SIRK.Central.Entra.ClientSecret.v1");
    }

    public EntraSettingsPublic GetPublic()
    {
        lock (_sync)
        {
            var value = Read();
            return ToPublic(value);
        }
    }

    public EntraSettingsPrivate? GetPrivate()
    {
        lock (_sync)
        {
            return Read();
        }
    }

    public string GetClientSecret()
    {
        lock (_sync)
        {
            var value = Read() ?? throw new InvalidOperationException("Entra is not configured.");
            if (string.IsNullOrWhiteSpace(value.ProtectedClientSecret))
                throw new InvalidOperationException("Entra client secret is not configured.");
            return _protector.Unprotect(value.ProtectedClientSecret);
        }
    }

    public EntraSettingsPublic Update(EntraSettingsUpdate input)
    {
        lock (_sync)
        {
            var current = Read();
            var tenant = NormalizeTenant(input.Tenant);
            if (!Guid.TryParse(input.ClientId, out var clientId))
                throw new InvalidDataException("Entra Client ID is invalid.");
            if (!Uri.TryCreate(input.PublicOrigin, UriKind.Absolute, out var origin) ||
                origin.Scheme != Uri.UriSchemeHttps ||
                !string.IsNullOrEmpty(origin.PathAndQuery.Trim('/')))
                throw new InvalidDataException("Public origin must be an absolute HTTPS origin without a path.");

            var allowed = (input.AllowedIdentities ?? [])
                .Select(value => value.Trim().ToLowerInvariant())
                .Where(value => value.Length > 0)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (allowed.Any(value => !IdentityPattern.IsMatch(value) ||
                                     !Guid.TryParse(value[..36], out _) ||
                                     !Guid.TryParse(value[37..], out _)))
                throw new InvalidDataException("Allowed identities must use tenant-id:object-id format.");

            var protectedSecret = current?.ProtectedClientSecret ?? string.Empty;
            if (!string.IsNullOrWhiteSpace(input.ClientSecret))
                protectedSecret = _protector.Protect(input.ClientSecret.Trim());
            if (input.Enabled && string.IsNullOrWhiteSpace(protectedSecret))
                throw new InvalidDataException("Client Secret is required before enabling Entra.");

            var value = new EntraSettingsPrivate(
                1,
                input.Enabled,
                tenant,
                clientId.ToString("D"),
                protectedSecret,
                allowed,
                origin.GetLeftPart(UriPartial.Authority),
                DateTimeOffset.UtcNow);
            AtomicWrite(value);
            return ToPublic(value);
        }
    }

    private EntraSettingsPrivate? Read()
    {
        if (!File.Exists(_path)) return null;
        using var stream = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var value = JsonSerializer.Deserialize<EntraSettingsPrivate>(stream, JsonOptions)
            ?? throw new InvalidDataException("Entra settings are empty.");
        if (value.Schema != 1)
            throw new InvalidDataException("Entra settings schema is unsupported.");
        return value;
    }

    private void AtomicWrite(EntraSettingsPrivate value)
    {
        var temporary = $"{_path}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                JsonSerializer.Serialize(stream, value, JsonOptions);
            SecureFile(temporary);
            File.Move(temporary, _path, true);
            SecureFile(_path);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    private static string NormalizeTenant(string value)
    {
        var tenant = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (tenant is "organizations" or "common") return tenant;
        if (Guid.TryParse(tenant, out var id)) return id.ToString("D");
        throw new InvalidDataException("Tenant must be organizations, common or a tenant UUID.");
    }

    private static EntraSettingsPublic ToPublic(EntraSettingsPrivate? value)
    {
        var origin = value?.PublicOrigin?.TrimEnd('/') ?? string.Empty;
        return new EntraSettingsPublic(
            value?.Enabled ?? false,
            value?.Tenant ?? "organizations",
            value?.ClientId ?? string.Empty,
            !string.IsNullOrWhiteSpace(value?.ProtectedClientSecret),
            value?.AllowedIdentities ?? [],
            string.IsNullOrEmpty(origin) ? string.Empty : origin + "/auth/entra/callback",
            string.IsNullOrEmpty(origin) ? string.Empty : origin + "/auth/entra/frontchannel-logout",
            value?.UpdatedAtUtc);
    }

    private static void SecureFile(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}
