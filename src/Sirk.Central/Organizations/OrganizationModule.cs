using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Options;
using Sirk.Central.Portals;
using Sirk.Central.Security;

namespace Sirk.Central.Organizations;

internal sealed record OrganizationCreateRequest(string Code, string Name, string? TenantId, string? CustomerId);
internal sealed record OrganizationStatusRequest(string Status);
internal sealed record OrganizationObject(
    string Id,
    string Kind,
    string Code,
    string Name,
    string Status,
    string TenantId,
    string CustomerId,
    DateTimeOffset CreatedAtUtc,
    string CreatedBy,
    DateTimeOffset UpdatedAtUtc,
    string UpdatedBy,
    DateTimeOffset? DeletedAtUtc,
    string DeletedBy);
internal sealed record OrganizationState(int Schema, Dictionary<string, OrganizationObject> Objects);
internal sealed record PortalAssignmentRequest(string TenantId, string CustomerId, string SiteId);
internal sealed record PortalAssignment(
    string PortalId,
    string TenantId,
    string CustomerId,
    string SiteId,
    DateTimeOffset CreatedAtUtc,
    string CreatedBy,
    DateTimeOffset UpdatedAtUtc,
    string UpdatedBy);
internal sealed record PortalAssignmentState(int Schema, Dictionary<string, PortalAssignment> Assignments);

internal sealed class OrganizationStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object _sync = new();
    private readonly string _path;
    private OrganizationState _state;

    public OrganizationStore(IOptions<SecurityOptions> options)
    {
        Directory.CreateDirectory(options.Value.DataRoot);
        _path = Path.Combine(options.Value.DataRoot, "organizations.net10.json");
        _state = Load();
    }

    public OrganizationObject Create(string kind, OrganizationCreateRequest input, string actor)
    {
        lock (_sync)
        {
            if (kind is not ("tenant" or "customer" or "site"))
                throw new InvalidDataException("Unsupported organization object kind.");
            var code = Code(input.Code);
            var name = Name(input.Name);
            var tenantId = string.Empty;
            var customerId = string.Empty;
            if (kind == "customer")
            {
                var tenant = GetRequired(input.TenantId, "tenant");
                EnsureActive(tenant);
                tenantId = tenant.Id;
            }
            else if (kind == "site")
            {
                var customer = GetRequired(input.CustomerId, "customer");
                EnsureActive(customer);
                var tenant = GetRequired(customer.TenantId, "tenant");
                EnsureActive(tenant);
                tenantId = tenant.Id;
                customerId = customer.Id;
            }
            if (_state.Objects.Values.Any(value => value.Kind == kind && value.Code == code &&
                value.TenantId == tenantId && value.CustomerId == customerId && value.DeletedAtUtc is null))
                throw new InvalidOperationException("Organization code is already in use in this scope.");
            var now = DateTimeOffset.UtcNow;
            var normalizedActor = Actor(actor);
            var value = new OrganizationObject(
                Prefix(kind) + "-" + Base64Url(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant(),
                kind,
                code,
                name,
                "active",
                tenantId,
                customerId,
                now,
                normalizedActor,
                now,
                normalizedActor,
                null,
                string.Empty);
            _state.Objects.Add(value.Id, value);
            Persist();
            return value;
        }
    }

    public OrganizationObject SetStatus(string id, string status, string actor)
    {
        lock (_sync)
        {
            if (status is not ("active" or "disabled")) throw new InvalidDataException("Unsupported organization status.");
            var current = GetRequired(id, null);
            if (status == "disabled" && HasActiveChildren(current))
                throw new InvalidOperationException("Disable child objects before disabling the parent.");
            current = current with
            {
                Status = status,
                UpdatedAtUtc = DateTimeOffset.UtcNow,
                UpdatedBy = Actor(actor)
            };
            _state.Objects[id] = current;
            Persist();
            return current;
        }
    }

    public OrganizationObject Remove(string id, string actor)
    {
        lock (_sync)
        {
            var current = GetRequired(id, null);
            if (HasChildren(current)) throw new InvalidOperationException("Organization object still contains child objects.");
            var now = DateTimeOffset.UtcNow;
            current = current with
            {
                Status = "deleted",
                UpdatedAtUtc = now,
                UpdatedBy = Actor(actor),
                DeletedAtUtc = now,
                DeletedBy = Actor(actor)
            };
            _state.Objects[id] = current;
            Persist();
            return current;
        }
    }

    public OrganizationObject GetRequired(string? id, string? kind)
    {
        var normalized = (id ?? string.Empty).Trim().ToLowerInvariant();
        if (!_state.Objects.TryGetValue(normalized, out var value) || value.DeletedAtUtc is not null ||
            kind is not null && value.Kind != kind)
            throw new KeyNotFoundException("Organization object was not found.");
        return value;
    }

    public IReadOnlyList<OrganizationObject> List() =>
        _state.Objects.Values.Where(value => value.DeletedAtUtc is null)
            .OrderBy(value => value.Kind).ThenBy(value => value.Name).ToArray();

    public object Tree()
    {
        lock (_sync)
        {
            var active = List();
            return active.Where(value => value.Kind == "tenant").Select(tenant => new
            {
                tenant,
                customers = active.Where(value => value.Kind == "customer" && value.TenantId == tenant.Id)
                    .Select(customer => new
                    {
                        customer,
                        sites = active.Where(value => value.Kind == "site" && value.CustomerId == customer.Id).ToArray()
                    }).ToArray()
            }).ToArray();
        }
    }

    public void ValidateHierarchy(string tenantId, string customerId, string siteId)
    {
        lock (_sync)
        {
            var tenant = GetRequired(tenantId, "tenant");
            var customer = GetRequired(customerId, "customer");
            var site = GetRequired(siteId, "site");
            if (customer.TenantId != tenant.Id) throw new InvalidOperationException("Customer does not belong to the selected tenant.");
            if (site.TenantId != tenant.Id || site.CustomerId != customer.Id)
                throw new InvalidOperationException("Site does not belong to the selected customer.");
            EnsureActive(tenant);
            EnsureActive(customer);
            EnsureActive(site);
        }
    }

    private bool HasChildren(OrganizationObject value) => value.Kind switch
    {
        "tenant" => _state.Objects.Values.Any(item => item.TenantId == value.Id && item.DeletedAtUtc is null),
        "customer" => _state.Objects.Values.Any(item => item.CustomerId == value.Id && item.DeletedAtUtc is null),
        _ => false
    };

    private bool HasActiveChildren(OrganizationObject value) => value.Kind switch
    {
        "tenant" => _state.Objects.Values.Any(item => item.TenantId == value.Id && item.DeletedAtUtc is null && item.Status == "active"),
        "customer" => _state.Objects.Values.Any(item => item.CustomerId == value.Id && item.DeletedAtUtc is null && item.Status == "active"),
        _ => false
    };

    private OrganizationState Load()
    {
        if (!File.Exists(_path)) return new OrganizationState(1, []);
        using var stream = File.OpenRead(_path);
        var value = JsonSerializer.Deserialize<OrganizationState>(stream, JsonOptions)
            ?? throw new InvalidDataException("Organization store is empty.");
        if (value.Schema != 1) throw new InvalidDataException("Organization store schema is unsupported.");
        return value;
    }

    private void Persist() => AtomicJson.Write(_path, _state, JsonOptions);
    private static void EnsureActive(OrganizationObject value)
    {
        if (value.Status != "active") throw new InvalidOperationException("Tenant, Customer and Site must be active.");
    }
    private static string Prefix(string kind) => kind switch { "tenant" => "ten", "customer" => "cus", _ => "site" };
    private static string Code(string? value)
    {
        var result = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (result.Length is < 2 or > 63 || result.Any(character => !(char.IsAsciiLetterOrDigit(character) || character == '-')))
            throw new InvalidDataException("Organization code must be a lowercase slug.");
        return result;
    }
    private static string Name(string? value)
    {
        var result = string.Join(' ', (value ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (result.Length is < 2 or > 120) throw new InvalidDataException("Organization name is invalid.");
        return result;
    }
    private static string Actor(string? value)
    {
        var result = (value ?? string.Empty).Trim();
        if (result.Length is 0 or > 180) throw new InvalidDataException("Actor identity is invalid.");
        return result;
    }
    private static string Base64Url(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

internal sealed class PortalAssignmentStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object _sync = new();
    private readonly string _path;
    private readonly OrganizationStore _organizations;
    private readonly FilePortalRegistry _portals;
    private PortalAssignmentState _state;

    public PortalAssignmentStore(
        IOptions<SecurityOptions> options,
        OrganizationStore organizations,
        FilePortalRegistry portals)
    {
        Directory.CreateDirectory(options.Value.DataRoot);
        _path = Path.Combine(options.Value.DataRoot, "portal-assignments.net10.json");
        _organizations = organizations;
        _portals = portals;
        _state = Load();
    }

    public PortalAssignment Assign(string portalId, PortalAssignmentRequest input, string actor)
    {
        lock (_sync)
        {
            portalId = PortalId(portalId);
            if (!_portals.List().Any(value => value.Id == portalId)) throw new KeyNotFoundException("Portal was not found.");
            _organizations.ValidateHierarchy(input.TenantId, input.CustomerId, input.SiteId);
            var now = DateTimeOffset.UtcNow;
            var normalizedActor = Actor(actor);
            var previous = _state.Assignments.GetValueOrDefault(portalId);
            var value = new PortalAssignment(
                portalId,
                input.TenantId,
                input.CustomerId,
                input.SiteId,
                previous?.CreatedAtUtc ?? now,
                previous?.CreatedBy ?? normalizedActor,
                now,
                normalizedActor);
            _state.Assignments[portalId] = value;
            Persist();
            return value;
        }
    }

    public PortalAssignment? Get(string portalId)
    {
        lock (_sync) return _state.Assignments.GetValueOrDefault(PortalId(portalId));
    }

    public IReadOnlyList<PortalAssignment> List()
    {
        lock (_sync) return _state.Assignments.Values.OrderBy(value => value.PortalId).ToArray();
    }

    public bool Remove(string portalId)
    {
        lock (_sync)
        {
            var removed = _state.Assignments.Remove(PortalId(portalId));
            if (removed) Persist();
            return removed;
        }
    }

    private PortalAssignmentState Load()
    {
        if (!File.Exists(_path)) return new PortalAssignmentState(1, []);
        using var stream = File.OpenRead(_path);
        var value = JsonSerializer.Deserialize<PortalAssignmentState>(stream, JsonOptions)
            ?? throw new InvalidDataException("Portal assignment store is empty.");
        if (value.Schema != 1) throw new InvalidDataException("Portal assignment store schema is unsupported.");
        return value;
    }
    private void Persist() => AtomicJson.Write(_path, _state, JsonOptions);
    private static string PortalId(string? value)
    {
        var result = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (result.Length is < 2 or > 128 || result.Any(character => !(char.IsAsciiLetterOrDigit(character) || character == '-')))
            throw new InvalidDataException("Portal ID is invalid.");
        return result;
    }
    private static string Actor(string? value)
    {
        var result = (value ?? string.Empty).Trim();
        if (result.Length is 0 or > 180) throw new InvalidDataException("Actor identity is invalid.");
        return result;
    }
}

internal static class OrganizationEndpoints
{
    public static IEndpointRouteBuilder MapOrganizations(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/organizations")
            .RequireAuthorization(SirkPolicies.PortalManagement);
        group.MapGet("/", (OrganizationStore store) => Results.Ok(store.List()));
        group.MapGet("/tree", (OrganizationStore store) => Results.Ok(store.Tree()));
        group.MapPost("/{kind}", CreateAsync);
        group.MapPut("/{id}/status", StatusAsync);
        group.MapDelete("/{id}", RemoveAsync);
        group.MapGet("/portal-assignments", (PortalAssignmentStore store) => Results.Ok(store.List()));
        group.MapPut("/portal-assignments/{portalId}", AssignPortalAsync);
        group.MapDelete("/portal-assignments/{portalId}", RemovePortalAssignmentAsync);
        return endpoints;
    }

    private static async Task<IResult> CreateAsync(
        string kind, OrganizationCreateRequest request, HttpContext context,
        IAntiforgery antiforgery, OrganizationStore store, SecurityAuditLog audit)
    {
        if (!await Csrf(context, antiforgery)) return Failure("CSRF_VALIDATION_FAILED", 400);
        return Execute(() =>
        {
            var value = store.Create(kind, request, Actor(context));
            Audit(audit, context, "organization.create", value.Id, true);
            return Results.Ok(value);
        });
    }

    private static async Task<IResult> StatusAsync(
        string id, OrganizationStatusRequest request, HttpContext context,
        IAntiforgery antiforgery, OrganizationStore store, SecurityAuditLog audit)
    {
        if (!await Csrf(context, antiforgery)) return Failure("CSRF_VALIDATION_FAILED", 400);
        return Execute(() =>
        {
            var value = store.SetStatus(id, request.Status, Actor(context));
            Audit(audit, context, "organization.status", id, true);
            return Results.Ok(value);
        });
    }

    private static async Task<IResult> RemoveAsync(
        string id, HttpContext context, IAntiforgery antiforgery,
        OrganizationStore store, SecurityAuditLog audit)
    {
        if (!await Csrf(context, antiforgery)) return Failure("CSRF_VALIDATION_FAILED", 400);
        return Execute(() =>
        {
            var value = store.Remove(id, Actor(context));
            Audit(audit, context, "organization.remove", id, true);
            return Results.Ok(value);
        });
    }

    private static async Task<IResult> AssignPortalAsync(
        string portalId, PortalAssignmentRequest request, HttpContext context,
        IAntiforgery antiforgery, PortalAssignmentStore store, SecurityAuditLog audit)
    {
        if (!await Csrf(context, antiforgery)) return Failure("CSRF_VALIDATION_FAILED", 400);
        return Execute(() =>
        {
            var value = store.Assign(portalId, request, Actor(context));
            Audit(audit, context, "portal.assignment", portalId, true);
            return Results.Ok(value);
        });
    }

    private static async Task<IResult> RemovePortalAssignmentAsync(
        string portalId, HttpContext context, IAntiforgery antiforgery,
        PortalAssignmentStore store, SecurityAuditLog audit)
    {
        if (!await Csrf(context, antiforgery)) return Failure("CSRF_VALIDATION_FAILED", 400);
        var removed = store.Remove(portalId);
        Audit(audit, context, "portal.assignment.remove", portalId, removed);
        return removed ? Results.NoContent() : Results.NotFound();
    }

    private static IResult Execute(Func<IResult> action)
    {
        try { return action(); }
        catch (KeyNotFoundException exception) { return Results.Json(new { ok = false, error = exception.Message }, statusCode: 404); }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException)
        { return Results.Json(new { ok = false, error = exception.Message }, statusCode: 409); }
    }
    private static async Task<bool> Csrf(HttpContext context, IAntiforgery antiforgery)
    {
        try { await antiforgery.ValidateRequestAsync(context); return true; }
        catch (AntiforgeryValidationException) { return false; }
    }
    private static string Actor(HttpContext context) => context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown";
    private static void Audit(SecurityAuditLog audit, HttpContext context, string action, string target, bool success) =>
        audit.Write(new SecurityAuditEvent(Actor(context), context.User.Identity?.Name ?? "unknown", action,
            "organization", target, success, context.Connection.RemoteIpAddress?.ToString() ?? "unknown", context.TraceIdentifier));
    private static IResult Failure(string code, int status) => Results.Json(new { ok = false, code }, statusCode: status);
}

internal static class AtomicJson
{
    public static void Write<T>(string path, T value, JsonSerializerOptions options)
    {
        var temporary = $"{path}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                JsonSerializer.Serialize(stream, value, options);
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(temporary, path, true);
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        finally { File.Delete(temporary); }
    }
}
