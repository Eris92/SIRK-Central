using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;
using Sirk.Central.Security;

namespace Sirk.Central.Backup;

internal sealed record RestoreBackupRequest(string FileName, string Password, string Confirmation);

internal static class BackupEndpoints
{
    public static IEndpointRouteBuilder MapSirkBackup(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/backups")
            .RequireAuthorization(SirkPolicies.BackupAdministration);

        group.MapGet("/", (BackupArchiveService service) => Results.Ok(service.List()));
        group.MapPost("/", CreateAsync);
        group.MapPost("/restore", RestoreAsync);
        return endpoints;
    }

    private static async Task<IResult> CreateAsync(
        HttpContext context,
        IAntiforgery antiforgery,
        BackupArchiveService service,
        SecurityAuditLog auditLog)
    {
        if (!await ValidateCsrfAsync(context, antiforgery)) return CsrfFailure();
        var actor = Actor(context);
        try
        {
            var info = await service.CreateAsync(context.RequestAborted);
            auditLog.Write(new SecurityAuditEvent(
                actor.Id,
                actor.Name,
                "backup.create",
                "backup",
                info.FileName,
                true,
                RemoteAddress(context),
                context.TraceIdentifier,
                new Dictionary<string, string>
                {
                    ["sha256"] = info.Sha256,
                    ["recipient"] = info.Recipient,
                    ["keyRotation"] = info.KeyRotation.ToString()
                }));
            return Results.Ok(info);
        }
        catch (Exception exception) when (exception is InvalidOperationException or InvalidDataException or IOException)
        {
            auditLog.Write(new SecurityAuditEvent(
                actor.Id,
                actor.Name,
                "backup.create",
                "backup",
                string.Empty,
                false,
                RemoteAddress(context),
                context.TraceIdentifier,
                new Dictionary<string, string> { ["reason"] = exception.GetType().Name }));
            return Results.Problem(statusCode: StatusCodes.Status409Conflict, title: exception.Message);
        }
    }

    private static async Task<IResult> RestoreAsync(
        RestoreBackupRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        BackupArchiveService service,
        SecurityAuditLog auditLog)
    {
        if (!await ValidateCsrfAsync(context, antiforgery)) return CsrfFailure();
        if (!string.Equals(request.Confirmation, "RESTORE SIRK CENTRAL", StringComparison.Ordinal))
            return Results.Json(new { ok = false, code = "RESTORE_CONFIRMATION_INVALID" }, statusCode: 400);

        var actor = Actor(context);
        try
        {
            await service.RestoreAsync(request.FileName, request.Password, context.RequestAborted);
            auditLog.Write(new SecurityAuditEvent(
                actor.Id,
                actor.Name,
                "backup.restore",
                "backup",
                request.FileName,
                true,
                RemoteAddress(context),
                context.TraceIdentifier));
            await context.SignOutAsync(SirkAuthenticationSchemes.Session);
            return Results.Ok(new { ok = true, restartRequired = true });
        }
        catch (UnauthorizedAccessException)
        {
            auditLog.Write(new SecurityAuditEvent(
                actor.Id,
                actor.Name,
                "backup.restore",
                "backup",
                request.FileName ?? string.Empty,
                false,
                RemoteAddress(context),
                context.TraceIdentifier,
                new Dictionary<string, string> { ["reason"] = "key-unlock-failed" }));
            return Results.Json(new { ok = false, code = "BACKUP_KEY_UNLOCK_FAILED" }, statusCode: 401);
        }
        catch (Exception exception) when (exception is InvalidOperationException or InvalidDataException or IOException)
        {
            auditLog.Write(new SecurityAuditEvent(
                actor.Id,
                actor.Name,
                "backup.restore",
                "backup",
                request.FileName ?? string.Empty,
                false,
                RemoteAddress(context),
                context.TraceIdentifier,
                new Dictionary<string, string> { ["reason"] = exception.GetType().Name }));
            return Results.Problem(statusCode: StatusCodes.Status409Conflict, title: exception.Message);
        }
    }

    private static async Task<bool> ValidateCsrfAsync(HttpContext context, IAntiforgery antiforgery)
    {
        try
        {
            await antiforgery.ValidateRequestAsync(context);
            return true;
        }
        catch (AntiforgeryValidationException)
        {
            return false;
        }
    }

    private static IResult CsrfFailure() => Results.Json(
        new { ok = false, code = "CSRF_VALIDATION_FAILED" },
        statusCode: StatusCodes.Status400BadRequest);

    private static (string Id, string Name) Actor(HttpContext context) =>
        (context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown",
         context.User.Identity?.Name ?? "unknown");

    private static string RemoteAddress(HttpContext context) =>
        (context.Connection.RemoteIpAddress?.ToString() ?? "unknown")[..
            Math.Min((context.Connection.RemoteIpAddress?.ToString() ?? "unknown").Length, 128)];
}
