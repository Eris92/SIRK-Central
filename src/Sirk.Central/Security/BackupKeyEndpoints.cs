using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;
using Sirk.Central.Backup;

namespace Sirk.Central.Security;

internal sealed record BackupKeySetRequest(
    string Identity,
    string Recipient,
    string Password,
    bool Rotate);

internal sealed record BackupKeyPasswordRequest(string Password);
internal sealed record BackupKeyRewrapRequest(string CurrentPassword, string NewPassword);

internal static class BackupKeyEndpoints
{
    public static IEndpointRouteBuilder MapBackupKeyLifecycle(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/security/backup-key")
            .RequireAuthorization(SirkPolicies.SecurityAdministration);

        group.MapGet("/status", (BackupKeyStore store) => Results.Ok(store.GetStatus()));
        group.MapPost("/set", SetAsync);
        group.MapPost("/unlock", UnlockAsync);
        group.MapPost("/rewrap", RewrapAsync);
        group.MapPost("/export", ExportAsync);
        endpoints.MapSirkBackup();
        return endpoints;
    }

    private static async Task<IResult> SetAsync(
        BackupKeySetRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        BackupKeyStore store,
        SecurityAuditLog auditLog)
    {
        var csrf = await ValidateCsrfAsync(context, antiforgery);
        if (csrf is not null) return csrf;
        try
        {
            var status = store.SetIdentity(request.Identity, request.Recipient,
                request.Password, Actor(context), request.Rotate);
            Audit(auditLog, context, "backup-key.set", true,
                new Dictionary<string, string>
                {
                    ["recipient"] = status.Recipient,
                    ["rotation"] = status.Rotation.ToString(),
                    ["rotated"] = request.Rotate.ToString()
                });
            return Results.Ok(status);
        }
        catch (Exception exception) when (exception is InvalidDataException or UnauthorizedAccessException)
        {
            Audit(auditLog, context, "backup-key.set", false);
            return Failure(exception);
        }
    }

    private static async Task<IResult> UnlockAsync(
        BackupKeyPasswordRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        BackupKeyStore store,
        SecurityAuditLog auditLog)
    {
        var csrf = await ValidateCsrfAsync(context, antiforgery);
        if (csrf is not null) return csrf;
        try
        {
            var unlocked = store.Unlock(request.Password);
            Audit(auditLog, context, "backup-key.unlock", true,
                new Dictionary<string, string> { ["recipient"] = unlocked.Recipient });
            return Results.Ok(new { ok = true, recipient = unlocked.Recipient });
        }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException or UnauthorizedAccessException)
        {
            Audit(auditLog, context, "backup-key.unlock", false);
            return Failure(exception);
        }
    }

    private static async Task<IResult> RewrapAsync(
        BackupKeyRewrapRequest request,
        HttpContext context,
        IAntiforgery antiforgery,
        BackupKeyStore store,
        SecurityAuditLog auditLog)
    {
        var csrf = await ValidateCsrfAsync(context, antiforgery);
        if (csrf is not null) return csrf;
        try
        {
            var status = store.Rewrap(request.CurrentPassword, request.NewPassword, Actor(context));
            Audit(auditLog, context, "backup-key.rewrap", true,
                new Dictionary<string, string> { ["rotation"] = status.Rotation.ToString() });
            return Results.Ok(status);
        }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException or UnauthorizedAccessException)
        {
            Audit(auditLog, context, "backup-key.rewrap", false);
            return Failure(exception);
        }
    }

    private static async Task<IResult> ExportAsync(
        HttpContext context,
        IAntiforgery antiforgery,
        BackupKeyStore store,
        SecurityAuditLog auditLog)
    {
        var csrf = await ValidateCsrfAsync(context, antiforgery);
        if (csrf is not null) return csrf;
        try
        {
            var payload = store.ExportEncrypted();
            Audit(auditLog, context, "backup-key.export", true);
            return Results.File(payload, "application/json",
                $"sirk-central-backup-key-{DateTimeOffset.UtcNow:yyyyMMddHHmmss}.json");
        }
        catch (InvalidOperationException exception)
        {
            Audit(auditLog, context, "backup-key.export", false);
            return Failure(exception);
        }
    }

    private static async Task<IResult?> ValidateCsrfAsync(HttpContext context, IAntiforgery antiforgery)
    {
        try
        {
            await antiforgery.ValidateRequestAsync(context);
            return null;
        }
        catch (AntiforgeryValidationException)
        {
            return Results.Json(new
            {
                ok = false,
                code = "CSRF_VALIDATION_FAILED",
                error = "CSRF validation failed."
            }, statusCode: StatusCodes.Status400BadRequest);
        }
    }

    private static IResult Failure(Exception exception) => exception switch
    {
        UnauthorizedAccessException => Results.Json(new
        {
            ok = false,
            code = "BACKUP_KEY_UNLOCK_FAILED",
            error = "Break-Glass password cannot unlock the backup key."
        }, statusCode: StatusCodes.Status401Unauthorized),
        InvalidOperationException => Results.Json(new
        {
            ok = false,
            code = "BACKUP_KEY_NOT_CONFIGURED",
            error = exception.Message
        }, statusCode: StatusCodes.Status409Conflict),
        _ => Results.Json(new
        {
            ok = false,
            code = "BACKUP_KEY_INVALID",
            error = exception.Message
        }, statusCode: StatusCodes.Status400BadRequest)
    };

    private static string Actor(HttpContext context) =>
        context.User.Identity?.Name ?? "break-glass";

    private static void Audit(SecurityAuditLog auditLog, HttpContext context,
        string action, bool success, IReadOnlyDictionary<string, string>? metadata = null)
    {
        auditLog.Write(new SecurityAuditEvent(
            context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown",
            Actor(context), action, "backup-key", "local", success,
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            context.TraceIdentifier, metadata));
    }
}
