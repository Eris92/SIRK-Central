"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const enrollmentStoreFactory = require("../src/portal-enrollment-store");
const { encryptBootstrap, bearer } = require("../src/modules/portal-enrollment");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-central-enrollment-"));
try {
    const store = enrollmentStoreFactory.create({ dataDir: root });
    const issued = store.issueToken({ label: "Portal test", ttlMinutes: 15 });
    assert.match(issued.token, /^[A-Za-z0-9_-]+$/);

    const keys = crypto.generateKeyPairSync("rsa", {
        modulusLength: 3072,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });

    const request = store.createRequest({
        portalId: "portal-test",
        portalName: "Portal Test",
        publicUrl: "https://portal.test.local",
        version: "2.0.0-test",
        platform: "win32-x64",
        publicKeyPem: keys.publicKey
    }, issued.token);

    assert.equal(request.status, "pending");
    assert.throws(() => store.createRequest({
        portalId: "portal-second",
        portalName: "Portal Second",
        publicKeyPem: keys.publicKey
    }, issued.token), /invalid or expired/i);

    const pending = store.poll(request.requestId, request.pollToken);
    assert.equal(pending.status, "pending");

    const record = store.getRequest(request.requestId);
    const bootstrap = {
        schemaVersion: 1,
        centralUrl: "https://central.sirkportal.com",
        tunnelUrl: "wss://central.sirkportal.com/tunnel",
        portalId: "portal-test",
        portalName: "Portal Test",
        portalToken: "test-token-value"
    };
    const encrypted = encryptBootstrap(record.publicKeyPem, bootstrap);
    store.approve(request.requestId, encrypted);

    const approved = store.poll(request.requestId, request.pollToken);
    assert.equal(approved.status, "approved");
    assert.ok(approved.encryptedBootstrap);

    const decrypted = crypto.privateDecrypt({
        key: keys.privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
    }, Buffer.from(approved.encryptedBootstrap, "base64"));
    assert.deepEqual(JSON.parse(decrypted.toString("utf8")), bootstrap);

    const claimed = store.poll(request.requestId, request.pollToken);
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.encryptedBootstrap, undefined);

    assert.equal(bearer({ headers: { authorization: "Bearer " + issued.token } }), issued.token);
    assert.equal(bearer({ headers: { authorization: "Basic invalid" } }), "");

    console.log("portal-enrollment: OK");
}
finally {
    fs.rmSync(root, { recursive: true, force: true });
}
