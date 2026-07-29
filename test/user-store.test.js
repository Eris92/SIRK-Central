"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const userStore = require("../src/user-store");

function temporaryStore() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-users-"));
    return { dataDir, store: userStore.create({ dataDir }) };
}

test("account accepts exactly one Admin or SecAdmin role", () => {
    assert.equal(userStore.normalizeRole("Admin"), "Admin");
    assert.equal(userStore.normalizeRole("SecAdmin"), "SecAdmin");
    assert.throws(() => userStore.normalizeRole(["Admin", "SecAdmin"]), /Role must be/);
    assert.throws(() => userStore.normalizeRole("Admin,SecAdmin"), /Role must be/);
});

test("Admin cannot create or promote a SecAdmin", () => {
    const { store } = temporaryStore();
    assert.throws(() => store.createLocalUser({
        username: "security.admin",
        password: "Correct-Horse-Battery-123",
        role: "SecAdmin"
    }, { canGrantSecAdmin: false }), /Only SecAdmin or Break-Glass/);
});

test("SecAdmin or Break-Glass can create one-role SecAdmin account", () => {
    const { store } = temporaryStore();
    const created = store.createLocalUser({
        username: "security.admin",
        password: "Correct-Horse-Battery-123",
        role: "SecAdmin"
    }, { canGrantSecAdmin: true });
    assert.deepEqual(created, { username: "security.admin", role: "SecAdmin" });
    assert.equal(store.listUsers()[0].role, "SecAdmin");
});
