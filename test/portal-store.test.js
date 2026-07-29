"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const storeFactory = require("../src/portal-store");

test("portal token is returned once and persisted only as a hash", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-central-"));
    try {
        const store = storeFactory.create({ dataDir: root });
        const created = store.createPortal({ id: "portal-test", name: "Portal testowy" });
        assert.equal(store.authenticate(created.id, created.token).name, "Portal testowy");
        assert.equal(store.authenticate(created.id, "not-the-token"), null);
        const persisted = fs.readFileSync(path.join(root, "portals.json"), "utf8");
        assert.equal(persisted.includes(created.token), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

