"use strict";

const http = require("node:http");
const { createRestoreApp } = require("./server-v9");
const heartbeatApiFactory = require("./portal-heartbeat-api");
const { loadConfig } = require("./server-v1");

const VERSION = "1.0.0-rc.14";

function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    res.end(data);
}

function createPortalRuntime(config) {
    const app = createRestoreApp(config);
    const inner = app.server.listeners("request")[0];
    if (typeof inner !== "function") throw new Error("SIRK Central v9 request handler is unavailable.");
    const heartbeatApi = heartbeatApiFactory.create({ app, config });

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if (await heartbeatApi.handler(req, res, url)) return;
            return inner(req, res);
        } catch (error) {
            if (!res.headersSent) return json(res, error.statusCode || 400, {
                ok: false,
                code: error.code || "REQUEST_REJECTED",
                error: error.message || "Request failed."
            });
            res.destroy(error);
        }
    });
    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    return Object.assign({}, app, {
        server,
        version: VERSION,
        portalTelemetry: heartbeatApi.telemetry,
        portalRegistry: heartbeatApi.portals
    });
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createPortalRuntime(config);
    app.server.listen(config.port, config.bindHost, () => {
        process.stdout.write("SIRK Central v10 listening on " + config.bindHost + ":" + config.port + "\n");
    });
}

module.exports = { createPortalRuntime, VERSION };
