namespace Sirk.Central.Portals;

internal sealed class PortalProtocolOptions
{
    public const string SectionName = "Sirk:PortalProtocol";

    public string DataRoot { get; set; } = Path.Combine(AppContext.BaseDirectory, "data");

    public string RegistryFileName { get; set; } = "portals.net10.json";

    public int TokenHashIterations { get; set; } = 310_000;

    public int HeartbeatIntervalSeconds { get; set; } = 60;

    public int OfflineAfterSeconds { get; set; } = 180;

    public int MaximumClockSkewSeconds { get; set; } = 300;

    public int MaximumHeartbeatBodyBytes { get; set; } = 65_536;

    public string BootstrapPortalId { get; set; } = string.Empty;

    public string BootstrapPortalName { get; set; } = string.Empty;

    public string BootstrapPortalToken { get; set; } = string.Empty;
}
