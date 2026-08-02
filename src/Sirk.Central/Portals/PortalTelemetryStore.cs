using System.Collections.Concurrent;

namespace Sirk.Central.Portals;

internal sealed class PortalTelemetryStore
{
    private readonly ConcurrentDictionary<string, PortalHeartbeatSnapshot> _snapshots =
        new(StringComparer.Ordinal);

    public PortalHeartbeatSnapshot Record(
        PortalIdentity portal,
        PortalHeartbeatRequest metrics,
        string remoteAddress)
    {
        var snapshot = new PortalHeartbeatSnapshot(
            portal.Id,
            portal.Name,
            metrics,
            DateTimeOffset.UtcNow,
            remoteAddress);

        _snapshots.AddOrUpdate(portal.Id, snapshot, (_, _) => snapshot);
        return snapshot;
    }

    public PortalHeartbeatSnapshot? Get(string portalId) =>
        _snapshots.TryGetValue(portalId, out var snapshot) ? snapshot : null;

    public bool Remove(string portalId) =>
        _snapshots.TryRemove(portalId, out _);

    public IReadOnlyList<PortalHeartbeatSnapshot> List() =>
        _snapshots.Values
            .OrderBy(item => item.PortalName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(item => item.PortalId, StringComparer.Ordinal)
            .ToArray();
}
