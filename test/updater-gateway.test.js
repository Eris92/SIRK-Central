"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createGateway, pathAllowed, workerOrigin } = require("../updater/gateway-server");

const TOKEN = "G".repeat(64);

async function listen(t, options = {}) {
    const gateway = createGateway(Object.assign({
        bindHost: "127.0.0.1",
        port: 8092,
        token: TOKEN,
        workerOrigin: "http://updater:8090",
        allowedWorkerHosts: "updater"
    }, options));
    await new Promise((resolve, reject) => {
        gateway.server.once("error", reject);
        gateway.server.listen(0, "127.0.0.1", resolve);
    });
    const origin = "http://127.0.0.1:" + gateway.server.address().port;
    t.after(() => new Promise(resolve => gateway.server.close(resolve)));
    return origin;
}

test("gateway path and worker origin allowlists are exact", () => {
    assert.equal(pathAllowed("/status"), true);
    assert.equal(pathAllowed("/backup/sirk-central-20260731T120000Z.tar.gz"), true);
    assert.equal(pathAllowed("/backup/../../etc/passwd"), false);
    assert.equal(pathAllowed("/status?target=http://evil"), false);
    assert.equal(workerOrigin("http://updater:8090", "updater"), "http://updater:8090");
    assert.throws(() => workerOrigin("http://evil:8090", "updater"), /not allowed/i);
    assert.throws(() => workerOrigin("https://updater:8090", "updater"), /not allowed/i);
});

test("health is public but protected routes hide authentication failures", async t => {
    const origin = await listen(t, { fetchImpl: async () => { throw new Error("worker offline"); } });
    const health = await fetch(origin + "/healthz");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "updater-gateway");

    const hidden = await fetch(origin + "/status");
    assert.equal(hidden.status, 404);
});

test("closed maintenance window returns controlled HTTP 409", async t => {
    let unavailable = 0;
    const origin = await listen(t, {
        fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND updater"); },
        onWorkerUnavailable: () => { unavailable += 1; }
    });
    const response = await fetch(origin + "/status", { headers: { Authorization: "Bearer " + TOKEN } });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.code, "UPDATER_MAINTENANCE_REQUIRED");
    assert.equal(unavailable, 1);
});

test("gateway forwards only validated method path body and token", async t => {
    const calls = [];
    const origin = await listen(t, {
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return new Response(JSON.stringify({ ok: true, accepted: true }), {
                status: 202,
                headers: { "Content-Type": "application/json", "Retry-After": "3" }
            });
        }
    });
    const response = await fetch(origin + "/run", {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "UPDATE SIRK CENTRAL" })
    });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("retry-after"), "3");
    assert.equal((await response.json()).accepted, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://updater:8090/run");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers.Authorization, "Bearer " + TOKEN);
    assert.match(Buffer.from(calls[0].options.body).toString("utf8"), /UPDATE SIRK CENTRAL/);
});

test("oversized bodies are rejected before proxying", async t => {
    let calls = 0;
    const origin = await listen(t, {
        maxBodyBytes: 8192,
        fetchImpl: async () => { calls += 1; return new Response("{}"); }
    });
    const response = await fetch(origin + "/run", {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(9000) })
    });
    assert.equal(response.status, 413);
    assert.equal(calls, 0);
});
