"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicFile = name => fs.readFileSync(path.join(__dirname, "..", "public", name), "utf8");
const operationsBootstrap = publicFile("operations-bootstrap.js");
const workspaceRouting = publicFile("workspace-routing.js");
const passkeyUi = publicFile("passkey-ui.js");

test("operations tab observer writes observed attributes only when state changes", () => {
    assert.match(operationsBootstrap, /tab\.getAttribute\("aria-hidden"\) !== "false"/);
    assert.match(operationsBootstrap, /tab\.hasAttribute\("hidden"\)/);
    assert.match(operationsBootstrap, /tab\.style\.display === "none"/);
    assert.doesNotMatch(operationsBootstrap, /\n\s*tab\.setAttribute\("aria-hidden", "false"\);/);
});

test("MFA login flow has one canonical browser implementation", () => {
    assert.match(passkeyUi, /\/api\/login\/mfa\/passkey\/begin/);
    assert.match(passkeyUi, /\/api\/login\/mfa\/recovery/);
    assert.doesNotMatch(workspaceRouting, /\/api\/login\/mfa\//);
    assert.doesNotMatch(workspaceRouting, /transactionToken/);
});
