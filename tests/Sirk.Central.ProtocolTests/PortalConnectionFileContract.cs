using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Sirk.Central.Portals;

internal static class PortalConnectionFileContract
{
    [ModuleInitializer]
    internal static void Run()
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = "https";
        context.Request.Host = new HostString("central.sirkportal.com");
        var now = DateTimeOffset.UtcNow;
        var issue = new PortalCredentialIssue(
            new PortalSummary(
                "portal-test",
                "Portal Test",
                now,
                now,
                now),
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_");

        var document = PortalConnectionFileEndpoints.CreateDocument(
            context.Request,
            issue);
        if (document.SchemaVersion != 1 ||
            document.CentralUrl != "https://central.sirkportal.com" ||
            document.TunnelUrl != "wss://central.sirkportal.com/tunnel" ||
            document.PortalId != issue.Portal.Id ||
            document.PortalName != issue.Portal.Name ||
            document.PortalToken != issue.Token ||
            document.PublicUrl != string.Empty)
        {
            throw new InvalidOperationException(
                "Central generated an invalid SIRK Portal connection document.");
        }

        var json = JsonSerializer.Serialize(
            document,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        foreach (var property in new[]
                 {
                     "schemaVersion",
                     "centralUrl",
                     "tunnelUrl",
                     "portalId",
                     "portalName",
                     "portalToken",
                     "publicUrl",
                     "updatedAtUtc"
                 })
        {
            if (!json.Contains('"' + property + '"', StringComparison.Ordinal))
                throw new InvalidOperationException(
                    "Portal connection JSON property is missing: " + property);
        }
        if (json.Contains("tokenHash", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(
                "Portal connection document contains an internal token hash.");

        context.Request.Scheme = "http";
        try
        {
            _ = PortalConnectionFileEndpoints.CreateDocument(
                context.Request,
                issue);
        }
        catch (InvalidOperationException)
        {
            return;
        }

        throw new InvalidOperationException(
            "Portal connection file generation accepted a plaintext HTTP Central origin.");
    }
}
