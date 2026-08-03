using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;

namespace Sirk.Central.Approvals;

internal sealed record ApprovalSubmitRequest(
    string Type,
    string Title,
    string Reason,
    int TtlMinutes,
    int RequiredApprovals,
    Dictionary<string, JsonElement>? Scope,
    Dictionary<string, JsonElement>? Payload);

internal sealed record ApprovalDecisionRequest(string Decision, string? Comment);
internal sealed record ApprovalExecutionRequest(string IdempotencyKey, string State, Dictionary<string, JsonElement>? Metadata);
internal sealed record ApprovalDecision(string Reviewer, string Decision, string Comment, DateTimeOffset DecidedAtUtc);
internal sealed record ApprovalExecution(
    bool Executed,
    string State,
    string ExecutedBy,
    string IdempotencyKey,
    DateTimeOffset ExecutedAtUtc,
    Dictionary<string, JsonElement> Metadata);
internal sealed record ApprovalRequest(
    string Id,
    string Type,
    string State,
    string Title,
    string Reason,
    string RequestedBy,
    DateTimeOffset RequestedAtUtc,
    DateTimeOffset ExpiresAtUtc,
    Dictionary<string, JsonElement> Scope,
    Dictionary<string, JsonElement> Payload,
    int RequiredApprovals,
    List<ApprovalDecision> Decisions,
    ApprovalExecution? Execution,
    DateTimeOffset? FinishedAtUtc);

internal sealed record ApprovalState(int Schema, Dictionary<string, ApprovalRequest> Requests);

internal sealed class ApprovalStore
{
    public static readonly HashSet<string> Types = new(StringComparer.Ordinal)
    {
        "role.assignment",
        "tenant.activation",
        "portal.enrollment",
        "operation.high-risk",
        "credential.use"
    };

    private static readonly HashSet<string> ExecutionStates = new(StringComparer.Ordinal)
    {
        "completed",
        "failed"
    };

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly object _sync = new();
    private readonly string _path;
    private ApprovalState _state;

    public ApprovalStore(IOptions<SecurityOptions> options)
    {
        Directory.CreateDirectory(options.Value.DataRoot);
        _path = Path.Combine(options.Value.DataRoot, "approvals.net10.json");
        _state = Load();
    }

    public ApprovalRequest Submit(ApprovalSubmitRequest input, string actor)
    {
        lock (_sync)
        {
            ExpireInternal();
            var type = input.Type ?? string.Empty;
            if (!Types.Contains(type)) throw new InvalidDataException("Unsupported approval type.");
            var now = DateTimeOffset.UtcNow;
            var ttl = Math.Clamp(input.TtlMinutes == 0 ? 60 : input.TtlMinutes, 5, 1440);
            var request = new ApprovalRequest(
                "apr-" + Base64Url(RandomNumberGenerator.GetBytes(18)).ToLowerInvariant(),
                type,
                "pending",
                Normalize(input.Title, 160, "Title"),
                Normalize(input.Reason, 1000, "Reason"),
                NormalizeActor(actor),
                now,
                now.AddMinutes(ttl),
                input.Scope ?? [],
                input.Payload ?? [],
                Math.Clamp(input.RequiredApprovals == 0 ? 1 : input.RequiredApprovals, 1, 2),
                [],
                null,
                null);
            _state.Requests.Add(request.Id, request);
            Persist();
            return request;
        }
    }

    public ApprovalRequest Decide(string id, ApprovalDecisionRequest input, string actor)
    {
        lock (_sync)
        {
            ExpireInternal();
            if (input.Decision is not ("approve" or "reject"))
                throw new InvalidDataException("Unsupported approval decision.");
            var request = GetRequired(id);
            if (request.State != "pending") throw new InvalidOperationException("Approval request is no longer pending.");
            var reviewer = NormalizeActor(actor);
            if (reviewer == request.RequestedBy) throw new InvalidOperationException("Requester cannot approve their own request.");
            if (request.Decisions.Any(value => value.Reviewer == reviewer))
                throw new InvalidOperationException("Reviewer already decided this request.");

            var comment = (input.Comment ?? string.Empty).Trim();
            if (comment.Length > 1000) comment = comment[..1000];
            var decisions = request.Decisions.ToList();
            decisions.Add(new ApprovalDecision(reviewer, input.Decision, comment, DateTimeOffset.UtcNow));
            var state = input.Decision == "reject"
                ? "rejected"
                : decisions.Count(value => value.Decision == "approve") >= request.RequiredApprovals
                    ? "approved"
                    : "pending";
            request = request with
            {
                Decisions = decisions,
                State = state,
                FinishedAtUtc = state == "pending" ? null : DateTimeOffset.UtcNow
            };
            _state.Requests[id] = request;
            Persist();
            return request;
        }
    }

    public ApprovalRequest Cancel(string id, string actor)
    {
        lock (_sync)
        {
            ExpireInternal();
            var request = GetRequired(id);
            if (request.State != "pending") throw new InvalidOperationException("Approval request is no longer pending.");
            if (request.RequestedBy != NormalizeActor(actor))
                throw new InvalidOperationException("Only the requester may cancel this request.");
            request = request with { State = "cancelled", FinishedAtUtc = DateTimeOffset.UtcNow };
            _state.Requests[id] = request;
            Persist();
            return request;
        }
    }

    public ApprovalRequest MarkExecution(string id, ApprovalExecutionRequest input, string actor)
    {
        lock (_sync)
        {
            var request = GetRequired(id);
            if (request.State != "approved")
                throw new InvalidOperationException("Only an approved request may be executed.");
            var key = NormalizeIdempotencyKey(input.IdempotencyKey);
            if (request.Execution is not null)
            {
                if (string.Equals(request.Execution.IdempotencyKey, key, StringComparison.Ordinal)) return request;
                throw new InvalidOperationException("Approval request has already been executed with another idempotency key.");
            }
            var state = (input.State ?? string.Empty).Trim().ToLowerInvariant();
            if (!ExecutionStates.Contains(state)) throw new InvalidDataException("Unsupported execution state.");
            request = request with
            {
                Execution = new ApprovalExecution(
                    true,
                    state,
                    NormalizeActor(actor),
                    key,
                    DateTimeOffset.UtcNow,
                    input.Metadata ?? [])
            };
            _state.Requests[id] = request;
            Persist();
            return request;
        }
    }

    public IReadOnlyList<ApprovalRequest> List(string? state, string? type)
    {
        lock (_sync)
        {
            ExpireInternal();
            return _state.Requests.Values
                .Where(value => string.IsNullOrEmpty(state) || value.State == state)
                .Where(value => string.IsNullOrEmpty(type) || value.Type == type)
                .OrderByDescending(value => value.RequestedAtUtc)
                .ToArray();
        }
    }

    private ApprovalRequest GetRequired(string id) =>
        _state.Requests.TryGetValue(id ?? string.Empty, out var value)
            ? value
            : throw new KeyNotFoundException("Approval request not found.");

    private void ExpireInternal()
    {
        var changed = false;
        foreach (var pair in _state.Requests.ToArray())
        {
            if (pair.Value.State == "pending" && pair.Value.ExpiresAtUtc <= DateTimeOffset.UtcNow)
            {
                _state.Requests[pair.Key] = pair.Value with
                {
                    State = "expired",
                    FinishedAtUtc = DateTimeOffset.UtcNow
                };
                changed = true;
            }
        }
        if (changed) Persist();
    }

    private ApprovalState Load()
    {
        if (!File.Exists(_path)) return new ApprovalState(1, []);
        using var stream = File.OpenRead(_path);
        var state = JsonSerializer.Deserialize<ApprovalState>(stream, JsonOptions)
            ?? throw new InvalidDataException("Approval store is empty.");
        if (state.Schema != 1) throw new InvalidDataException("Approval store schema is unsupported.");
        return state;
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

    private static string Normalize(string? value, int max, string field)
    {
        var text = string.Join(' ', (value ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (text.Length is 0 || text.Length > max) throw new InvalidDataException($"{field} is invalid.");
        return text;
    }

    private static string NormalizeActor(string value)
    {
        var actor = (value ?? string.Empty).Trim();
        if (actor.Length is 0 or > 180) throw new InvalidDataException("Actor identity is invalid.");
        return actor;
    }

    private static string NormalizeIdempotencyKey(string? value)
    {
        var key = (value ?? string.Empty).Trim();
        if (key.Length is < 16 or > 180 || key.Any(character => char.IsControl(character) || char.IsWhiteSpace(character)))
            throw new InvalidDataException("Execution idempotency key is invalid.");
        return key;
    }

    private static string Base64Url(byte[] value) =>
        Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static void SecureFile(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}

internal static class ApprovalEndpoints
{
    public static IEndpointRouteBuilder MapApprovals(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/approvals")
            .RequireAuthorization(SirkPolicies.PortalManagement);
        group.MapGet("/", (ApprovalStore store, string? state, string? type) => Results.Ok(store.List(state, type)));
        group.MapPost("/", SubmitAsync);
        group.MapPost("/{id}/decision", DecideAsync);
        group.MapPost("/{id}/cancel", CancelAsync);
        group.MapPost("/{id}/execution", ExecuteAsync);
        return endpoints;
    }

    private static async Task<IResult> SubmitAsync(
        ApprovalSubmitRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        ApprovalStore store,
        SecurityAuditLog audit)
    {
        if (!await Csrf(context, antiforgery)) return Failure("CSRF_VALIDATION_FAILED", 400);
        return Execute(() =>
        {
            var actor = Actor(context);
            var value = store.Submit(request, actor);
            Audit(audit, context, "approval.submit", value.Id, true);
            return Results.Ok(value);
        });
    }

    private static async Task<IResult> DecideAsync(
        string id,
        ApprovalDecisionRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        ApprovalStore store,
        SecurityAuditLog audit)
    {
        if (!await Csrf(context, antiforgery)) return Failure("CSRF_VALIDATION_FAILED", 400);
        return Execute(() =>
        {
            var value = store.Decide(id, request, Actor(context));
            Audit(audit, context, "approval.decide", id, true);
            return Results.Ok(value);
        });
    }

    private static async Task<IResult> CancelAsync(
        string id,
        HttpContext context,
        IAntiforgery antiforgery,
        ApprovalStore store,
        SecurityAuditLog audit)
    {
        if (!await Csrf(context, antiforgery)) return Failure("CSRF_VALIDATION_FAILED", 400);
        return Execute(() =>
        {
            var value = store.Cancel(id, Actor(context));
            Audit(audit, context, "approval.cancel", id, true);
            return Results.Ok(value);
        });
    }

    private static async Task<IResult> ExecuteAsync(
        string id,
        ApprovalExecutionRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        ApprovalStore store,
        SecurityAuditLog audit)
    {
        if (!await Csrf(context, antiforgery)) return Failure("CSRF_VALIDATION_FAILED", 400);
        return Execute(() =>
        {
            var value = store.MarkExecution(id, request, Actor(context));
            Audit(audit, context, "approval.execute", id, value.Execution?.State == "completed");
            return Results.Ok(value);
        });
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

    private static string Actor(HttpContext context) =>
        context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown";

    private static void Audit(SecurityAuditLog audit, HttpContext context, string action, string target, bool success) =>
        audit.Write(new SecurityAuditEvent(
            Actor(context),
            context.User.Identity?.Name ?? "unknown",
            action,
            "approval",
            target,
            success,
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            context.TraceIdentifier));

    private static IResult Failure(string code, int status) => Results.Json(new { ok = false, code }, statusCode: status);
}
