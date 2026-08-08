using Microsoft.AspNetCore.Antiforgery;
using Sirk.Central.Security;

namespace Sirk.Central.Operations;

internal sealed record WebUpdateRequest(string? Confirm, string? Channel);

internal static class HostUpdateEndpoints
{
    public static void Map(IEndpointRouteBuilder endpoints)
    {
        foreach (var path in new[]
                 {
                     "/api/settings/update/status",
                     "/api/system-update/status"
                 })
            endpoints.MapGet(path, Status)
                .RequireAuthorization(SirkPolicies.PortalManagement);

        foreach (var path in new[]
                 {
                     "/api/settings/update/run",
                     "/api/system-update/run"
                 })
            endpoints.MapPost(path, RunAsync)
                .RequireAuthorization(SirkPolicies.PortalManagement);
    }

    private static IResult Status(OperationsStore store) =>
        Results.Ok(new { status = store.ReadHostUpdateStatus() });

    private static async Task<IResult> RunAsync(
        HttpContext context,
        IAntiforgery antiforgery,
        OperationsStore store)
    {
        try { await antiforgery.ValidateRequestAsync(context); }
        catch (AntiforgeryValidationException)
        {
            return Results.Json(new { ok = false, code = "CSRF_VALIDATION_FAILED",
                error = "CSRF validation failed." }, statusCode: 400);
        }

        WebUpdateRequest? request = null;
        if (context.Request.ContentLength is > 0)
            request = await context.Request.ReadFromJsonAsync<WebUpdateRequest>(
                cancellationToken: context.RequestAborted);
        var confirmation = request?.Confirm ??
                           context.Request.Headers["X-SIRK-Update-Confirm"].ToString();
        if (!string.Equals(confirmation, "UPDATE SIRK CENTRAL", StringComparison.Ordinal))
            return Results.Conflict(new { ok = false, error = "Update confirmation phrase is invalid." });

        var channel = request?.Channel;
        if (string.IsNullOrWhiteSpace(channel)) channel = store.Policy().Channel;
        try
        {
            var actor = context.User.FindFirst(
                System.Security.Claims.ClaimTypes.NameIdentifier)?.Value ?? "unknown";
            var job = store.QueueHostUpdate(channel, actor);
            return Results.Accepted(value: new
            {
                ok = true,
                jobId = job.Id,
                startedAtUtc = job.CreatedAtUtc
            });
        }
        catch (Exception error) when (error is InvalidDataException or InvalidOperationException)
        {
            return Results.Conflict(new { ok = false, error = error.Message });
        }
    }
}
