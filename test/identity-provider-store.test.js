"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const storeFactory = require("../src/identity-provider-store");

function createStore(env) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-idp-"));
    return storeFactory.create({ dataDir, authOrigin: "https://auth.example.test", env: env || {} });
}

test("provider store imports environment and never exposes client secret", () => {
    const store = createStore({
        SIRK_ENTRA_TENANT: "organizations",
        SIRK_ENTRA_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
        SIRK_ENTRA_CLIENT_SECRET: "secret-value",
        SIRK_ENTRA_ADMIN_IDENTITIES: "22222222-2222-2222-2222-222222222222:33333333-3333-3333-3333-333333333333"
    });
    const view = store.publicView();
    assert.equal(view.clientSecretConfigured, true);
    assert.equal(Object.hasOwn(view, "clientSecret"), false);
});

test("provider update preserves secret when blank replacement is submitted", () => {
    const store = createStore({
        SIRK_ENTRA_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
        SIRK_ENTRA_CLIENT_SECRET: "existing-secret"
    });
    store.update({
        enabled: true,
        tenant: "organizations",
        clientId: "11111111-1111-1111-1111-111111111111",
        clientSecret: "",
        allowedIdentities: []
    });
    assert.equal(store.read().clientSecret, "existing-secret");
    assert.equal(fs.statSync(store.storePath).mode & 0o777, 0o600);
});
