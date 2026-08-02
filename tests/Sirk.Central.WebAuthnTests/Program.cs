using System.Net;
using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;
using Sirk.Central.Security;

var root = Path.Combine(
    Path.GetTempPath(),
    "sirk-webauthn-tests-" + Guid.NewGuid().ToString("N"));
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
    store.Add(new WebAuthnCredential(
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
    Require(
        !store.Owns(id, RandomNumberGenerator.GetBytes(32)),
        "Foreign user handle was accepted.");
    Require(store.ListByUser("user-1").Count == 1, "Credential list is invalid.");

    store.UpdateCounter(id, 2, false);
    Expect<InvalidOperationException>(
        () => store.UpdateCounter(id, 2, false),
        "Counter replay was accepted.");
    Expect<InvalidOperationException>(
        () => store.UpdateCounter(id, 1, false),
        "Counter rollback was accepted.");

    var reloaded = new WebAuthnCredentialStore(security);
    Require(
        reloaded.Get(id)?.SignatureCounter == 2,
        "Credential counter did not persist.");
    if (!OperatingSystem.IsWindows())
    {
        Require(
            (File.GetUnixFileMode(Path.Combine(root, "webauthn-credentials.net10.json")) &
             (UnixFileMode.GroupRead |
              UnixFileMode.GroupWrite |
              UnixFileMode.OtherRead |
              UnixFileMode.OtherWrite)) == 0,
            "Credential store permissions are too broad.");
    }

    var provider = DataProtectionProvider.Create(
        new DirectoryInfo(Path.Combine(root, "dp")));
    var ceremonies = new WebAuthnCeremonyStore(provider);
    var ceremony = ceremonies.Create(
        "assertion",
        "user-1",
        "{\"challenge\":\"abc\"}");
    var restored = ceremonies.Consume(
        ceremony.Id,
        "assertion",
        "user-1");
    Require(
        restored.Contains("challenge", StringComparison.Ordinal),
        "Protected ceremony could not be restored.");
    Expect<UnauthorizedAccessException>(
        () => ceremonies.Consume(ceremony.Id, "assertion", "user-1"),
        "Ceremony replay was accepted.");

    var mismatched = ceremonies.Create("registration", "user-1", "{}");
    Expect<UnauthorizedAccessException>(
        () => ceremonies.Consume(mismatched.Id, "assertion", "user-1"),
        "Ceremony kind mismatch was accepted.");

    var loginTransactions = new BreakGlassLoginTransactionStore();
    var identity = new LocalIdentity("user-1", "breakglass", [SirkRoles.BreakGlass]);
    var loginContext = Context("SIRK-WebAuthn-Test/1.0");
    var loginTransaction = loginTransactions.Issue(identity, loginContext);
    Require(
        loginTransactions.Inspect(loginTransaction.Token, loginContext)?.Id == identity.Id,
        "Password pre-auth transaction could not be inspected.");
    Require(
        loginTransactions.Inspect(
            loginTransaction.Token,
            Context("Different-Client/1.0")) is null,
        "Password pre-auth transaction was not bound to the client.");
    Require(
        loginTransactions.Consume(loginTransaction.Token, loginContext)?.Id == identity.Id,
        "Password pre-auth transaction could not be consumed.");
    Require(
        loginTransactions.Consume(loginTransaction.Token, loginContext) is null,
        "Password pre-auth transaction replay was accepted.");

    var recoveryCodes = new BreakGlassRecoveryCodeStore(security);
    var issuedCodes = recoveryCodes.Rotate(identity.Id, 10);
    Require(issuedCodes.Count == 10, "Recovery-code rotation returned an invalid count.");
    Require(
        recoveryCodes.Status(identity.Id) is { Configured: true, Remaining: 10 },
        "Recovery-code status was not persisted.");
    var remaining = recoveryCodes.VerifyAndConsume(identity.Id, issuedCodes[0]);
    Require(remaining == 9, "Recovery code was not consumed.");
    Expect<UnauthorizedAccessException>(
        () => recoveryCodes.VerifyAndConsume(identity.Id, issuedCodes[0]),
        "Recovery-code replay was accepted.");

    var reloadedRecoveryCodes = new BreakGlassRecoveryCodeStore(security);
    Require(
        reloadedRecoveryCodes.Status(identity.Id).Remaining == 9,
        "Recovery-code consumption did not persist.");
    var recoveryFile = Path.Combine(root, "break-glass-recovery-codes.net10.json");
    var recoveryText = File.ReadAllText(recoveryFile);
    Require(
        issuedCodes.All(code => !recoveryText.Contains(code, StringComparison.Ordinal)),
        "Recovery-code store exposes a plaintext code.");
    if (!OperatingSystem.IsWindows())
    {
        Require(
            (File.GetUnixFileMode(recoveryFile) &
             (UnixFileMode.GroupRead |
              UnixFileMode.GroupWrite |
              UnixFileMode.OtherRead |
              UnixFileMode.OtherWrite)) == 0,
            "Recovery-code store permissions are too broad.");
    }

    Console.WriteLine(
        "SIRK Central WebAuthn, password pre-auth and recovery-code contracts: OK");
    return 0;
}
finally
{
    Directory.Delete(root, true);
}

static DefaultHttpContext Context(string userAgent)
{
    var context = new DefaultHttpContext();
    context.Connection.RemoteIpAddress = IPAddress.Loopback;
    context.Request.Headers.UserAgent = userAgent;
    return context;
}

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static void Expect<T>(Action action, string message) where T : Exception
{
    try
    {
        action();
    }
    catch (T)
    {
        return;
    }
    throw new InvalidOperationException(message);
}
