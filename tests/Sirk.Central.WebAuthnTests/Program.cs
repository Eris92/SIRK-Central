using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;

var root = Path.Combine(Path.GetTempPath(), "sirk-webauthn-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    var security = Options.Create(new SecurityOptions
    {
        Enabled = false,
        DataRoot = root
    });
    var store = new WebAuthnCredentialStore(security);
    var id = RandomNumberGenerator.GetBytes(32);
    var handle = RandomNumberGenerator.GetBytes(32);
    var publicKey = RandomNumberGenerator.GetBytes(64);
    var encodedId = WebAuthnCredentialStore.Base64Url(id);
    var credential = store.Add(new WebAuthnCredential(
        encodedId,
        "user-1",
        "breakglass",
        "YubiKey 1",
        WebAuthnCredentialStore.Base64Url(publicKey),
        1,
        "packed",
        WebAuthnCredentialStore.Base64Url(handle),
        Guid.NewGuid().ToString("D"),
        ["usb", "nfc"],
        false,
        false,
        DateTimeOffset.UtcNow,
        null));

    Require(store.Exists(id), "Credential was not stored.");
    Require(store.Owns(id, handle), "Credential ownership check failed.");
    Require(!store.Owns(id, RandomNumberGenerator.GetBytes(32)), "Foreign user handle was accepted.");
    Require(store.ListByUser("user-1").Count == 1, "Credential list is invalid.");

    store.UpdateCounter(id, 2, false);
    Expect<InvalidOperationException>(() => store.UpdateCounter(id, 2, false), "Counter replay was accepted.");
    Expect<InvalidOperationException>(() => store.UpdateCounter(id, 1, false), "Counter rollback was accepted.");

    var reloaded = new WebAuthnCredentialStore(security);
    Require(reloaded.Get(id)?.SignatureCounter == 2, "Credential counter did not persist.");
    Require((File.GetUnixFileMode(Path.Combine(root, "webauthn-credentials.net10.json")) &
        (UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.OtherRead | UnixFileMode.OtherWrite)) == 0,
        "Credential store permissions are too broad.");

    var protectionRoot = Path.Combine(root, "dp");
    var provider = DataProtectionProvider.Create(new DirectoryInfo(protectionRoot));
    var ceremonies = new WebAuthnCeremonyStore(provider);
    var ceremony = ceremonies.Create("assertion", "user-1", "{\"challenge\":\"abc\"}");
    var restored = ceremonies.Consume(ceremony.Id, "assertion", "user-1");
    Require(restored.Contains("challenge", StringComparison.Ordinal), "Protected ceremony could not be restored.");
    Expect<UnauthorizedAccessException>(() => ceremonies.Consume(ceremony.Id, "assertion", "user-1"), "Ceremony replay was accepted.");

    var mismatched = ceremonies.Create("registration", "user-1", "{}");
    Expect<UnauthorizedAccessException>(() => ceremonies.Consume(mismatched.Id, "assertion", "user-1"), "Ceremony kind mismatch was accepted.");

    Console.WriteLine("SIRK Central WebAuthn credential, counter and ceremony contracts: OK");
    return 0;
}
finally
{
    Directory.Delete(root, true);
}

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static void Expect<T>(Action action, string message) where T : Exception
{
    try { action(); }
    catch (T) { return; }
    throw new InvalidOperationException(message);
}
