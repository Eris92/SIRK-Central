using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;
using Sirk.Central.Updates;

namespace Sirk.Central.Operations;

internal sealed record MaintenancePolicy(
    bool AutomaticUpdates,
    string Channel,
    int RetainBackups,
    string MaintenanceWindow,
    DateTimeOffset UpdatedAtUtc,
    string UpdatedBy);

internal sealed record UpdateRequest(
    string? Version,
    string? Channel,
    bool DryRun,
    string Confirmation);

internal sealed record UpdateJob(
    string Id,
    string State,
    string Version,
    string Channel,
    bool DryRun,
    DateTimeOffset CreatedAtUtc,
    string RequestedBy,
    string? Error);

internal sealed record OperationsState(
    int Schema,
    MaintenancePolicy Policy,
    Dictionary<string, UpdateJob> Jobs);

internal sealed class OperationsStore
{
    private static readonly JsonSerializerOptions JsonOptions =
        new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object _sync = new();
    private readonly string _path;
    private OperationsState _state;

    public OperationsStore(IOptions<SecurityOptions> options)
    {
        Directory.CreateDirectory(options.Value.DataRoot);
        _path = Path.Combine(options.Value.DataRoot, "operations.net10.json");
        _state = Load() ?? new OperationsState(
            1,
            new MaintenancePolicy(
                false,
                "stable",
                10,
                "Sun 02:00-04:00",
                DateTimeOffset.UtcNow,
                "system"),
            []);
        if (_state.Schema != 1)
            throw new InvalidDataException("Operations store schema is unsupported.");
    }

    public MaintenancePolicy Policy()
    {
        lock (_sync) return _state.Policy;
    }

    public IReadOnlyList<UpdateJob> Jobs()
    {
        lock (_sync)
            return _state.Jobs.Values
                .OrderByDescending(value => value.CreatedAtUtc)
                .ToArray();
    }

    public MaintenancePolicy SavePolicy(MaintenancePolicy input, string actor)
    {
        var channel = NormalizeChannel(input.Channel);
        if (input.RetainBackups is < 2 or > 100)
            throw new InvalidDataException("RetainBackups must be 2-100.");
        var window = NormalizeText(input.MaintenanceWindow, 80);
        lock (_sync)
        {
            var value = new MaintenancePolicy(
                input.AutomaticUpdates,
                channel,
                input.RetainBackups,
                window,
                DateTimeOffset.UtcNow,
                actor);
            _state = _state with { Policy = value };
            Persist();
            return value;
        }
    }

    public UpdateJob Queue(UpdateRequest input, string actor)
    {
        if (!string.Equals(
                input.Confirmation,
                "UPDATE SIRK CENTRAL",
                StringComparison.Ordinal))
            throw new InvalidDataException("Update confirmation phrase is invalid.");
        var channel = NormalizeChannel(input.Channel ?? _state.Policy.Channel);
        var version = string.IsNullOrWhiteSpace(input.Version)
            ? "latest"
            : NormalizeVersion(input.Version);
        lock (_sync)
        {
            if (_state.Jobs.Values.Any(value => value.State is "queued" or "running"))
                throw new InvalidOperationException("Another update job is already active.");
            var job = new UpdateJob(
                "upd-" + Guid.NewGuid().ToString("N"),
                "queued",
                version,
                channel,
                input.DryRun,
                DateTimeOffset.UtcNow,
                actor,
                null);
            _state.Jobs[job.Id] = job;
            Persist();
            return job;
        }
    }

    public UpdateJob Complete(string id, bool success, string? error)
    {
        lock (_sync)
        {
            if (!_state.Jobs.TryGetValue(id, out var job))
                throw new KeyNotFoundException("Update job was not found.");
            job = job with
            {
                State = success ? "completed" : "failed",
                Error = success ? null : NormalizeText(error, 500)
            };
            _state.Jobs[id] = job;
            Persist();
            return job;
        }
    }

    private OperationsState? Load()
    {
        if (!File.Exists(_path)) return null;
        using var stream = File.OpenRead(_path);
        return JsonSerializer.Deserialize<OperationsState>(stream, JsonOptions);
    }

    private void Persist()
    {
        var temporary = $"{_path}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}";
        try
        {
            using (var stream = new FileStream(
                       temporary,
                       FileMode.CreateNew,
                       FileAccess.Write,
                       FileShare.None))
            {
                JsonSerializer.Serialize(stream, _state, JsonOptions);
                stream.Flush(true);
            }
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(
                    temporary,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(temporary, _path, true);
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(
                    _path,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    private static string NormalizeChannel(string? value) =>
        (value ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "stable" => "stable",
            "dev" => "dev",
            _ => throw new InvalidDataException("Channel must be stable or dev.")
        };

    private static string NormalizeVersion(string? value)
    {
        var result = (value ?? string.Empty).Trim();
        if (result.Length is < 1 or > 80 ||
            result.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) ||
                  character is '.' or '+' or '_' or '-')))
            throw new InvalidDataException("Version is invalid.");
        return result;
    }

    private static string NormalizeText(string? value, int maximum)
    {
        var result = (value ?? string.Empty).Trim();
        if (result.Length > maximum)
            throw new InvalidDataException("Text is too long.");
        return new string(result.Select(character =>
            char.IsControl(character) ? ' ' : character).ToArray());
    }
}

internal sealed class OperationsMiddleware
{
    private readonly OperationsStore _store;
    private readonly PlatformUpdateCache _updates;

    public OperationsMiddleware(
        IOptions<SecurityOptions> options,
        PlatformUpdateCache updates)
    {
        _store = new OperationsStore(options);
        _updates = updates;
    }

    public async Task<bool> TryHandleAsync(HttpContext context)
    {
        if (!context.Request.Path.StartsWithSegments(
                "/api/v1/operations",
                out var remainder))
            return false;
        if (context.User.Identity?.IsAuthenticated != true ||
            !(context.User.IsInRole(SirkRoles.BreakGlass) ||
              context.User.IsInRole(SirkRoles.Admin) ||
              context.User.IsInRole(SirkRoles.SecAdmin)))
        {
            context.Response.StatusCode =
                context.User.Identity?.IsAuthenticated == true ? 403 : 401;
            return true;
        }

        try
        {
            if (HttpMethods.IsGet(context.Request.Method) &&
                remainder == "/maintenance")
            {
                await context.Response.WriteAsJsonAsync(
                    new { policy = _store.Policy(), jobs = _store.Jobs() },
                    context.RequestAborted);
                return true;
            }

            if (HttpMethods.IsPut(context.Request.Method) &&
                remainder == "/maintenance/policy")
            {
                await ValidateCsrf(context);
                var request = await context.Request.ReadFromJsonAsync<MaintenancePolicy>(
                                  cancellationToken: context.RequestAborted)
                              ?? throw new InvalidDataException("Request body is required.");
                await context.Response.WriteAsJsonAsync(
                    _store.SavePolicy(request, Actor(context)),
                    context.RequestAborted);
                return true;
            }

            if (HttpMethods.IsPost(context.Request.Method) &&
                remainder == "/updates")
            {
                await ValidateCsrf(context);
                var request = await context.Request.ReadFromJsonAsync<UpdateRequest>(
                                  cancellationToken: context.RequestAborted)
                              ?? throw new InvalidDataException("Request body is required.");
                context.Response.StatusCode = StatusCodes.Status202Accepted;
                await context.Response.WriteAsJsonAsync(
                    _store.Queue(request, Actor(context)),
                    context.RequestAborted);
                return true;
            }

            if (HttpMethods.IsGet(context.Request.Method) &&
                remainder == "/portal-releases/latest")
            {
                var requested = context.Request.Query["channel"].ToString();
                var channel = requested == "stable" ? "stable" : "preview";
                var runtime = context.Request.Query["runtime"].ToString();
                if (runtime is not ("win-x64" or "linux-x64")) runtime = "win-x64";
                var update = await _updates.GetLatestAsync(
                                 "sirk-portal",
                                 runtime,
                                 channel,
                                 context.RequestAborted)
                             ?? throw new KeyNotFoundException(
                                 "No matching SIRK Portal release was found.");
                await context.Response.WriteAsJsonAsync(
                    new
                    {
                        release = new
                        {
                            schemaVersion = 1,
                            applicationId = update.ApplicationId,
                            version = update.Version,
                            channel = requested == "stable" ? "stable" : "dev",
                            packageUrl = $"/api/portal/v1/update/products/sirk-portal/{update.Version}/package",
                            sha256 = update.Sha256,
                            architecture = update.Runtime,
                            publishedAtUtc = update.Descriptor.PublishedAtUtc,
                            commit = update.Descriptor.Commit,
                            keyId = update.Descriptor.Signature.KeyId,
                            signature = update.Descriptor.Signature.Value
                        }
                    },
                    context.RequestAborted);
                return true;
            }

            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return true;
        }
        catch (AntiforgeryValidationException)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsJsonAsync(
                new { code = "CSRF_VALIDATION_FAILED" });
            return true;
        }
        catch (KeyNotFoundException error)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await context.Response.WriteAsJsonAsync(new { error = error.Message });
            return true;
        }
        catch (Exception error) when (
            error is InvalidDataException or InvalidOperationException or CryptographicException)
        {
            context.Response.StatusCode = StatusCodes.Status409Conflict;
            await context.Response.WriteAsJsonAsync(new { error = error.Message });
            return true;
        }
        catch (Exception error) when (
            error is HttpRequestException or TaskCanceledException or IOException)
        {
            context.Response.StatusCode = StatusCodes.Status502BadGateway;
            await context.Response.WriteAsJsonAsync(
                new { code = "SIRK_RELEASE_LOOKUP_FAILED", error = error.Message });
            return true;
        }
    }

    private static Task ValidateCsrf(HttpContext context) =>
        context.RequestServices
            .GetRequiredService<IAntiforgery>()
            .ValidateRequestAsync(context);

    private static string Actor(HttpContext context) =>
        context.User.FindFirst(
            System.Security.Claims.ClaimTypes.NameIdentifier)?.Value ?? "unknown";
}
