using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;

namespace Sirk.Central.Security;

internal static class EntraSettingsEndpoints
{
    public static IEndpointRouteBuilder MapEntraSettings(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/security/entra")
            .RequireAuthorization(SirkPolicies.SecurityAdministration);

        group.MapGet("/", (EntraSettingsStore store) => Results.Ok(store.GetPublic()));
        group.MapPut("/", UpdateAsync);
        return endpoints;
    }

    private static async Task<IResult> UpdateAsync(
        EntraSettingsUpdate request,
        HttpContext context,
        IAntiforgery antiforgery,
        EntraSettingsStore store,
        SecurityAuditLog auditLog)
    {
        try
        {
            await antiforgery.ValidateRequestAsync(context);
        }
        catch (AntiforgeryValidationException)
        {
            return Results.Json(
                new { ok = false, code = "CSRF_VALIDATION_FAILED" },
                statusCode: StatusCodes.Status400BadRequest);
        }

        var actorId = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown";
        var actorName = context.User.Identity?.Name ?? "unknown";
        try
        {
            var result = store.Update(request);
            auditLog.Write(new SecurityAuditEvent(
                actorId,
                actorName,
                "entra.settings.update",
                "entra",
                result.ClientId,
                true,
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                context.TraceIdentifier,
                new Dictionary<string, string>
                {
                    ["enabled"] = result.Enabled.ToString(),
                    ["tenant"] = result.Tenant,
                    ["allowedIdentities"] = result.AllowedIdentities.Count.ToString()
                }));
            return Results.Ok(result);
        }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException)
        {
            auditLog.Write(new SecurityAuditEvent(
                actorId,
                actorName,
                "entra.settings.update",
                "entra",
                string.Empty,
                false,
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                context.TraceIdentifier,
                new Dictionary<string, string>
                {
                    ["reason"] = exception.GetType().Name
                }));
            return Results.Json(
                new { ok = false, code = "ENTRA_SETTINGS_INVALID", error = exception.Message },
                statusCode: StatusCodes.Status400BadRequest);
        }
    }
}
