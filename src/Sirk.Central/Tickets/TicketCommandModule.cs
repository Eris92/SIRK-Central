using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;

namespace Sirk.Central.Tickets;

internal sealed record TicketCommandCreateRequest(
    string Type,
    string IdempotencyKey,
    Dictionary<string, JsonElement>? Payload);
internal sealed record TicketCommandAckRequest(
    string CommandId,
    string State,
    string? Error,
    Dictionary<string, JsonElement>? Result);
internal sealed record TicketCommand(
    string Id,
    string PortalId,
    string TicketId,
    string Type,
    string State,
    string IdempotencyKey,
    Dictionary<string, JsonElement> Payload,
    string RequestedBy,
    DateTimeOffset RequestedAtUtc,
    DateTimeOffset? AcknowledgedAtUtc,
    string Error,
    Dictionary<string, JsonElement> Result);
internal sealed record TicketCommandState(int Schema, Dictionary<string, TicketCommand> Commands);

internal sealed class TicketCommandStore
{
    internal static readonly HashSet<string> Types = new(StringComparer.Ordinal)
    {
        "ticket.status.change",
        "ticket.assign",
        "ticket.comment.add"
    };

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object _sync = new();
    private readonly string _path;
    private readonly int _maximumCommands;
    private TicketCommandState _state;

    public TicketCommandStore(IOptions<SecurityOptions> options, IConfiguration configuration)
    {
        Directory.CreateDirectory(options.Value.DataRoot);
        _path = Path.Combine(options.Value.DataRoot, "ticket-commands.net10.json");
        _maximumCommands = Math.Clamp(configuration.GetValue("Sirk:Tickets:MaxCommands", 50000), 100, 200000);
        _state = Load();
    }

    public TicketCommand Create(
        string portalId,
        string ticketId,
        TicketCommandCreateRequest input,
        string actor)
    {
        lock (_sync)
        {
            portalId = Identifier(portalId, "Portal ID");
            ticketId = Identifier(ticketId, "Ticket ID");
            var type = (input.Type ?? string.Empty).Trim();
            if (!Types.Contains(type)) throw new InvalidDataException("Unsupported ticket command type.");
            var idempotencyKey = IdempotencyKey(input.IdempotencyKey);
            var existing = _state.Commands.Values.SingleOrDefault(value =>
                value.PortalId == portalId && value.IdempotencyKey == idempotencyKey);
            if (existing is not null)
            {
                if (existing.TicketId == ticketId && existing.Type == type) return existing;
                throw new InvalidOperationException("Ticket command idempotency key was already used for another operation.");
            }
            if (_state.Commands.Count >= _maximumCommands)
                throw new InvalidOperationException("Ticket command capacity was reached.");
            var command = new TicketCommand(
                "cmd-" + Base64Url(RandomNumberGenerator.GetBytes(18)).ToLowerInvariant(),
                portalId,
                ticketId,
                type,
                "pending",
                idempotencyKey,
                input.Payload ?? [],
                Actor(actor),
                DateTimeOffset.UtcNow,
                null,
                string.Empty,
                []);
            _state.Commands.Add(command.Id, command);
            Persist();
            return command;
        }
    }

    public IReadOnlyList<TicketCommand> Poll(string portalId, int limit)
    {
        lock (_sync)
        {
            portalId = Identifier(portalId, "Portal ID");
            return _state.Commands.Values
                .Where(value => value.PortalId == portalId && value.State == "pending")
                .OrderBy(value => value.RequestedAtUtc)
                .Take(Math.Clamp(limit == 0 ? 50 : limit, 1, 200))
                .ToArray();
        }
    }

    public TicketCommand Acknowledge(string portalId, TicketCommandAckRequest input)
    {
        lock (_sync)
        {
            portalId = Identifier(portalId, "Portal ID");
            var commandId = Identifier(input.CommandId, "Command ID");
            if (!_state.Commands.TryGetValue(commandId, out var command) || command.PortalId != portalId)
                throw new KeyNotFoundException("Ticket command was not found.");
            var state = (input.State ?? string.Empty).Trim().ToLowerInvariant();
            if (state is not ("completed" or "failed"))
                throw new InvalidDataException("Unsupported ticket command acknowledgement state.");
            if (command.State != "pending")
            {
                if (command.State == state) return command;
                throw new InvalidOperationException("Ticket command was already acknowledged with another state.");
            }
            var error = (input.Error ?? string.Empty).Trim();
            if (error.Length > 1000) throw new InvalidDataException("Ticket command error is too long.");
            command = command with
            {
                State = state,
                AcknowledgedAtUtc = DateTimeOffset.UtcNow,
                Error = error,
                Result = input.Result ?? []
            };
            _state.Commands[command.Id] = command;
            Persist();
            return command;
        }
    }

    public IReadOnlyList<TicketCommand> List(string? portalId, string? ticketId, string? state, int limit)
    {
        lock (_sync)
        {
            var query = _state.Commands.Values.AsEnumerable();
            if (!string.IsNullOrWhiteSpace(portalId))
            {
                var portal = Identifier(portalId, "Portal ID");
                query = query.Where(value => value.PortalId == portal);
            }
            if (!string.IsNullOrWhiteSpace(ticketId))
            {
                var ticket = Identifier(ticketId, "Ticket ID");
                query = query.Where(value => value.TicketId == ticket);
            }
            if (!string.IsNullOrWhiteSpace(state))
            {
                if (state is not ("pending" or "completed" or "failed"))
                    throw new InvalidDataException("Unsupported ticket command state filter.");
                query = query.Where(value => value.State == state);
            }
            return query.OrderByDescending(value => value.RequestedAtUtc)
                .Take(Math.Clamp(limit == 0 ? 200 : limit, 1, 1000))
                .ToArray();
        }
    }

    private TicketCommandState Load()
    {
        if (!File.Exists(_path)) return new TicketCommandState(1, []);
        using var stream = File.OpenRead(_path);
        var value = JsonSerializer.Deserialize<TicketCommandState>(stream, JsonOptions)
            ?? throw new InvalidDataException("Ticket command store is empty.");
        if (value.Schema != 1) throw new InvalidDataException("Ticket command store schema is unsupported.");
        return value;
    }

    private void Persist()
    {
        var temporary = $"{_path}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                JsonSerializer.Serialize(stream, _state, JsonOptions);
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(temporary, _path, true);
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(_path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    private static string Identifier(string? value, string field)
    {
        var result = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (result.Length is < 2 or > 128 || result.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or ':' or '-')))
            throw new InvalidDataException($"{field} is invalid.");
        return result;
    }

    private static string IdempotencyKey(string? value)
    {
        var result = (value ?? string.Empty).Trim();
        if (result.Length is < 16 or > 180 || result.Any(character => char.IsWhiteSpace(character) || char.IsControl(character)))
            throw new InvalidDataException("Ticket command idempotency key is invalid.");
        return result;
    }

    private static string Actor(string? value)
    {
        var result = (value ?? string.Empty).Trim();
        if (result.Length is 0 or > 180) throw new InvalidDataException("Ticket command actor is invalid.");
        return result;
    }

    private static string Base64Url(byte[] value) =>
        Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

internal static class TicketCommandEndpoints
{
    public static IEndpointRouteBuilder MapTicketCommands(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/portal/v1/tickets/commands", PollAsync).AllowAnonymous();
        endpoints.MapPost("/api/portal/v1/tickets/commands/ack", AcknowledgeAsync).AllowAnonymous();

        var group = endpoints.MapGroup("/api/v1/ticket-commands")
            .RequireAuthorization(SirkPolicies.PortalManagement);
        group.MapGet("/", List);
        group.MapPost("/{portalId}/{ticketId}", CreateAsync);
        return endpoints;
    }

    private static IResult List(TicketCommandStore store, string? portalId, string? ticketId, string? state, int limit)
    {
        try { return Results.Ok(store.List(portalId, ticketId, state, limit)); }
        catch (InvalidDataException exception)
        { return Results.Json(new { ok = false, error = exception.Message }, statusCode: 400); }
    }

    private static async Task<IResult> CreateAsync(
        string portalId,
        string ticketId,
        TicketCommandCreateRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        TicketCommandStore store,
        SecurityAuditLog audit)
    {
        try
        {
            await antiforgery.ValidateRequestAsync(context);
            var actor = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown";
            var command = store.Create(portalId, ticketId, request, actor);
            Audit(audit, context, "ticket.command.created", command.Id, true, command.PortalId);
            return Results.Json(command, statusCode: 202);
        }
        catch (AntiforgeryValidationException)
        { return Results.Json(new { ok = false, code = "CSRF_VALIDATION_FAILED" }, statusCode: 400); }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException)
        { return Results.Json(new { ok = false, error = exception.Message }, statusCode: 409); }
    }

    private static async Task<IResult> PollAsync(
        HttpContext context,
        PortalRequestAuthenticator authenticator,
        TicketCommandStore store,
        CancellationToken cancellationToken)
    {
        var portal = await authenticator.AuthenticateAsync(context.Request, cancellationToken);
        if (portal is null) return Results.NotFound();
        return Results.Ok(new { commands = store.Poll(portal.PortalId, 50), generatedAtUtc = DateTimeOffset.UtcNow });
    }

    private static async Task<IResult> AcknowledgeAsync(
        HttpContext context,
        PortalRequestAuthenticator authenticator,
        TicketCommandStore store,
        SecurityAuditLog audit,
        CancellationToken cancellationToken)
    {
        var portal = await authenticator.AuthenticateAsync(context.Request, cancellationToken);
        if (portal is null) return Results.NotFound();
        try
        {
            var request = await context.Request.ReadFromJsonAsync<TicketCommandAckRequest>(cancellationToken)
                ?? throw new InvalidDataException("Ticket command acknowledgement is empty.");
            var command = store.Acknowledge(portal.PortalId, request);
            Audit(audit, context, "ticket.command.acknowledged", command.Id, command.State == "completed", command.PortalId);
            return Results.Ok(command);
        }
        catch (KeyNotFoundException exception)
        { return Results.Json(new { ok = false, error = exception.Message }, statusCode: 404); }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException or JsonException)
        { return Results.Json(new { ok = false, error = exception.Message }, statusCode: 409); }
    }

    private static void Audit(
        SecurityAuditLog audit,
        HttpContext context,
        string action,
        string target,
        bool success,
        string portalId) => audit.Write(new SecurityAuditEvent(
            context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? portalId,
            context.User.Identity?.Name ?? portalId,
            action,
            "ticket-command",
            target,
            success,
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            context.TraceIdentifier,
            new Dictionary<string, string> { ["portalId"] = portalId }));
}
