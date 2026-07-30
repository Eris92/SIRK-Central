"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const passkeyStore = require("../src/passkey-store");

test("passkey store persists credentials, hides public keys and enforces counters", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-passkey-"));
    let now = Date.parse("2026-07-30T16:00:00Z");
    const owner = { identityKey: "tenant:object" };
    const store = passkeyStore.create({ dataDir: dir, now: () => now });
    const credential = store.register({
        credentialId: "A".repeat(32),
        publicKey: "B".repeat(80),
        displayName: "YubiKey 5 NFC",
        counter: 10,
        transports: ["usb", "nfc", "invalid"]
    }, owner);

    assert.equal(credential.counter, 10);
    assert.deepEqual(credential.transports, ["usb", "nfc"]);
    assert.equal(store.list(owner)[0].publicKey, undefined);
    assert.throws(() => store.verifyUse(credential.credentialId, owner, 10), /did not increase/);
    now += 1000;
    assert.equal(store.verifyUse(credential.credentialId, owner, 11).counter, 11);

    const reopened = passkeyStore.create({ dataDir: dir, now: () => now });
    assert.equal(reopened.activeCount(owner), 1);
    reopened.revoke(credential.credentialId, { username: "breakglass" });
    assert.equal(reopened.activeCount(owner), 0);
    assert.throws(() => reopened.verifyUse(credential.credentialId, owner, 12), /revoked/);
});
