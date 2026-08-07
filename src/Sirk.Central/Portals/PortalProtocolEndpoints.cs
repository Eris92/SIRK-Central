using System.Buffers;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Sirk.Central.PublicSite;

namespace Sirk.Central.Portals;

internal static class PortalProtocolEndpoints
{
    public static IEndpointRouteBuilder MapPortalProtocol(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/portal/v1/heartbeat", HandleHeartbeatAsync);
        endpoints.MapGet("/api/portal/v1/config", HandleConfiguration);
        PublicSiteConfigEndpoints.Map(endpoints);
        return endpoints;
    }

    private static async Task<IResult> HandleHeartbeatAsync(
        HttpContext context,
        PortalRequestAuthenticator authenticator,
        PortalTelemetryStore telemetry,
        IOptions<PortalProtocolOptions> options,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";

        var bodyResult = await ReadBodyAsync(
            context.Request,
            options.Value.MaximumHeartbeatBodyBytes,
            cancellationToken);
        if (bodyResult.TooLarge)
        {
            return Error(
                StatusCodes.Status413PayloadTooLarge,
                "PORTAL_BODY_TOO_LARGE",
                "Portal heartbeat body is too large.");
        }

        var authentication = authenticator.AuthenticateSignedHeartbeat(
            context.Request,
            bodyResult.Body);
        if (!authentication.Succeeded || authentication.Portal is null)
        {
            var statusCode = authentication.ErrorCode == "PORTAL_NONCE_REPLAYED"
                ? StatusCodes.Status409Conflict
                : StatusCodes.Status401Unauthorized;
            return Error(statusCode, authentication.ErrorCode, authentication.ErrorMessage);
        }

        PortalHeartbeatRequest? heartbeat;
        try
        {
            heartbeat = JsonSerializer.Deserialize(
                bodyResult.Body,
                PortalJsonContext.Default.PortalHeartbeatRequest);
        }
        catch (JsonException)
        {
            return Error(
                StatusCodes.Status400BadRequest,
                "PORTAL_HEARTBEAT_INVALID",
                "Portal heartbeat JSON is invalid.");
        }

        var validationError = ValidateHeartbeat(heartbeat);
        if (validationError is not null)
        {
            return Error(
                StatusCodes.Status400BadRequest,
                "PORTAL_HEARTBEAT_INVALID",
                validationError);
        }

        var remoteAddress = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        telemetry.Record(authentication.Portal, heartbeat!, remoteAddress);

        return Results.Json(
            new PortalHeartbeatAccepted(
                true,
                DateTimeOffset.UtcNow,
                options.Value.HeartbeatIntervalSeconds),
            PortalJsonContext.Default.PortalHeartbeatAccepted,
            statusCode: StatusCodes.Status202Accepted);
    }

    private static IResult HandleConfiguration(
        HttpContext context,
        PortalRequestAuthenticator authenticator,
        IOptions<PortalProtocolOptions> options)
    {
        context.Response.Headers.CacheControl = "no-store";
        var authentication = authenticator.AuthenticateCredentials(context.Request);
        if (!authentication.Succeeded || authentication.Portal is null)
        {
            return Error(
                StatusCodes.Status404NotFound,
                "RESOURCE_NOT_FOUND",
                "Not found.");
        }

        var response = new PortalConfigurationResponse(
            true,
            authentication.Portal.Id,
            DateTimeOffset.UtcNow,
            new PortalHeartbeatConfiguration(
                options.Value.HeartbeatIntervalSeconds,
                options.Value.OfflineAfterSeconds,
                options.Value.MaximumClockSkewSeconds));

        return Results.Json(
            response,
            PortalJsonContext.Default.PortalConfigurationResponse);
    }

    private static PortalErrorResponse ErrorBody(string code, string message) =>
        new(false, code, message);

    private static IResult Error(int statusCode, string code, string message) =>
        Results.Json(
            ErrorBody(code, message),
            PortalJsonContext.Default.PortalErrorResponse,
            statusCode: statusCode);

    private static string? ValidateHeartbeat(PortalHeartbeatRequest? heartbeat)
    {
        if (heartbeat is null)
        {
            return "Portal heartbeat is required.";
        }

        if (heartbeat.ProtocolVersion != 1)
        {
            return "Portal protocol version is unsupported.";
        }

        if (!HasLength(heartbeat.PortalVersion, 1, 80) ||
            !HasLength(heartbeat.Platform, 1, 80) ||
            !HasLength(heartbeat.Hostname, 1, 255) ||
            !HasLength(heartbeat.Health, 2, 16) ||
            !HasLength(heartbeat.UpdateChannel, 0, 80) ||
            !HasLength(heartbeat.AvailableVersion, 0, 80) ||
            !HasLength(heartbeat.BuildCommit, 0, 80) ||
            !HasLength(heartbeat.PublicUrl, 0, 2048))
        {
            return "Portal heartbeat contains an invalid string field.";
        }

        if (heartbeat.Health is not ("ok" or "warning" or "critical"))
        {
            return "Portal health value is unsupported.";
        }

        if (heartbeat.AgentCount < 0 ||
            heartbeat.OnlineAgents < 0 ||
            heartbeat.OnlineAgents > heartbeat.AgentCount)
        {
            return "Portal agent counters are invalid.";
        }

        if (heartbeat.Capabilities is null || heartbeat.Capabilities.Count > 128)
        {
            return "Portal capabilities are invalid.";
        }

        foreach (var capability in heartbeat.Capabilities)
        {
            if (!HasLength(capability, 1, 128))
            {
                return "Portal capability is invalid.";
            }
        }

        if (heartbeat.PublicUrl.Length > 0 &&
            (!Uri.TryCreate(heartbeat.PublicUrl, UriKind.Absolute, out var publicUri) ||
             publicUri.Scheme != Uri.UriSchemeHttps ||
             !string.IsNullOrEmpty(publicUri.UserInfo)))
        {
            return "Portal public URL must be an HTTPS URL without user information.";
        }

        return null;
    }

    private static bool HasLength(string? value, int minimum, int maximum) =>
        value is not null && value.Length >= minimum && value.Length <= maximum;

    private static async Task<BodyReadResult> ReadBodyAsync(
        HttpRequest request,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        if (maximumBytes is < 1024 or > 1_048_576)
        {
            throw new InvalidOperationException(
                "Sirk:PortalProtocol:MaximumHeartbeatBodyBytes must be between 1024 and 1048576.");
        }

        if (request.ContentLength > maximumBytes)
        {
            return new BodyReadResult([], true);
        }

        await using var output = new MemoryStream(
            request.ContentLength is > 0 and <= int.MaxValue
                ? (int)request.ContentLength.Value
                : 0);
        var buffer = ArrayPool<byte>.Shared.Rent(8192);
        try
        {
            while (true)
            {
                var read = await request.Body.ReadAsync(buffer, cancellationToken);
                if (read == 0)
                {
                    break;
                }

                if (output.Length + read > maximumBytes)
                {
                    return new BodyReadResult([], true);
                }

                await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }

            return new BodyReadResult(output.ToArray(), false);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer, clearArray: true);
        }
    }

    private sealed record BodyReadResult(byte[] Body, bool TooLarge);
}
