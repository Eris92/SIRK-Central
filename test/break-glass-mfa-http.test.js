"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hashSecret, hashAccessKey } = require("../src/security");
const { createHardenedApp } = require("../src/server-v2");

function cookieValue(headers, name) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie") || ""];
  for (const value of values) {
    const match = String(value).match(new RegExp("(?:^|[,;]\\s*)" + name + "=([^;,]*)"));
    if (match) return match[1];
  }
  return "";
}

async function jsonRequest(origin, route, options = {}) {
  const response = await fetch(origin + route, {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual"
  });
  const payload = await response.json();
  return { response, payload };
}

test("BreakGlass recovery code is required before a full session is issued", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-mfa-http-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const password = "Correct-Horse-Battery-Staple-2026";
  const accessKey = "A".repeat(43);
  const config = {
    bindHost: "127.0.0.1",
    port: 0,
    publicOrigin: "https://central.example.test",
    authOrigin: "",
    ssoSharedSecret: "",
    adminUsername: "admin",
    adminPasswordHash: hashSecret(password),
    accessKeyHash: hashAccessKey(accessKey),
    dataDir,
    sessionIdleMinutes: 30,
    sessionAbsoluteHours: 8,
    trustProxy: false,
    env: { NODE_ENV: "test" }
  };

  const app = createHardenedApp(config);
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const origin = "http://127.0.0.1:" + app.server.address().port;
  const baseHeaders = {
    authorization: "Bearer " + accessKey,
    "content-type": "application/json",
    "user-agent": "sirk-mfa-test"
  };

  const initial = await jsonRequest(origin, "/api/login", {
    method: "POST",
    headers: baseHeaders,
    body: { username: "admin", password }
  });
  assert.equal(initial.response.status, 200);
  assert.equal(initial.payload.ok, true);
  const sessionCookie = cookieValue(initial.response.headers, "sirk_central_session");
  const csrfCookie = cookieValue(initial.response.headers, "sirk_central_csrf");
  assert.ok(sessionCookie);
  assert.ok(csrfCookie);

  const rotated = await jsonRequest(origin, "/api/break-glass/mfa/recovery-codes/rotate", {
    method: "POST",
    headers: {
      ...baseHeaders,
      cookie: "sirk_central_session=" + sessionCookie + "; sirk_central_csrf=" + csrfCookie,
      "x-sirk-csrf": csrfCookie,
      origin: config.publicOrigin,
      "sec-fetch-site": "same-origin"
    },
    body: { count: 5 }
  });
  assert.equal(rotated.response.status, 200);
  assert.equal(rotated.payload.codes.length, 5);
  const recoveryCode = rotated.payload.codes[0];

  const pending = await jsonRequest(origin, "/api/login", {
    method: "POST",
    headers: baseHeaders,
    body: { username: "admin", password }
  });
  assert.equal(pending.response.status, 202);
  assert.equal(pending.payload.mfaRequired, true);
  assert.equal(pending.payload.methods.includes("recovery-code"), true);
  assert.ok(pending.payload.transactionToken);
  assert.equal(cookieValue(pending.response.headers, "sirk_central_session"), "");
  const pendingCsrf = cookieValue(pending.response.headers, "sirk_central_csrf");
  assert.ok(pendingCsrf);

  const mfaHeaders = {
    ...baseHeaders,
    cookie: "sirk_central_csrf=" + pendingCsrf,
    "x-sirk-csrf": pendingCsrf,
    origin: config.publicOrigin,
    "sec-fetch-site": "same-origin"
  };

  const completed = await jsonRequest(origin, "/api/login/mfa/recovery", {
    method: "POST",
    headers: mfaHeaders,
    body: {
      transactionToken: pending.payload.transactionToken,
      recoveryCode
    }
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.payload.ok, true);
  assert.equal(completed.payload.role, "BreakGlass");
  assert.ok(cookieValue(completed.response.headers, "sirk_central_session"));

  const replay = await jsonRequest(origin, "/api/login/mfa/recovery", {
    method: "POST",
    headers: mfaHeaders,
    body: {
      transactionToken: pending.payload.transactionToken,
      recoveryCode
    }
  });
  assert.notEqual(replay.response.status, 200);
  assert.equal(replay.payload.ok, false);
});
