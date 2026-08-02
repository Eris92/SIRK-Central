using System.Text.Json.Serialization;

namespace Sirk.Central.Portals;

internal sealed record PortalHeartbeatRequest(
    int ProtocolVersion,
    string PortalVersion,
    string BuildCommit,
    string Platform,
    string Hostname,
    string PublicUrl,
    string Health,
    int AgentCount,
    int OnlineAgents,
    string UpdateChannel,
    string AvailableVersion,
    IReadOnlyList<string> Capabilities);

internal sealed record PortalHeartbeatSnapshot(
    string PortalId,
    string PortalName,
    PortalHeartbeatRequest Metrics,
    DateTimeOffset ReceivedAtUtc,
    string RemoteAddress);

internal sealed record PortalHeartbeatAccepted(
    bool Ok,
    DateTimeOffset AcceptedAtUtc,
    int NextHeartbeatSeconds);

internal sealed record PortalConfigurationResponse(
    bool Ok,
    string PortalId,
    DateTimeOffset ServerTimeUtc,
    PortalHeartbeatConfiguration Heartbeat);

internal sealed record PortalHeartbeatConfiguration(
    int IntervalSeconds,
    int OfflineAfterSeconds,
    int MaximumClockSkewSeconds);

internal sealed record PortalRegistryDocument(
    int SchemaVersion,
    IReadOnlyList<PortalCredentialRecord> Portals);

internal sealed record PortalCredentialRecord(
    string Id,
    string Name,
    PortalTokenHash TokenHash,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc);

internal sealed record PortalTokenHash(
    string Algorithm,
    int Iterations,
    string SaltBase64,
    string HashBase64);

internal sealed record PortalIdentity(string Id, string Name);

internal sealed record PortalErrorResponse(
    bool Ok,
    string Code,
    string Error);

[JsonSerializable(typeof(PortalHeartbeatRequest))]
[JsonSerializable(typeof(PortalHeartbeatAccepted))]
[JsonSerializable(typeof(PortalConfigurationResponse))]
[JsonSerializable(typeof(PortalErrorResponse))]
[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
internal sealed partial class PortalJsonContext : JsonSerializerContext;
