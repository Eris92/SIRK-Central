"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const portalStoreFactory = require("../src/portal-store");
const { handleSelfService } = require("../src/modules/portal-connection-admin");

function request(method, url, portalId, token, body) {
    const raw = body == null ? "" : JSON.stringify(body);
    const req = Readable.from(raw ? [Buffer.from(raw)] : []);
    req.method = method;
    req.url = url;
    req.headers = {
        authorization: token ? "Bearer " + token : "",
        "x-sirk-portal-id": portalId,
        "content-type": "application/json"
    };
    req.socket = { remoteAddress: "127.0.0.1" };
    return req;
}

function response() {
    return {
        statusCode: 200,
        headers: {},
        body: "",
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        end(value) { this.body = value == null ? "" : String(value); }
    };
}

async function invoke(app, config, method, url, portalId, token, body) {
    const req = request(method, url, portalId, token, body);
    const res = response();
    const handled = await handleSelfService(app, config, req, res, new URL(url, "http://central.local"));
    assert.equal(handled, true);
    let parsed = {};
    if (res.body) parsed = JSON.parse(res.body);
    return { status: res.statusCode, body: parsed };
}

async function run() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-central-self-service-"));
    const store = portalStoreFactory.create({ dataDir: root });
    const created = store.createPortal({ id: "portal-test", name: "Portal Test" });
    const disconnected = [];
    const app = {
        portalStore: store,
        broker: {
            list(portals) { return portals.map(portal => Object.assign({}, portal, { connected: true, connectionState: "online" })); },
            disconnect(id) { disconnected.push(id); }
        },
        securityCenter: { audit() {} }
    };
    const config = {
        publicOrigin: "https://central.sirkportal.com",
        env: {}
    };

    try {
        const initial = await invoke(app, config, "GET", "/api/portal/v1/connection", created.id, created.token);
        assert.equal(initial.status, 200);
        assert.equal(initial.body.portal.connected, true);
        assert.equal(initial.body.portal.name, "Portal Test");

        const renamed = await invoke(app, config, "PATCH", "/api/portal/v1/connection", created.id, created.token, {
            name: "Portal Renamed"
        });
        assert.equal(renamed.status, 200);
        assert.equal(renamed.body.portal.name, "Portal Renamed");
        assert.equal(store.get(created.id).name, "Portal Renamed");

        const rotated = await invoke(app, config, "POST", "/api/portal/v1/connection/rotate", created.id, created.token, {});
        assert.equal(rotated.status, 200);
        assert.equal(rotated.body.bootstrap.portalId, created.id);
        assert.equal(rotated.body.bootstrap.portalName, "Portal Renamed");
        assert.match(rotated.body.bootstrap.portalToken, /^[A-Za-z0-9_-]{32,}$/);
        assert.notEqual(rotated.body.bootstrap.portalToken, created.token);
        assert.deepEqual(disconnected, [created.id]);

        const oldRejected = await invoke(app, config, "GET", "/api/portal/v1/connection", created.id, created.token);
        assert.equal(oldRejected.status, 401);

        const newAccepted = await invoke(app, config, "GET", "/api/portal/v1/connection", created.id, rotated.body.bootstrap.portalToken);
        assert.equal(newAccepted.status, 200);
        assert.equal(newAccepted.body.portal.name, "Portal Renamed");

        const removed = await invoke(app, config, "DELETE", "/api/portal/v1/connection", created.id, rotated.body.bootstrap.portalToken, {});
        assert.equal(removed.status, 200);
        assert.equal(removed.body.portal.id, created.id);
        assert.equal(store.get(created.id), null);
        assert.deepEqual(disconnected, [created.id, created.id]);

        const removedRejected = await invoke(app, config, "GET", "/api/portal/v1/connection", created.id, rotated.body.bootstrap.portalToken);
        assert.equal(removedRejected.status, 401);

        console.log("portal-connection-self-service: OK");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
