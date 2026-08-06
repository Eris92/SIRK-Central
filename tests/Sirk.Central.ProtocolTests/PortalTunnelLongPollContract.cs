using System.Runtime.CompilerServices;

internal static class PortalTunnelLongPollContract
{
    [ModuleInitializer]
    internal static void Run()
    {
        var root = FindRepositoryRoot();
        var tunnel = File.ReadAllText(Path.Combine(
            root,
            "src",
            "Sirk.Central",
            "Portals",
            "PortalTunnelModule.cs"));

        Require(
            tunnel.Contains(
                "DefaultRequestTimeout = TimeSpan.FromSeconds(30)",
                StringComparison.Ordinal) &&
            tunnel.Contains(
                "LongPollRequestTimeout = TimeSpan.FromSeconds(45)",
                StringComparison.Ordinal) &&
            tunnel.Contains(
                "ResolveRequestTimeout(normalizedMethod, normalizedPath)",
                StringComparison.Ordinal) &&
            tunnel.Contains("now.Add(requestTimeout)", StringComparison.Ordinal) &&
            tunnel.Contains("timeout.CancelAfter(requestTimeout)", StringComparison.Ordinal),
            "Portal tunnel request expiry and cancellation must use the same bounded route-specific timeout.");

        Require(
            tunnel.Contains(
                "route.Equals(\"/api/v1/desktop/frame\"",
                StringComparison.Ordinal) &&
            tunnel.Contains(
                "route.Equals(\"/api/agent-operations\"",
                StringComparison.Ordinal) &&
            tunnel.Contains(
                "route.StartsWith(\"/api/v1/admin/agent-commands/\"",
                StringComparison.Ordinal),
            "Only known GET long-poll routes may receive the extended tunnel timeout.");

        Require(
            tunnel.Contains(
                "item.Key.Equals(\"x-sirk-sequence\"",
                StringComparison.Ordinal) &&
            tunnel.Contains(
                "item.Key.Equals(\"x-sirk-metadata\"",
                StringComparison.Ordinal) &&
            tunnel.Contains(
                "context.Response.Headers[item.Key] = item.Value",
                StringComparison.Ordinal),
            "Central must forward desktop frame sequence and metadata headers to the browser.");
    }

    private static string FindRepositoryRoot()
    {
        var current = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (current is not null)
        {
            if (File.Exists(Path.Combine(
                    current.FullName,
                    "src",
                    "Sirk.Central",
                    "Sirk.Central.csproj")))
            {
                return current.FullName;
            }
            current = current.Parent;
        }
        throw new DirectoryNotFoundException("SIRK Central repository root was not found.");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
