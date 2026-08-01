"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { hashSecret, hashAccessKey } = require("../src/security");
const { createCentralRuntime } = require("../src/server");

const TEST_ORIGIN = "https://central.example.test";

function request(port, method, route, body, cookie, accessKey, csrfToken) {
    return new Promise((resolve, reject) => {
        const payload = body == null ? null : Buffer.from(JSON.stringify(body));
        const req = require("node:http").request({
            hostname: "127.0.0.1",
            port,
            method,
            path: route,
            headers: Object.assign({
                Origin: TEST_ORIGIN
            }, payload ? {
                "Content-Type": "application/json",
                "Content-Length": payload.length
            } : {}, cookie ? { Cookie: cookie } : {}, accessKey ? {
                "Authorization": "Bearer " + accessKey
            } : {}, csrfToken ? {
                "X-SIRK-CSRF": csrfToken
            } : {})
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                const isJson = /application\/json/i.test(String(res.headers["content-type"] || ""));
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    text,
                    body: isJson ? JSON.parse(text) : null
                });
            });
        });
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function responseCookies(response) {
    const values = response.headers["set-cookie"] || [];
    return (Array.isArray(values) ? values : [values])
        .map(value => String(value).split(";", 1)[0])
        .filter(Boolean)
        .join("; ");
}

function cookieValue(cookieHeader, name) {
    const match = String(cookieHeader || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
    return match ? match[1] : "";
}

test("admin login lists an authenticated outbound Portal and connects to it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-central-http-"));
    const accessKey = "central-test-access-key-0123456789abcdef";
    const config = {
        dataDir: root,
        publicOrigin: TEST_ORIGIN,
        adminUsername: "admin",
        adminPasswordHash: hashSecret("central-test-password"),
        accessKeyHash: hashAccessKey(accessKey),
        sessionIdleMinutes: 30,
        sessionAbsoluteHours: 8,
        trustProxy: false,
        env: { NODE_ENV: "test", SIRK_RUNTIME_LOCK_DISABLED: "true", SIRK_AUDIT_INTEGRITY_KEY: "K".repeat(48) },
        sessionHours: 1
    };
    const app = createCentralRuntime(config);
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const port = app.server.address().port;
    const created = app.store.createPortal({ id: "portal-one", name: "Portal One" });
    let socket;
    try {
        socket = new WebSocket("ws://127.0.0.1:" + port + "/tunnel", {
            headers: {
                "Authorization": "SIRK-Portal " +
                    Buffer.from(created.id + ":" + created.token).toString("base64url")
            }
        });
        socket.on("message", (raw) => {
            const message = JSON.parse(String(raw));
            if (message.kind === "portal-info") {
                socket.send(JSON.stringify({
                    type: "response",
                    requestId: message.requestId,
                    portal: { id: created.id, hostname: "local-test" }
                }));
                return;
            }
            if (message.path === "/") {
                socket.send(JSON.stringify({
                    type: "response",
                    requestId: message.requestId,
                    statusCode: 302,
                    contentType: "text/plain",
                    location: "/login",
                    bodyBase64: ""
                }));
                return;
            }
            if (message.path === "/login") {
                socket.send(JSON.stringify({
                    type: "response",
                    requestId: message.requestId,
                    statusCode: 200,
                    contentType: "text/html; charset=utf-8",
                    bodyBase64: Buffer.from(
                        '<script>window.portalUrl="/";</script><script src="/assets/login.js"></script>'
                    ).toString("base64")
                }));
                return;
            }
            socket.send(JSON.stringify({
                type: "response",
                requestId: message.requestId,
                statusCode: 200,
                contentType: "application/json",
                setCookie: ["sirk_session=local-session; Path=/; HttpOnly; Secure; SameSite=Strict"],
                bodyBase64: Buffer.from('{"ok":true}').toString("base64")
            }));
        });
        await new Promise((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
        });
        const missingKey = await request(port, "POST", "/api/login", {
            username: "admin",
            password: "central-test-password"
        });
        assert.equal(missingKey.statusCode, 404);
        const login = await request(port, "POST", "/api/login", {
            username: "admin",
            password: "central-test-password"
        }, null, accessKey);
        assert.equal(login.statusCode, 200);
        const cookie = responseCookies(login);
        const csrfToken = cookieValue(cookie, "sirk_central_csrf");
        assert.match(cookie, /(?:^|;\s*)sirk_central_session=/);
        assert.match(csrfToken, /^[A-Za-z0-9_-]{32,128}$/);

        const portals = await request(port, "GET", "/api/portals", null, cookie, accessKey);
        assert.equal(portals.body.portals[0].status, "online");
        const connected = await request(port, "POST", "/api/portals/portal-one/connect", {}, cookie, accessKey, csrfToken);
        assert.equal(connected.statusCode, 200);
        assert.equal(connected.body.portal.hostname, "local-test");
        assert.equal(connected.body.url, "/connect/portal-one/");

        const redirected = await request(port, "GET", connected.body.url, null, cookie);
        assert.equal(redirected.statusCode, 302);
        assert.equal(redirected.headers.location, "/connect/portal-one/login");

        const loginPage = await request(port, "GET", "/connect/portal-one/login", null, cookie);
        assert.equal(loginPage.statusCode, 200);
        assert.match(loginPage.text, /src="\/connect\/portal-one\/assets\/login\.js"/);
        assert.match(loginPage.text, /window\.portalUrl="\/connect\/portal-one\/"/);

        const localLogin = await request(
            port,
            "POST",
            "/connect/portal-one/api/auth/login",
            { username: "local", password: "local" },
            cookie
        );
        assert.equal(localLogin.statusCode, 200);
        assert.match(localLogin.headers["set-cookie"][0], /^sirk_session=local-session;/);
        assert.match(localLogin.headers["set-cookie"][0], /Path=\/connect\/portal-one\//);
    } finally {
        if (socket) socket.close();
        await app.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
