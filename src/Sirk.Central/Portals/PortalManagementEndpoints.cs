using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;

namespace Sirk.Central.Portals;

internal sealed record CreatePortalRequest(
    string Id,
    string Name);

internal sealed record RenamePortalRequest(
    string Name);

internal static class PortalManagementEndpoints
{
    public static IEndpointRouteBuilder MapPortalManagement(
        this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints
            .MapGroup("/api/v1/admin/portals")
            .RequireAuthorization(SirkPolicies.PortalManagement);

        group.MapGet("/", List);
        group.MapGet("/{portalId}", Get);
        group.MapPost("/", CreateAsync);
        group.MapPatch("/{portalId}", RenameAsync);
        group.MapPost("/{portalId}/rotate-token", RotateTokenAsync);
        group.MapDelete("/{portalId}", RemoveAsync);

        return endpoints;
    }

    private static IResult List(
        HttpContext context,
        FilePortalRegistry registry,
        PortalTelemetryStore telemetry,
        IOptions<PortalProtocolOptions> options)
    {
        NoStore(context);
        var now = DateTimeOffset.UtcNow;
        var offlineAfter = TimeSpan.FromSeconds(options.Value.OfflineAfterSeconds);
        var portals = registry.List()
            .Select(portal => ToManagementView(
                portal,
                telemetry.Get(portal.Id),
                now,
                offlineAfter))
            .ToArray();

        return Results.Ok(new
        {
            ok = true,
            portals
        });
    }

    private static IResult Get(
        string portalId,
        HttpContext context,
        FilePortalRegistry registry,
        PortalTelemetryStore telemetry,
        IOptions<PortalProtocolOptions> options)
    {
        NoStore(context);
        var portal = registry.Get(portalId);
        if (portal is null)
        {
            return NotFound();
        }

        return Results.Ok(new
        {
            ok = true,
            portal = ToManagementView(
                portal,
                telemetry.Get(portal.Id),
                DateTimeOffset.UtcNow,
                TimeSpan.FromSeconds(options.Value.OfflineAfterSeconds))
        });
    }

    private static async Task<IResult> CreateAsync(
        CreatePortalRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        FilePortalRegistry registry,
        SecurityAuditLog auditLog)
    {
        NoStore(context);
        var csrfError = await ValidateCsrfAsync(context, antiforgery);
        if (csrfError is not null)
        {
            return csrfError;
        }

        var actor = Actor(context);
        try
        {
            var issued = registry.Create(request.Id, request.Name);
            Audit(
                auditLog,
                context,
                actor,
                "portal.create",
                issued.Portal.Id,
                true,
                new Dictionary<string, string>
                {
                    ["name"] = issued.Portal.Name
                });

            return Results.Created(
                $"/api/v1/admin/portals/{Uri.EscapeDataString(issued.Portal.Id)}",
                new
                {
                    ok = true,
                    portal = issued.Portal,
                    credential = new
                    {
                        portalId = issued.Portal.Id,
                        portalName = issued.Portal.Name,
                        portalToken = issued.Token,
                        issuedAtUtc = DateTimeOffset.UtcNow,
                        shownOnce = true
                    }
                });
        }
        catch (PortalRegistryConflictException exception)
        {
            AuditFailure(auditLog, context, actor, "portal.create", request.Id, "conflict");
            return Conflict("PORTAL_ALREADY_EXISTS", exception.Message);
        }
        catch (ArgumentException exception)
        {
            AuditFailure(auditLog, context, actor, "portal.create", request.Id, "validation");
            return Validation(exception.Message);
        }
    }

    private static async Task<IResult> RenameAsync(
        string portalId,
        RenamePortalRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        FilePortalRegistry registry,
        SecurityAuditLog auditLog)
    {
        NoStore(context);
        var csrfError = await ValidateCsrfAsync(context, antiforgery);
        if (csrfError is not null)
        {
            return csrfError;
        }

        var actor = Actor(context);
        try
        {
            var portal = registry.Rename(portalId, request.Name);
            Audit(
                auditLog,
                context,
                actor,
                "portal.rename",
                portal.Id,
                true,
                new Dictionary<string, string>
                {
                    ["name"] = portal.Name
                });
            return Results.Ok(new { ok = true, portal });
        }
        catch (PortalRegistryNotFoundException)
        {
            AuditFailure(auditLog, context, actor, "portal.rename", portalId, "not-found");
            return NotFound();
        }
        catch (ArgumentException exception)
        {
            AuditFailure(auditLog, context, actor, "portal.rename", portalId, "validation");
            return Validation(exception.Message);
        }
    }

    private static async Task<IResult> RotateTokenAsync(
        string portalId,
        HttpContext context,
        IAntiforgery antiforgery,
        FilePortalRegistry registry,
        SecurityAuditLog auditLog)
    {
        NoStore(context);
        var csrfError = await ValidateCsrfAsync(context, antiforgery);
        if (csrfError is not null)
        {
            return csrfError;
        }

        var actor = Actor(context);
        try
        {
            var issued = registry.RotateToken(portalId);
            Audit(
                auditLog,
                context,
                actor,
                "portal.token.rotate",
                issued.Portal.Id,
                true);
            return Results.Ok(new
            {
                ok = true,
                portal = issued.Portal,
                credential = new
                {
                    portalId = issued.Portal.Id,
                    portalName = issued.Portal.Name,
                    portalToken = issued.Token,
                    issuedAtUtc = DateTimeOffset.UtcNow,
                    shownOnce = true
                }
            });
        }
        catch (PortalRegistryNotFoundException)
        {
            AuditFailure(auditLog, context, actor, "portal.token.rotate", portalId, "not-found");
            return NotFound();
        }
        catch (ArgumentException exception)
        {
            AuditFailure(auditLog, context, actor, "portal.token.rotate", portalId, "validation");
            return Validation(exception.Message);
        }
    }

    private static async Task<IResult> RemoveAsync(
        string portalId,
        HttpContext context,
        IAntiforgery antiforgery,
        FilePortalRegistry registry,
        PortalTelemetryStore telemetry,
        SecurityAuditLog auditLog)
    {
        NoStore(context);
        var csrfError = await ValidateCsrfAsync(context, antiforgery);
        if (csrfError is not null)
        {
            return csrfError;
        }

        var actor = Actor(context);
        try
        {
            var removed = registry.Remove(portalId);
            if (removed is null)
            {
                AuditFailure(auditLog, context, actor, "portal.remove", portalId, "not-found");
                return NotFound();
            }

            telemetry.Remove(removed.Id);
            Audit(
                auditLog,
                context,
                actor,
                "portal.remove",
                removed.Id,
                true,
                new Dictionary<string, string>
                {
                    ["name"] = removed.Name
                });
            return Results.Ok(new { ok = true, portal = removed });
        }
        catch (ArgumentException exception)
        {
            AuditFailure(auditLog, context, actor, "portal.remove", portalId, "validation");
            return Validation(exception.Message);
        }
    }

    private static object ToManagementView(
        PortalSummary portal,
        PortalHeartbeatSnapshot? heartbeat,
        DateTimeOffset now,
        TimeSpan offlineAfter)
    {
        var connected = heartbeat is not null && now - heartbeat.ReceivedAtUtc <= offlineAfter;
        return new
        {
            portal.Id,
            portal.Name,
            portal.CreatedAtUtc,
            portal.UpdatedAtUtc,
            portal.TokenRotatedAtUtc,
            connected,
            connectionState = connected ? "online" : "offline",
            heartbeat = heartbeat is null
                ? null
                : new
                {
                    heartbeat.ReceivedAtUtc,
                    heartbeat.RemoteAddress,
                    heartbeat.Metrics.ProtocolVersion,
                    heartbeat.Metrics.PortalVersion,
                    heartbeat.Metrics.BuildCommit,
                    heartbeat.Metrics.Platform,
                    heartbeat.Metrics.Hostname,
                    heartbeat.Metrics.PublicUrl,
                    heartbeat.Metrics.Health,
                    heartbeat.Metrics.AgentCount,
                    heartbeat.Metrics.OnlineAgents,
                    heartbeat.Metrics.UpdateChannel,
                    heartbeat.Metrics.AvailableVersion,
                    heartbeat.Metrics.Capabilities
                }
        };
    }

    private static async Task<IResult?> ValidateCsrfAsync(
        HttpContext context,
        IAntiforgery antiforgery)
    {
        try
        {
            await antiforgery.ValidateRequestAsync(context);
            return null;
        }
        catch (AntiforgeryValidationException)
        {
            return Results.Json(
                new
                {
                    ok = false,
                    code = "CSRF_VALIDATION_FAILED",
                    error = "CSRF validation failed."
                },
                statusCode: StatusCodes.Status400BadRequest);
        }
    }

    private static (string Id, string Name) Actor(HttpContext context) =>
        (
            context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown",
            context.User.Identity?.Name ?? "unknown");

    private static void Audit(
        SecurityAuditLog auditLog,
        HttpContext context,
        (string Id, string Name) actor,
        string action,
        string targetId,
        bool success,
        IReadOnlyDictionary<string, string>? details = null)
    {
        auditLog.Write(new SecurityAuditEvent(
            actor.Id,
            actor.Name,
            action,
            "portal",
            NormalizeTargetId(targetId),
            success,
            RemoteAddress(context),
            context.TraceIdentifier,
            details));
    }

    private static void AuditFailure(
        SecurityAuditLog auditLog,
        HttpContext context,
        (string Id, string Name) actor,
        string action,
        string targetId,
        string reason)
    {
        Audit(
            auditLog,
            context,
            actor,
            action,
            targetId,
            false,
            new Dictionary<string, string>
            {
                ["reason"] = reason
            });
    }

    private static string NormalizeTargetId(string? value)
    {
        var normalized = (value ?? string.Empty).Trim();
        return normalized.Length <= 128 ? normalized : normalized[..128];
    }

    private static string RemoteAddress(HttpContext context)
    {
        var address = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return address[..Math.Min(address.Length, 128)];
    }

    private static void NoStore(HttpContext context)
    {
        context.Response.Headers["Cache-Control"] = "no-store";
        context.Response.Headers["Pragma"] = "no-cache";
    }

    private static IResult NotFound() =>
        Results.Json(
            new
            {
                ok = false,
                code = "PORTAL_NOT_FOUND",
                error = "Portal was not found."
            },
            statusCode: StatusCodes.Status404NotFound);

    private static IResult Conflict(string code, string message) =>
        Results.Json(
            new
            {
                ok = false,
                code,
                error = message
            },
            statusCode: StatusCodes.Status409Conflict);

    private static IResult Validation(string message) =>
        Results.Json(
            new
            {
                ok = false,
                code = "VALIDATION_FAILED",
                error = message
            },
            statusCode: StatusCodes.Status400BadRequest);
}
