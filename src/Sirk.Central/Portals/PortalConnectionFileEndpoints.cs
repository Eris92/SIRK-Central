using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Sirk.Central.Security;

namespace Sirk.Central.Portals;

internal sealed record PortalConnectionFileDocument(
    int SchemaVersion,
    string CentralUrl,
    string TunnelUrl,
    string PortalId,
    string PortalName,
    string PortalToken,
    string PublicUrl,
    DateTimeOffset UpdatedAtUtc);

internal static class PortalConnectionFileEndpoints
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    public static IEndpointRouteBuilder MapPortalConnectionFiles(
        this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost(
                "/api/v1/admin/portals/{portalId}/connection-file",
                DownloadAsync)
            .RequireAuthorization(SirkPolicies.PortalManagement);
        return endpoints;
    }

    internal static PortalConnectionFileDocument CreateDocument(
        HttpRequest request,
        PortalCredentialIssue issued)
    {
        if (!request.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "Portal connection files can be generated only through the public HTTPS endpoint of SIRK Central.");
        }
        if (!request.Host.HasValue)
            throw new InvalidOperationException("Public SIRK Central host is unavailable.");

        var host = request.Host.Value;
        var centralUrl = $"https://{host}";
        var tunnelUrl = $"wss://{host}/tunnel";
        _ = ValidateOrigin(centralUrl, Uri.UriSchemeHttps);
        _ = ValidateTunnel(tunnelUrl, host);

        return new PortalConnectionFileDocument(
            1,
            centralUrl,
            tunnelUrl,
            issued.Portal.Id,
            issued.Portal.Name,
            issued.Token,
            string.Empty,
            DateTimeOffset.UtcNow);
    }

    private static async Task<IResult> DownloadAsync(
        string portalId,
        HttpContext context,
        IAntiforgery antiforgery,
        FilePortalRegistry registry,
        SecurityAuditLog auditLog)
    {
        NoStore(context);
        try
        {
            await antiforgery.ValidateRequestAsync(context);
        }
        catch (AntiforgeryValidationException)
        {
            return Error(
                400,
                "CSRF_VALIDATION_FAILED",
                "CSRF validation failed.");
        }

        PortalCredentialIssue issued;
        try
        {
            issued = registry.RotateToken(portalId);
        }
        catch (PortalRegistryNotFoundException)
        {
            Audit(auditLog, context, portalId, false, "not-found");
            return Error(404, "PORTAL_NOT_FOUND", "Portal was not found.");
        }
        catch (ArgumentException exception)
        {
            Audit(auditLog, context, portalId, false, "validation");
            return Error(400, "PORTAL_ID_INVALID", exception.Message);
        }

        try
        {
            var document = CreateDocument(context.Request, issued);
            var bytes = JsonSerializer.SerializeToUtf8Bytes(document, JsonOptions);
            Audit(auditLog, context, issued.Portal.Id, true, "issued");
            context.Response.Headers["X-SIRK-Credential-Rotated"] = "true";
            context.Response.Headers["X-SIRK-Credential-Shown-Once"] = "true";
            return Results.File(
                bytes,
                "application/json; charset=utf-8",
                $"SIRK-Portal-{issued.Portal.Id}-connection.json",
                enableRangeProcessing: false);
        }
        catch (InvalidOperationException exception)
        {
            // The token was rotated but never returned. This is fail-closed: the
            // operator must retry through the public HTTPS endpoint to issue a new one.
            Audit(auditLog, context, issued.Portal.Id, false, "public-url-invalid");
            return Error(
                StatusCodes.Status503ServiceUnavailable,
                "CENTRAL_PUBLIC_URL_INVALID",
                exception.Message);
        }
    }

    private static Uri ValidateOrigin(string value, string scheme)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            uri is null ||
            !uri.Scheme.Equals(scheme, StringComparison.OrdinalIgnoreCase) ||
            !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) ||
            !string.IsNullOrEmpty(uri.Fragment) ||
            uri.AbsolutePath != "/")
        {
            throw new InvalidOperationException("SIRK Central public origin is invalid.");
        }
        return uri;
    }

    private static Uri ValidateTunnel(string value, string expectedAuthority)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            uri is null ||
            !uri.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase) ||
            !uri.Authority.Equals(expectedAuthority, StringComparison.OrdinalIgnoreCase) ||
            uri.AbsolutePath != "/tunnel" ||
            !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) ||
            !string.IsNullOrEmpty(uri.Fragment))
        {
            throw new InvalidOperationException("SIRK Central tunnel URL is invalid.");
        }
        return uri;
    }

    private static void Audit(
        SecurityAuditLog auditLog,
        HttpContext context,
        string portalId,
        bool success,
        string reason)
    {
        auditLog.Write(new SecurityAuditEvent(
            context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown",
            context.User.Identity?.Name ?? "unknown",
            "portal.connection-file.issue",
            "portal",
            (portalId ?? string.Empty).Trim()[..Math.Min((portalId ?? string.Empty).Trim().Length, 128)],
            success,
            (context.Connection.RemoteIpAddress?.ToString() ?? "unknown")[..Math.Min((context.Connection.RemoteIpAddress?.ToString() ?? "unknown").Length, 128)],
            context.TraceIdentifier,
            new Dictionary<string, string>
            {
                ["reason"] = reason,
                ["tokenRotated"] = "true",
                ["shownOnce"] = success ? "true" : "false"
            }));
    }

    private static IResult Error(int statusCode, string code, string message) =>
        Results.Json(
            new { ok = false, code, error = message },
            statusCode: statusCode);

    private static void NoStore(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store, max-age=0";
        context.Response.Headers.Pragma = "no-cache";
    }
}
