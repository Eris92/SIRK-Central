namespace Sirk.Central;

/// <summary>
/// Product-level runtime contract: SIRK Central is hosted exclusively by
/// ASP.NET Core on .NET 10. JavaScript is permitted only as browser assets.
/// </summary>
internal static class NodeFreeRuntimeContract
{
    public const string Runtime = ".NET 10 LTS";
    public const string Architecture = "ASP.NET Core single service behind Caddy";
    public const string UpdateCoordinator = "SIRK Updater";
    public const string RepositoryContract = "node-free-dotnet10-v1";
    public const bool NodeRuntimeAllowed = false;
}
