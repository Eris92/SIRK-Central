using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Options;
using Sirk.Central.Portals;
using Sirk.Central.Security;

namespace Sirk.Central.Access;

internal sealed record PasswordHash(int Iterations, string Salt, string Hash);
internal sealed record ManagedIdentity(
    string Key,
    string Source,
    string UserName,
    string DisplayName,
    string? Role,
    string? RequestedRole,
    string[] ClaimedRoles,
    string Status,
    bool Enabled,
    PasswordHash? Password,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc,
    string ApprovedBy);
internal sealed record IdentityRegistry(int Schema, Dictionary<string, ManagedIdentity> Identities);
internal sealed record CreateLocalIdentityRequest(string UserName, string DisplayName, string Password, string Role);
internal sealed record ChangeRoleRequest(string Role);
internal sealed record EntraRoleDecisionRequest(string Decision);

internal sealed record AccessTeamRequest(
    string Id,
    string Name,
    string? Description,
    string[]? Members,
    string[]? PortalIds,
    Dictionary<string, string>? Profile);
internal sealed record AccessTeam(
    string Id,
    string Name,
    string Description,
    string[] Members,
    string[] PortalIds,
    Dictionary<string, string> Profile,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc);
internal sealed record AccessRegistry(
    int Schema,
    Dictionary<string, AccessTeam> Teams,
    Dictionary<string, Dictionary<string, string>> PortalPolicies);
internal sealed record PortalPolicyRequest(Dictionary<string, string>? Policy);
internal sealed record EffectiveAccess(bool Allowed, string[] Teams, Dictionary<string, string> Capabilities);

internal sealed class IdentityAccessStore
{
    public static readonly string[] Capabilities =
    [
        "portal.view", "portal.connect", "device.desktop.connect", "device.terminal.execute",
        "device.files.read", "device.files.write", "device.registry.read", "device.registry.write",
        "device.software.manage", "device.services.manage"
    ];

    private static readonly IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> RoleCapabilities =
        new Dictionary<string, IReadOnlyDictionary<string, string>>(StringComparer.Ordinal)
        {
            [SirkRoles.Auditor] = new Dictionary<string, string> { ["portal.view"] = "allow" },
            [SirkRoles.OperatorL1] = new Dictionary<string, string>
            {
                ["portal.view"] = "allow", ["portal.connect"] = "allow", ["device.desktop.connect"] = "allow"
            },
            [SirkRoles.SupportL2] = new Dictionary<string, string>
            {
                ["portal.view"] = "allow", ["portal.connect"] = "allow", ["device.desktop.connect"] = "allow",
                ["device.terminal.execute"] = "allow", ["device.files.read"] = "allow", ["device.services.manage"] = "approval"
            },
            [SirkRoles.EngineerL3] = Capabilities.ToDictionary(value => value, _ => "allow", StringComparer.Ordinal),
            [SirkRoles.Admin] = new Dictionary<string, string> { ["portal.view"] = "allow", ["portal.connect"] = "allow" },
            [SirkRoles.SecAdmin] = new Dictionary<string, string> { ["portal.view"] = "allow", ["portal.connect"] = "approval" },
            [SirkRoles.BreakGlass] = Capabilities.ToDictionary(value => value, _ => "allow", StringComparer.Ordinal)
        };

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object _sync = new();
    private readonly string _identityPath;
    private readonly string _accessPath;
    private readonly int _iterations;
    private IdentityRegistry _identities;
    private AccessRegistry _access;

    public IdentityAccessStore(IOptions<SecurityOptions> options)
    {
        Directory.CreateDirectory(options.Value.DataRoot);
        _identityPath = Path.Combine(options.Value.DataRoot, "managed-identities.net10.json");
        _accessPath = Path.Combine(options.Value.DataRoot, "access-control.net10.json");
        _iterations = Math.Max(100_000, options.Value.PasswordHashIterations);
        _identities = Load<IdentityRegistry>(_identityPath) ?? new IdentityRegistry(1, []);
        _access = Load<AccessRegistry>(_accessPath) ?? new AccessRegistry(1, [], []);
        if (_identities.Schema != 1 || _access.Schema != 1) throw new InvalidDataException("Identity or access store schema is unsupported.");
    }

    public ManagedIdentity CreateLocal(CreateLocalIdentityRequest input, ClaimsPrincipal actor)
    {
        lock (_sync)
        {
            var userName = UserName(input.UserName);
            var key = "local:" + userName;
            if (_identities.Identities.ContainsKey(key)) throw new InvalidOperationException("Username already exists.");
            var role = Role(input.Role);
            EnsureRoleAssignment(actor, role, null, key);
            var password = HashPassword(input.Password);
            var now = DateTimeOffset.UtcNow;
            var value = new ManagedIdentity(
                key, "local", userName, DisplayName(input.DisplayName, userName), role, null, [], "active", true,
                password, now, now, string.Empty);
            _identities.Identities.Add(key, value);
            PersistIdentities();
            return Public(value);
        }
    }

    public ManagedIdentity? AuthenticateLocal(string? userName, string? password)
    {
        lock (_sync)
        {
            var normalized = TryUserName(userName);
            if (normalized is null) return null;
            var value = _identities.Identities.GetValueOrDefault("local:" + normalized);
            if (value is not { Enabled: true, Status: "active", Password: not null }) return null;
            return VerifyPassword(password ?? string.Empty, value.Password) ? Public(value) : null;
        }
    }

    public ManagedIdentity UpdateRole(string key, ChangeRoleRequest input, ClaimsPrincipal actor)
    {
        lock (_sync)
        {
            key = IdentityKey(key);
            if (!_identities.Identities.TryGetValue(key, out var value)) throw new KeyNotFoundException("Identity was not found.");
            if (value.Source != "local") throw new InvalidOperationException("Entra roles are managed through claims and approval.");
            var role = Role(input.Role);
            EnsureRoleAssignment(actor, role, value.Role, key);
            value = value with { Role = role, UpdatedAtUtc = DateTimeOffset.UtcNow };
            _identities.Identities[key] = value;
            PersistIdentities();
            return Public(value);
        }
    }

    public ManagedIdentity SetEnabled(string key, bool enabled, ClaimsPrincipal actor)
    {
        lock (_sync)
        {
            key = IdentityKey(key);
            if (!_identities.Identities.TryGetValue(key, out var value)) throw new KeyNotFoundException("Identity was not found.");
            if (value.Role == SirkRoles.SecAdmin && !ActorIsBreakGlass(actor))
                throw new UnauthorizedAccessException("Only Break Glass may disable SecAdmin.");
            value = value with { Enabled = enabled, Status = enabled ? value.Status : "disabled", UpdatedAtUtc = DateTimeOffset.UtcNow };
            if (enabled && value.Status == "disabled") value = value with { Status = value.Role is null ? "pending" : "active" };
            _identities.Identities[key] = value;
            PersistIdentities();
            return Public(value);
        }
    }

    public ManagedIdentity ResolveEntra(
        string identityKey,
        string userName,
        string displayName,
        IReadOnlyCollection<string> claimedRoles)
    {
        lock (_sync)
        {
            var key = "entra:" + EntraIdentityKey(identityKey);
            var claims = claimedRoles.Where(SirkRoles.Assignable.Contains).Distinct(StringComparer.Ordinal).ToArray();
            var now = DateTimeOffset.UtcNow;
            var value = _identities.Identities.GetValueOrDefault(key) ?? new ManagedIdentity(
                key, "entra", userName, displayName, null, null, [], "pending", true, null, now, now, string.Empty);
            if (!value.Enabled) throw new UnauthorizedAccessException("This Entra account is disabled in SIRK Central.");
            value = value with
            {
                UserName = UserNameOrEmail(userName),
                DisplayName = DisplayName(displayName, userName),
                ClaimedRoles = claims,
                UpdatedAtUtc = now
            };
            if (claims.Length > 1)
            {
                value = value with { Role = null, RequestedRole = null, Status = "conflict" };
            }
            else if (claims.Length == 1 && !SirkRoles.IsPrivileged(claims[0]))
            {
                value = value with { Role = claims[0], RequestedRole = null, Status = "active" };
            }
            else if (claims.Length == 1)
            {
                var requested = claims[0];
                value = value.Role == requested && value.ApprovedBy.Length > 0
                    ? value with { RequestedRole = null, Status = "active" }
                    : value with { Role = null, RequestedRole = requested, Status = "pending", ApprovedBy = string.Empty };
            }
            else
            {
                value = value with { Role = null, RequestedRole = null, Status = "pending" };
            }
            _identities.Identities[key] = value;
            PersistIdentities();
            return Public(value);
        }
    }

    public ManagedIdentity DecideEntraRole(string key, string decision, ClaimsPrincipal actor)
    {
        lock (_sync)
        {
            key = IdentityKey(key);
            if (!_identities.Identities.TryGetValue(key, out var value) || value.Source != "entra")
                throw new KeyNotFoundException("Entra identity was not found.");
            var requested = value.RequestedRole ?? throw new InvalidOperationException("No privileged role is waiting for approval.");
            EnsureRoleAssignment(actor, requested, value.Role, key);
            if (decision == "approve")
            {
                value = value with
                {
                    Role = requested,
                    RequestedRole = null,
                    Status = "active",
                    ApprovedBy = ActorKey(actor),
                    UpdatedAtUtc = DateTimeOffset.UtcNow
                };
            }
            else if (decision == "reject")
            {
                value = value with
                {
                    Role = null,
                    RequestedRole = null,
                    Status = "pending",
                    ApprovedBy = string.Empty,
                    UpdatedAtUtc = DateTimeOffset.UtcNow
                };
            }
            else throw new InvalidDataException("Unsupported role decision.");
            _identities.Identities[key] = value;
            PersistIdentities();
            return Public(value);
        }
    }

    public IReadOnlyList<ManagedIdentity> ListIdentities()
    {
        lock (_sync) return _identities.Identities.Values.Select(Public).OrderBy(value => value.DisplayName).ToArray();
    }

    public AccessTeam SaveTeam(AccessTeamRequest input)
    {
        lock (_sync)
        {
            var id = Slug(input.Id, "Team");
            var previous = _access.Teams.GetValueOrDefault(id);
            var now = DateTimeOffset.UtcNow;
            var value = new AccessTeam(
                id,
                Name(input.Name, 100),
                Text(input.Description, 300),
                NormalizeMembers(input.Members),
                NormalizePortalIds(input.PortalIds),
                NormalizePolicy(input.Profile, true),
                previous?.CreatedAtUtc ?? now,
                now);
            _access.Teams[id] = value;
            PersistAccess();
            return value;
        }
    }

    public void DeleteTeam(string id)
    {
        lock (_sync)
        {
            if (!_access.Teams.Remove(Slug(id, "Team"))) throw new KeyNotFoundException("Team was not found.");
            PersistAccess();
        }
    }

    public Dictionary<string, string> SavePortalPolicy(string portalId, Dictionary<string, string>? policy)
    {
        lock (_sync)
        {
            var id = Slug(portalId, "Portal");
            var value = NormalizePolicy(policy, true);
            _access.PortalPolicies[id] = value;
            PersistAccess();
            return value;
        }
    }

    public Dictionary<string, string> PortalPolicy(string portalId)
    {
        lock (_sync)
        {
            var id = Slug(portalId, "Portal");
            return NormalizePolicy(_access.PortalPolicies.GetValueOrDefault(id), true);
        }
    }

    public IReadOnlyList<AccessTeam> ListTeams()
    {
        lock (_sync) return _access.Teams.Values.OrderBy(value => value.Name).ToArray();
    }

    public EffectiveAccess Effective(ManagedIdentity identity, string portalId)
    {
        lock (_sync)
        {
            portalId = Slug(portalId, "Portal");
            var role = identity.Role ?? string.Empty;
            var rolePolicy = NormalizePolicy(RoleCapabilities.GetValueOrDefault(role), false);
            if (role == SirkRoles.BreakGlass)
                return new EffectiveAccess(true, ["Break-Glass"], rolePolicy);
            var teams = _access.Teams.Values.Where(value =>
                value.Members.Contains(identity.Key, StringComparer.Ordinal) &&
                value.PortalIds.Contains(portalId, StringComparer.Ordinal)).ToArray();
            if (teams.Length == 0) return new EffectiveAccess(false, [], NormalizePolicy(null, false));
            var local = PortalPolicy(portalId);
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var capability in Capabilities)
            {
                var teamState = Restrictive(teams.Select(value => value.Profile[capability]), "allow");
                var localState = local[capability] == "inherit" ? "allow" : local[capability];
                result[capability] = Restrictive([rolePolicy[capability], teamState, localState], "deny");
            }
            return new EffectiveAccess(result["portal.view"] != "deny", teams.Select(value => value.Id).ToArray(), result);
        }
    }

    public ManagedIdentity? Get(string key)
    {
        lock (_sync) return _identities.Identities.TryGetValue(IdentityKey(key), out var value) ? Public(value) : null;
    }

    private void EnsureRoleAssignment(ClaimsPrincipal actor, string target, string? current, string targetKey)
    {
        if (ActorIsBreakGlass(actor)) return;
        var actorRole = actor.FindFirstValue(ClaimTypes.Role);
        var actorKey = ActorKey(actor);
        if (actorRole == SirkRoles.SecAdmin)
        {
            if (target != SirkRoles.SecAdmin || current == SirkRoles.Admin || actorKey == targetKey)
                throw new UnauthorizedAccessException("SecAdmin may only assign SecAdmin to another identity.");
            return;
        }
        if (actorRole != SirkRoles.Admin || target == SirkRoles.SecAdmin || current == SirkRoles.SecAdmin)
            throw new UnauthorizedAccessException("Role assignment is not allowed.");
    }

    private PasswordHash HashPassword(string? password)
    {
        if (password is null || password.Length is < 14 or > 256 || password.Contains('\0'))
            throw new InvalidDataException("Password must contain 14-256 characters.");
        var salt = RandomNumberGenerator.GetBytes(32);
        var bytes = Encoding.UTF8.GetBytes(password);
        try
        {
            var hash = Rfc2898DeriveBytes.Pbkdf2(bytes, salt, _iterations, HashAlgorithmName.SHA256, 32);
            return new PasswordHash(_iterations, Convert.ToBase64String(salt), Convert.ToBase64String(hash));
        }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private static bool VerifyPassword(string password, PasswordHash value)
    {
        var salt = Convert.FromBase64String(value.Salt);
        var expected = Convert.FromBase64String(value.Hash);
        var bytes = Encoding.UTF8.GetBytes(password);
        try
        {
            var actual = Rfc2898DeriveBytes.Pbkdf2(bytes, salt, value.Iterations, HashAlgorithmName.SHA256, expected.Length);
            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
            CryptographicOperations.ZeroMemory(salt);
            CryptographicOperations.ZeroMemory(expected);
        }
    }

    private T? Load<T>(string path)
    {
        if (!File.Exists(path)) return default;
        using var stream = File.OpenRead(path);
        return JsonSerializer.Deserialize<T>(stream, JsonOptions);
    }
    private void PersistIdentities() => Write(_identityPath, _identities);
    private void PersistAccess() => Write(_accessPath, _access);
    private static void Write<T>(string path, T value)
    {
        var temporary = $"{path}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                JsonSerializer.Serialize(stream, value, JsonOptions);
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(temporary, path, true);
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        finally { File.Delete(temporary); }
    }

    private static ManagedIdentity Public(ManagedIdentity value) => value with { Password = null };
    private static string Role(string? role)
    {
        var value = (role ?? string.Empty).Trim();
        if (!SirkRoles.Assignable.Contains(value)) throw new InvalidDataException("Unsupported role.");
        return value;
    }
    private static string UserName(string? value) => TryUserName(value) ?? throw new InvalidDataException("Username is invalid.");
    private static string? TryUserName(string? value)
    {
        var result = (value ?? string.Empty).Trim().ToLowerInvariant();
        return result.Length is >= 3 and <= 64 && result.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-') ? result : null;
    }
    private static string UserNameOrEmail(string? value)
    {
        var result = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (result.Length is 0 or > 254 || result.Any(char.IsControl)) throw new InvalidDataException("Entra username is invalid.");
        return result;
    }
    private static string EntraIdentityKey(string? value)
    {
        var result = (value ?? string.Empty).Trim().ToLowerInvariant();
        var parts = result.Split(':');
        if (parts.Length != 2 || !Guid.TryParse(parts[0], out _) || !Guid.TryParse(parts[1], out _))
            throw new InvalidDataException("Entra identity key is invalid.");
        return result;
    }
    private static string IdentityKey(string? value)
    {
        var result = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (result.StartsWith("local:", StringComparison.Ordinal)) return "local:" + UserName(result[6..]);
        if (result.StartsWith("entra:", StringComparison.Ordinal)) return "entra:" + EntraIdentityKey(result[6..]);
        throw new InvalidDataException("Identity key is invalid.");
    }
    private static string DisplayName(string? value, string fallback)
    {
        var result = string.Join(' ', (value ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return result.Length is >= 2 and <= 100 ? result : fallback;
    }
    private static string Name(string? value, int max)
    {
        var result = string.Join(' ', (value ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (result.Length is < 2 || result.Length > max) throw new InvalidDataException("Name is invalid.");
        return result;
    }
    private static string Text(string? value, int max)
    {
        var result = (value ?? string.Empty).Trim();
        if (result.Length > max) throw new InvalidDataException("Text is too long.");
        return new string(result.Select(character => char.IsControl(character) ? ' ' : character).ToArray());
    }
    private static string Slug(string? value, string field)
    {
        var result = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (result.Length is < 3 or > 63 || result.Any(character => !(char.IsAsciiLetterOrDigit(character) || character == '-')))
            throw new InvalidDataException($"{field} ID is invalid.");
        return result;
    }
    private static string[] NormalizeMembers(string[]? values) =>
        (values ?? []).Select(IdentityKey).Distinct(StringComparer.Ordinal).ToArray();
    private static string[] NormalizePortalIds(string[]? values) =>
        (values ?? []).Select(value => Slug(value, "Portal")).Distinct(StringComparer.Ordinal).ToArray();
    private static Dictionary<string, string> NormalizePolicy(IReadOnlyDictionary<string, string>? source, bool inherit)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var capability in Capabilities)
        {
            var state = source?.GetValueOrDefault(capability)?.Trim().ToLowerInvariant() ?? (inherit ? "inherit" : "deny");
            if (state is not ("allow" or "deny" or "approval" or "inherit") || !inherit && state == "inherit")
                throw new InvalidDataException("Capability state is invalid.");
            result[capability] = state;
        }
        return result;
    }
    private static string Restrictive(IEnumerable<string> states, string fallback)
    {
        var rank = new Dictionary<string, int> { ["deny"] = 0, ["approval"] = 1, ["allow"] = 2 };
        var values = states.Where(value => value != "inherit").ToArray();
        return values.Length == 0 ? fallback : values.OrderBy(value => rank[value]).First();
    }
    private static bool ActorIsBreakGlass(ClaimsPrincipal actor) =>
        actor.IsInRole(SirkRoles.BreakGlass) && actor.FindFirstValue("sirk:identity_source") == "local-break-glass";
    private static string ActorKey(ClaimsPrincipal actor) => actor.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown";
}

internal static class IdentityAccessEndpoints
{
    public static IEndpointRouteBuilder MapIdentityAccess(this IEndpointRouteBuilder endpoints)
    {
        var users = endpoints.MapGroup("/api/v1/identities").RequireAuthorization(SirkPolicies.SecurityAdministration);
        users.MapGet("/", (IdentityAccessStore store) => Results.Ok(store.ListIdentities()));
        users.MapPost("/local", CreateLocalAsync);
        users.MapPut("/{*key}/role", ChangeRoleAsync);
        users.MapPut("/{*key}/enabled/{enabled:bool}", SetEnabledAsync);
        users.MapPost("/{*key}/entra-role", DecideEntraRoleAsync);

        var access = endpoints.MapGroup("/api/v1/access-control").RequireAuthorization(SirkPolicies.PortalManagement);
        access.MapGet("/teams", (IdentityAccessStore store) => Results.Ok(store.ListTeams()));
        access.MapPut("/teams", SaveTeamAsync);
        access.MapDelete("/teams/{id}", DeleteTeamAsync);
        access.MapGet("/portals/{portalId}/policy", (string portalId, IdentityAccessStore store) => Results.Ok(store.PortalPolicy(portalId)));
        access.MapPut("/portals/{portalId}/policy", SavePortalPolicyAsync);
        access.MapGet("/effective/{*identityKey}/{portalId}", Effective);
        return endpoints;
    }

    private static async Task<IResult> CreateLocalAsync(CreateLocalIdentityRequest request, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.CreateLocal(request, context.User)));
    private static async Task<IResult> ChangeRoleAsync(string key, ChangeRoleRequest request, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.UpdateRole(key, request, context.User)));
    private static async Task<IResult> SetEnabledAsync(string key, bool enabled, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.SetEnabled(key, enabled, context.User)));
    private static async Task<IResult> DecideEntraRoleAsync(string key, EntraRoleDecisionRequest request, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.DecideEntraRole(key, request.Decision, context.User)));
    private static async Task<IResult> SaveTeamAsync(AccessTeamRequest request, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.SaveTeam(request)));
    private static async Task<IResult> DeleteTeamAsync(string id, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => { store.DeleteTeam(id); return Results.NoContent(); });
    private static async Task<IResult> SavePortalPolicyAsync(string portalId, PortalPolicyRequest request, HttpContext context, IAntiforgery antiforgery, IdentityAccessStore store) =>
        await Mutate(context, antiforgery, () => Results.Ok(store.SavePortalPolicy(portalId, request.Policy)));
    private static IResult Effective(string identityKey, string portalId, IdentityAccessStore store)
    {
        var identity = store.Get(identityKey);
        return identity is null ? Results.NotFound() : Results.Ok(store.Effective(identity, portalId));
    }
    private static async Task<IResult> Mutate(HttpContext context, IAntiforgery antiforgery, Func<IResult> action)
    {
        try
        {
            await antiforgery.ValidateRequestAsync(context);
            return action();
        }
        catch (AntiforgeryValidationException) { return Results.Json(new { ok = false, code = "CSRF_VALIDATION_FAILED" }, statusCode: 400); }
        catch (KeyNotFoundException exception) { return Results.Json(new { ok = false, error = exception.Message }, statusCode: 404); }
        catch (UnauthorizedAccessException exception) { return Results.Json(new { ok = false, error = exception.Message }, statusCode: 403); }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException)
        { return Results.Json(new { ok = false, error = exception.Message }, statusCode: 409); }
    }
}
