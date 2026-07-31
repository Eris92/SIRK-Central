"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sessionStoreFactory = require("../src/session-store");
const reset = require("../scripts/apply-emergency-security-reset");

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-emergency-reset-")); }

test("offline reset creates security overrides and revokes local sessions", () => {
    const dataDir = dir();
    const sessions = sessionStoreFactory.create({ dataDir, randomToken: () => "s".repeat(43) });
    sessions.issue({ username: "admin", identityKey: "breakglass:admin", source: "local", role: "BreakGlass", builtIn: true }, {});

    const result = reset.run({
        dataDir,
        passwordHash: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        accessKeyHash: "sha256$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    });
    assert.deepEqual(result.changed, ["password", "access-key"]);
    assert.equal(result.revokedSessions, 1);

    const users = JSON.parse(fs.readFileSync(path.join(dataDir, "users.json"), "utf8"));
    assert.match(users.security.breakGlassPasswordHash, /^scrypt\$/);
    assert.match(users.security.accessKeyHash, /^sha256\$/);
    assert.ok(users.security.emergencyResetAtUtc);
    assert.equal(sessionStoreFactory.create({ dataDir }).list().length, 0);
});

test("helper preserves existing users and rejects invalid hashes", () => {
    const dataDir = dir();
    fs.writeFileSync(path.join(dataDir, "users.json"), JSON.stringify({
        schema: 2,
        users: [{ username: "local-user" }],
        security: { existing: true }
    }));

    reset.run({ dataDir, accessKeyHash: "sha256$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" });
    const users = JSON.parse(fs.readFileSync(path.join(dataDir, "users.json"), "utf8"));
    assert.equal(users.users[0].username, "local-user");
    assert.equal(users.security.existing, true);
    assert.throws(() => reset.run({ dataDir, passwordHash: "invalid" }), /invalid/i);
});
