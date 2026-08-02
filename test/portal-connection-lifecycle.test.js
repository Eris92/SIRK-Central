"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const portalStoreFactory = require("../src/portal-store");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-central-portals-"));
try {
    const store = portalStoreFactory.create({ dataDir: root });
    const created = store.createPortal({ id: "portal-test", name: "Portal Test" });
    assert.equal(created.id, "portal-test");
    assert.ok(created.token.length >= 32);
    assert.equal(store.authenticate(created.id, created.token).id, created.id);

    const updated = store.update(created.id, { name: "Portal Test Updated" });
    assert.equal(updated.name, "Portal Test Updated");

    const rotated = store.rotateToken(created.id);
    assert.ok(rotated.token.length >= 32);
    assert.notEqual(rotated.token, created.token);
    assert.equal(store.authenticate(created.id, created.token), null);
    assert.equal(store.authenticate(created.id, rotated.token).id, created.id);

    const removed = store.remove(created.id);
    assert.equal(removed.id, created.id);
    assert.equal(store.get(created.id), null);
    assert.equal(store.authenticate(created.id, rotated.token), null);
    assert.equal(store.remove(created.id), null);

    console.log("portal-connection-lifecycle: OK");
}
finally {
    fs.rmSync(root, { recursive: true, force: true });
}
