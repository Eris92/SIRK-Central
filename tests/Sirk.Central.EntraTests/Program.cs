using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;

var root = Path.Combine(Path.GetTempPath(), $"sirk-central-entra-{Guid.NewGuid():N}");
Directory.CreateDirectory(root);

const string secret = "entra-client-secret-test-value";
const string tenant = "11111111-1111-1111-1111-111111111111";
const string clientId = "22222222-2222-2222-2222-222222222222";
const string objectId = "33333333-3333-3333-3333-333333333333";

try
{
    var options = new SecurityOptions
    {
        Enabled = true,
        DataRoot = root,
        DataProtectionDirectoryName = "data-protection"
    };
    var keyRoot = Path.Combine(root, options.DataProtectionDirectoryName);
    Directory.CreateDirectory(keyRoot);
    var provider = DataProtectionProvider.Create(new DirectoryInfo(keyRoot), builder =>
        builder.SetApplicationName("SIRK Central .NET 10"));

    var store = new EntraSettingsStore(Options.Create(options), provider);
    var saved = store.Update(new EntraSettingsUpdate(
        true,
        tenant,
        clientId,
        secret,
        [$"{tenant}:{objectId}"],
        "https://central.sirkportal.com"));

    Assert(saved.Enabled, "Entra must be enabled.");
    Assert(saved.ClientSecretConfigured, "Client secret status must be true.");
    Assert(saved.RedirectUri == "https://central.sirkportal.com/auth/entra/callback",
        "Redirect URI is invalid.");
    Assert(saved.FrontChannelLogoutUri == "https://central.sirkportal.com/auth/entra/frontchannel-logout",
        "Front-channel logout URI is invalid.");
    Assert(store.GetClientSecret() == secret, "Client secret cannot be decrypted.");

    var statePath = Path.Combine(root, "entra-settings.net10.json");
    var serialized = await File.ReadAllTextAsync(statePath);
    Assert(!serialized.Contains(secret, StringComparison.Ordinal),
        "Entra settings expose the client secret in plaintext.");
    AssertProtectedFile(statePath);

    var reloaded = new EntraSettingsStore(Options.Create(options), provider);
    Assert(reloaded.GetClientSecret() == secret, "Protected client secret did not survive restart.");
    Assert(reloaded.GetPublic().AllowedIdentities.SequenceEqual([$"{tenant}:{objectId}"]),
        "Allowed identity did not survive restart.");

    AssertThrows<InvalidDataException>(() => store.Update(new EntraSettingsUpdate(
        true, "invalid-tenant", clientId, null, [], "https://central.sirkportal.com")),
        "Invalid tenant must be rejected.");
    AssertThrows<InvalidDataException>(() => store.Update(new EntraSettingsUpdate(
        true, tenant, clientId, null, ["invalid-identity"], "https://central.sirkportal.com")),
        "Invalid allowed identity must be rejected.");
    AssertThrows<InvalidDataException>(() => store.Update(new EntraSettingsUpdate(
        true, tenant, clientId, null, [], "http://central.sirkportal.com")),
        "Non-HTTPS public origin must be rejected.");

    Console.WriteLine("SIRK Central protected Entra settings contracts: OK");
}
finally
{
    if (Directory.Exists(root)) Directory.Delete(root, true);
}

static void AssertProtectedFile(string path)
{
    if (OperatingSystem.IsWindows()) return;
    var mode = File.GetUnixFileMode(path);
    var forbidden = UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute |
                    UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;
    Assert((mode & forbidden) == 0, $"Protected file has weak permissions: {mode}");
}

static void AssertThrows<TException>(Action action, string message)
    where TException : Exception
{
    try
    {
        action();
    }
    catch (TException)
    {
        return;
    }
    throw new InvalidOperationException(message);
}

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
