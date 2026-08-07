using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Sirk.Central.Portals;
using Sirk.Central.Security;

namespace Sirk.Central.Updates;

internal sealed class HostUpdateControl
{
    private readonly byte[] _token;

    public HostUpdateControl(IConfiguration configuration)
    {
        var path = configuration["Sirk:Updates:HostControlTokenFile"] ??
                   "/run/secrets/sirk-update-host-token";
        if (!File.Exists(path))
        {
            _token = [];
            return;
        }
        var value = File.ReadAllText(path, Encoding.UTF8).Trim();
        _token = Encoding.UTF8.GetBytes(value);
        if (_token.Length is < 32 or > 512)
            throw new InvalidDataException("SIRK host update control token is invalid.");
    }

    public bool Authenticate(HttpContext context)
    {
        if (_token.Length == 0 ||
            context.Connection.RemoteIpAddress is null ||
            !IPAddress.IsLoopback(context.Connection.RemoteIpAddress))
            return false;
        var authorization = context.Request.Headers.Authorization.ToString();
        if (!authorization.StartsWith("Bearer ", StringComparison.Ordinal)) return false;
        var supplied = Encoding.UTF8.GetBytes(authorization[7..].Trim());
        try
        {
            return supplied.Length == _token.Length &&
                   CryptographicOperations.FixedTimeEquals(supplied, _token);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(supplied);
        }
    }
}

internal static class PlatformUpdateDistributionEndpoints
{
    public static void Map(IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet(
            "/api/portal/v1/update/products/{applicationId}/latest",
            LatestForPortalAsync);
        endpoints.MapGet(
            "/api/portal/v1/update/products/{applicationId}/{version}/package",
            DownloadForPortal);
        endpoints.MapGet(
            "/api/portal/v1/update/trusted-keys",
            TrustedKeysForPortal);
        endpoints.MapPost(
            "/api/internal/v1/update/central/prepare",
            PrepareCentralAsync);
        endpoints.MapGet(
                "/api/v1/updates/products/{applicationId}/status",
                (string applicationId, string runtime, string channel, PlatformUpdateCache cache) =>
                    Results.Ok(cache.Status(applicationId, runtime, channel)))
            .RequireAuthorization(SirkPolicies.PortalManagement);
    }

    private static async Task<IResult> LatestForPortalAsync(
        string applicationId,
        HttpContext context,
        PortalRequestAuthenticator authenticator,
        PlatformUpdateCache cache,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        var authentication = authenticator.AuthenticateCredentials(context.Request);
        if (!authentication.Succeeded || authentication.Portal is null)
            return Results.NotFound();
        if (applicationId is not ("sirk-portal" or "sirk-updater"))
            return Results.NotFound();

        var runtime = context.Request.Query["runtime"].ToString();
        var channel = context.Request.Query["channel"].ToString();
        var currentVersion = context.Request.Query["currentVersion"].ToString();
        try
        {
            var latest = await cache.GetLatestAsync(
                applicationId,
                runtime,
                channel,
                cancellationToken);
            if (latest is null ||
                PlatformUpdateVersion.IsValid(currentVersion) &&
                PlatformUpdateVersion.Compare(latest.Version, currentVersion) <= 0)
                return Results.NoContent();
            return Results.Ok(new
            {
                latest.ApplicationId,
                latest.Version,
                latest.Runtime,
                latest.Channel,
                latest.Size,
                latest.Sha256,
                latest.Descriptor,
                packagePath =
                    $"/api/portal/v1/update/products/{applicationId}/{latest.Version}/package"
            });
        }
        catch (Exception error) when (
            error is HttpRequestException or IOException or JsonException or
            InvalidDataException or CryptographicException or KeyNotFoundException)
        {
            return Results.Json(
                new
                {
                    ok = false,
                    code = "SIRK_UPDATE_UNAVAILABLE",
                    error = error.Message
                },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }

    private static IResult DownloadForPortal(
        string applicationId,
        string version,
        HttpContext context,
        PortalRequestAuthenticator authenticator,
        PlatformUpdateCache cache)
    {
        context.Response.Headers.CacheControl = "private, no-store";
        var authentication = authenticator.AuthenticateCredentials(context.Request);
        if (!authentication.Succeeded || authentication.Portal is null)
            return Results.NotFound();
        if (applicationId is not ("sirk-portal" or "sirk-updater"))
            return Results.NotFound();
        var runtime = context.Request.Query["runtime"].ToString();
        var channel = context.Request.Query["channel"].ToString();
        try
        {
            var update = cache.GetPackage(applicationId, version, runtime, channel);
            context.Response.Headers.ETag = '"' + update.Sha256 + '"';
            return Results.File(
                update.PackagePath,
                "application/zip",
                enableRangeProcessing: true);
        }
        catch (FileNotFoundException)
        {
            return Results.NotFound();
        }
        catch (Exception error) when (error is InvalidDataException or KeyNotFoundException)
        {
            return Results.BadRequest(new
            {
                ok = false,
                code = "SIRK_UPDATE_INVALID",
                error = error.Message
            });
        }
    }

    private static IResult TrustedKeysForPortal(
        HttpContext context,
        PortalRequestAuthenticator authenticator,
        PlatformUpdateCache cache)
    {
        context.Response.Headers.CacheControl = "private, no-store";
        var authentication = authenticator.AuthenticateCredentials(context.Request);
        if (!authentication.Succeeded || authentication.Portal is null)
            return Results.NotFound();
        try
        {
            return Results.Bytes(cache.ReadTrustedKeys(), "application/json");
        }
        catch (Exception error) when (
            error is IOException or JsonException or InvalidDataException or CryptographicException)
        {
            return Results.Json(
                new
                {
                    ok = false,
                    code = "SIRK_UPDATE_TRUST_UNAVAILABLE",
                    error = error.Message
                },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }

    private static async Task<IResult> PrepareCentralAsync(
        HttpContext context,
        HostUpdateControl control,
        PlatformUpdateCache cache,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        if (!control.Authenticate(context)) return Results.NotFound();
        try
        {
            var latest = await cache.GetLatestAsync(
                "sirk-central",
                "linux-x64",
                "stable",
                cancellationToken)
                ?? throw new InvalidDataException("No SIRK Central update is available.");
            return Results.Ok(new
            {
                latest.ApplicationId,
                latest.Version,
                latest.Runtime,
                latest.Channel,
                latest.Size,
                latest.Sha256,
                latest.Descriptor.Commit,
                latest.PackagePath
            });
        }
        catch (Exception error) when (
            error is HttpRequestException or IOException or JsonException or
            InvalidDataException or CryptographicException)
        {
            return Results.Json(
                new
                {
                    ok = false,
                    code = "CENTRAL_UPDATE_UNAVAILABLE",
                    error = error.Message
                },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }
}
