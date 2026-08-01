"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "operations-bootstrap.js"), "utf8");

test("operations tab observer writes observed attributes only when state changes", () => {
    assert.match(source, /tab\.getAttribute\("aria-hidden"\) !== "false"/);
    assert.match(source, /tab\.hasAttribute\("hidden"\)/);
    assert.match(source, /tab\.style\.display === "none"/);
    assert.doesNotMatch(source, /\n\s*tab\.setAttribute\("aria-hidden", "false"\);/);
});
