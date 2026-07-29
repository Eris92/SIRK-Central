"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const websitePath = path.join(__dirname, "..", "website", "index.html");
const html = fs.readFileSync(websitePath, "utf8");

test("public demo uses only generic portal labels", () => {
    const labels = [...html.matchAll(
        /<article class="portal[^>]*>[\s\S]*?<strong>([^<]+)<\/strong>/g
    )].map((match) => match[1]);

    assert.deepEqual(labels, ["Portal 01", "Portal 02", "Portal 03"]);
    assert.match(html, /tenant-01 · online/);
    assert.match(html, /tenant-02 · online/);
    assert.match(html, /tenant-03 · offline/);
});

test("public page exposes no tenant-specific sirkportal.com hostnames", () => {
    const allowedHosts = new Set([
        "sirkportal.com",
        "auth.sirkportal.com",
        "central.sirkportal.com"
    ]);
    const discoveredHosts = [...html.matchAll(/\b(?:[a-z0-9-]+\.)*sirkportal\.com\b/gi)]
        .map((match) => match[0].toLowerCase());

    for (const hostname of discoveredHosts) {
        assert.equal(allowedHosts.has(hostname), true, "unexpected public hostname: " + hostname);
    }
});
