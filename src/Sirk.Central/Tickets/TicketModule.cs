using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;

namespace Sirk.Central.Tickets;

internal sealed record TicketPerson(string Id, string DisplayName, string Email);
internal sealed record TicketSync(string State, DateTimeOffset? LastSyncAtUtc, string LastError);
internal sealed record TicketSla(DateTimeOffset? ResponseDueAtUtc, DateTimeOffset? ResolutionDueAtUtc, bool Breached);
internal sealed record TicketProjection(
    string TicketId,
    string PortalId,
    string TenantId,
    string CustomerId,
    string SiteId,
    string ExternalSystem,
    string ExternalId,
    string Title,
    string Description,
    string Status,
    string Priority,
    string Category,
    string Source,
    TicketPerson? Requester,
    TicketPerson? Assignee,
    string DeviceId,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset SourceUpdatedAtUtc,
    DateTimeOffset UpdatedAtUtc,
    string SourceHash,
    TicketSla Sla,
    TicketSync Sync,
    DateTimeOffset ReceivedAtUtc);

internal sealed record TicketInput(
    string TicketId,
    string? TenantId,
    string? CustomerId,
    string? SiteId,
    string? ExternalSystem,
    string? ExternalId,
    string Title,
    string? Description,
    string? Status,
    string? Priority,
    string? Category,
    string? Source,
    TicketPerson? Requester,
    TicketPerson? Assignee,
    string? DeviceId,
    DateTimeOffset? CreatedAtUtc,
    DateTimeOffset? UpdatedAtUtc,
    TicketSla? Sla,
    TicketSync? Sync);

internal sealed record TicketEventRequest(
    string EventId,
    string Type,
    DateTimeOffset? OccurredAtUtc,
    TicketInput Ticket);

internal sealed record TicketEventResult(
    bool Accepted,
    bool Duplicate,
    bool Stale,
    string Type,
    TicketProjection Ticket);

internal sealed record TicketStoreState(
    int Schema,
    Dictionary<string, TicketProjection> Tickets,
    Dictionary<string, List<string>> PortalEventIds);

internal sealed class TicketStore
{
    public static readonly HashSet<string> Statuses = new(StringComparer.Ordinal)
    {
        "new", "accepted", "in_progress", "waiting_for_user", "waiting_for_external",
        "resolved", "closed", "cancelled"
    };

    public static readonly HashSet<string> Priorities = new(StringComparer.Ordinal)
    {
        "low", "normal", "high", "critical"
    };

    public static readonly HashSet<string> EventTypes = new(StringComparer.Ordinal)
    {
        "ticket.created", "ticket.updated", "ticket.status_changed", "ticket.assigned",
        "ticket.comment_added", "ticket.sla_breached", "ticket.closed", "ticket.sync_failed"
    };

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly object _sync = new();
    private readonly string _path;
    private readonly int _maxTickets;
    private readonly int _maxEventIds;
    private TicketStoreState _state;

    public TicketStore(IOptions<SecurityOptions> options, IConfiguration configuration)
    {
        Directory.CreateDirectory(options.Value.DataRoot);
        _path = Path.Combine(options.Value.DataRoot, "ticket-projections.net10.json");
        _maxTickets = Math.Clamp(configuration.GetValue("Sirk:Tickets:MaxProjections", 25000), 100, 100000);
        _maxEventIds = Math.Clamp(configuration.GetValue("Sirk:Tickets:EventIdRetention", 2000), 100, 10000);
        _state = Load();
    }

    public TicketEventResult ApplyEvent(string portalId, TicketEventRequest request)
    {
        lock (_sync)
        {
            portalId = Identifier(portalId, "Portal ID");
            var eventId = Identifier(request.EventId, "Event ID");
            if (!EventTypes.Contains(request.Type ?? string.Empty))
                throw new InvalidDataException("Unsupported ticket event type.");

            var retained = _state.PortalEventIds.TryGetValue(portalId, out var ids)
                ? ids
                : _state.PortalEventIds[portalId] = [];
            if (retained.Contains(eventId, StringComparer.Ordinal))
            {
                var duplicateKey = Key(portalId, request.Ticket.TicketId);
                if (!_state.Tickets.TryGetValue(duplicateKey, out var duplicateTicket))
                    throw new InvalidDataException("Duplicate event references an unknown ticket.");
                return new TicketEventResult(false, true, false, request.Type, duplicateTicket);
            }

            var result = UpsertInternal(portalId, request.Ticket);
            retained.Add(eventId);
            if (retained.Count > _maxEventIds)
                retained.RemoveRange(0, retained.Count - _maxEventIds);
            Persist();
            return new TicketEventResult(result.Changed, false, result.Stale, request.Type, result.Ticket);
        }
    }

    public TicketProjection Upsert(string portalId, TicketInput input)
    {
        lock (_sync)
        {
            var result = UpsertInternal(Identifier(portalId, "Portal ID"), input);
            if (result.Changed) Persist();
            return result.Ticket;
        }
    }

    public IReadOnlyList<TicketProjection> List(
        string? portalId,
        string? status,
        string? priority,
        string? search,
        bool slaBreached,
        int limit)
    {
        lock (_sync)
        {
            if (!string.IsNullOrWhiteSpace(status) && !Statuses.Contains(status))
                throw new InvalidDataException("Unsupported ticket status filter.");
            if (!string.IsNullOrWhiteSpace(priority) && !Priorities.Contains(priority))
                throw new InvalidDataException("Unsupported ticket priority filter.");
            var portal = string.IsNullOrWhiteSpace(portalId) ? null : Identifier(portalId, "Portal ID");
            var query = _state.Tickets.Values.AsEnumerable();
            if (portal is not null) query = query.Where(value => value.PortalId == portal);
            if (!string.IsNullOrWhiteSpace(status)) query = query.Where(value => value.Status == status);
            if (!string.IsNullOrWhiteSpace(priority)) query = query.Where(value => value.Priority == priority);
            if (slaBreached) query = query.Where(value => value.Sla.Breached);
            if (!string.IsNullOrWhiteSpace(search))
            {
                var needle = search.Trim();
                if (needle.Length > 200) throw new InvalidDataException("Ticket search is too long.");
                query = query.Where(value =>
                    value.TicketId.Contains(needle, StringComparison.OrdinalIgnoreCase) ||
                    value.Title.Contains(needle, StringComparison.OrdinalIgnoreCase) ||
                    value.Description.Contains(needle, StringComparison.OrdinalIgnoreCase));
            }
            return query.OrderByDescending(value => value.UpdatedAtUtc)
                .Take(Math.Clamp(limit == 0 ? 200 : limit, 1, 1000))
                .ToArray();
        }
    }

    public object Summary(string? portalId)
    {
        var items = List(portalId, null, null, null, false, 1000);
        return new
        {
            total = items.Count,
            byStatus = Statuses.ToDictionary(status => status, status => items.Count(value => value.Status == status)),
            byPriority = Priorities.ToDictionary(priority => priority, priority => items.Count(value => value.Priority == priority)),
            slaBreached = items.Count(value => value.Sla.Breached)
        };
    }

    private (TicketProjection Ticket, bool Changed, bool Stale) UpsertInternal(string portalId, TicketInput input)
    {
        if (input is null) throw new InvalidDataException("Ticket payload is invalid.");
        var ticketId = Identifier(input.TicketId, "Ticket ID");
        var key = Key(portalId, ticketId);
        _state.Tickets.TryGetValue(key, out var previous);
        if (previous is null && _state.Tickets.Count >= _maxTickets)
            throw new InvalidOperationException("Ticket projection capacity was reached.");

        var status = string.IsNullOrWhiteSpace(input.Status) ? previous?.Status ?? "new" : input.Status;
        var priority = string.IsNullOrWhiteSpace(input.Priority) ? previous?.Priority ?? "normal" : input.Priority;
        if (!Statuses.Contains(status)) throw new InvalidDataException("Unsupported ticket status.");
        if (!Priorities.Contains(priority)) throw new InvalidDataException("Unsupported ticket priority.");

        var now = DateTimeOffset.UtcNow;
        var updated = input.UpdatedAtUtc ?? now;
        var created = input.CreatedAtUtc ?? previous?.CreatedAtUtc ?? updated;
        var normalized = new TicketProjection(
            ticketId,
            portalId,
            Text(input.TenantId, 128),
            Text(input.CustomerId, 128),
            Text(input.SiteId, 128),
            Text(input.ExternalSystem ?? "local", 64),
            Text(input.ExternalId, 128),
            Text(input.Title, 240, true),
            Text(input.Description, 12000),
            status,
            priority,
            Text(input.Category, 120),
            Text(input.Source ?? "portal", 64),
            NormalizePerson(input.Requester),
            NormalizePerson(input.Assignee),
            Text(input.DeviceId, 180),
            created,
            updated,
            updated,
            string.Empty,
            NormalizeSla(input.Sla),
            NormalizeSync(input.Sync),
            now);
        var hash = Digest(normalized with { SourceHash = string.Empty, ReceivedAtUtc = default });
        normalized = normalized with { SourceHash = hash };

        if (previous is not null)
        {
            if (updated < previous.SourceUpdatedAtUtc)
                return (previous, false, true);
            if (updated == previous.SourceUpdatedAtUtc)
            {
                if (CryptographicOperations.FixedTimeEquals(
                        Encoding.UTF8.GetBytes(hash), Encoding.UTF8.GetBytes(previous.SourceHash)))
                    return (previous, false, false);
                throw new InvalidOperationException("Ticket version has the same timestamp but different content.");
            }
        }

        _state.Tickets[key] = normalized;
        return (normalized, true, false);
    }

    private TicketStoreState Load()
    {
        if (!File.Exists(_path)) return new TicketStoreState(1, [], []);
        using var stream = File.OpenRead(_path);
        var value = JsonSerializer.Deserialize<TicketStoreState>(stream, JsonOptions)
            ?? throw new InvalidDataException("Ticket store is empty.");
        if (value.Schema != 1) throw new InvalidDataException("Ticket store schema is unsupported.");
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

    private static TicketPerson? NormalizePerson(TicketPerson? value) => value is null
        ? null
        : new TicketPerson(Text(value.Id, 180), Text(value.DisplayName, 180), Text(value.Email, 254));

    private static TicketSla NormalizeSla(TicketSla? value) => value is null
        ? new TicketSla(null, null, false)
        : new TicketSla(value.ResponseDueAtUtc, value.ResolutionDueAtUtc, value.Breached);

    private static TicketSync NormalizeSync(TicketSync? value)
    {
        var state = value?.State ?? "local";
        if (state is not ("local" or "pending" or "synchronized" or "conflict" or "failed"))
            throw new InvalidDataException("Unsupported ticket sync state.");
        return new TicketSync(state, value?.LastSyncAtUtc, Text(value?.LastError, 1000));
    }

    private static string Identifier(string? value, string field)
    {
        var result = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (result.Length is < 2 or > 128 || result.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or ':' or '-')))
            throw new InvalidDataException($"{field} is invalid.");
        return result;
    }

    private static string Text(string? value, int max, bool required = false)
    {
        var text = (value ?? string.Empty).Trim();
        if ((required && text.Length == 0) || text.Length > max)
            throw new InvalidDataException("Ticket field is invalid.");
        return new string(text.Select(character => char.IsControl(character) ? ' ' : character).ToArray());
    }

    private static string Key(string portalId, string ticketId) =>
        $"{Identifier(portalId, "Portal ID")}::{Identifier(ticketId, "Ticket ID")}";

    private static string Digest(TicketProjection value) =>
        Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions))).ToLowerInvariant();

    private static void SecureFile(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}

internal static class TicketEndpoints
{
    public static IEndpointRouteBuilder MapTickets(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/portal/v1/tickets/events", PortalEventAsync)
            .AllowAnonymous();

        var group = endpoints.MapGroup("/api/v1/tickets")
            .RequireAuthorization(SirkPolicies.PortalManagement);
        group.MapGet("/", List);
        group.MapGet("/summary", (TicketStore store, string? portalId) => Results.Ok(store.Summary(portalId)));
        return endpoints;
    }

    private static IResult List(
        TicketStore store,
        string? portalId,
        string? status,
        string? priority,
        string? search,
        bool slaBreached,
        int limit)
    {
        try
        {
            return Results.Ok(new
            {
                tickets = store.List(portalId, status, priority, search, slaBreached, limit),
                statuses = TicketStore.Statuses,
                priorities = TicketStore.Priorities
            });
        }
        catch (InvalidDataException exception)
        {
            return Results.Json(new { ok = false, error = exception.Message }, statusCode: 400);
        }
    }

    private static async Task<IResult> PortalEventAsync(
        HttpContext context,
        PortalRequestAuthenticator authenticator,
        TicketStore store,
        SecurityAuditLog audit,
        CancellationToken cancellationToken)
    {
        var authenticated = await authenticator.AuthenticateAsync(context.Request, cancellationToken);
        if (authenticated is null)
            return Results.Json(new { ok = false, code = "PORTAL_AUTHENTICATION_FAILED" }, statusCode: 404);

        TicketEventRequest? request;
        try
        {
            request = await context.Request.ReadFromJsonAsync<TicketEventRequest>(cancellationToken);
            if (request is null) throw new InvalidDataException("Ticket event is empty.");
            var result = store.ApplyEvent(authenticated.PortalId, request);
            audit.Write(new SecurityAuditEvent(
                authenticated.PortalId,
                authenticated.PortalId,
                result.Accepted ? "ticket.event.accepted" : "ticket.event.ignored",
                "ticket",
                result.Ticket.TicketId,
                true,
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                context.TraceIdentifier,
                new Dictionary<string, string>
                {
                    ["eventType"] = result.Type,
                    ["duplicate"] = result.Duplicate.ToString(),
                    ["stale"] = result.Stale.ToString()
                }));
            return Results.Json(result, statusCode: StatusCodes.Status202Accepted);
        }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException or JsonException)
        {
            return Results.Json(new
            {
                ok = false,
                code = "TICKET_EVENT_REJECTED",
                error = exception.Message
            }, statusCode: exception is InvalidOperationException ? 409 : 400);
        }
    }
}
