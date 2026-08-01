"use strict";

const { json } = require("../http/transport");

const heartbeatApiFactory = require("../portal-heartbeat-api");

const { VERSION } = require("../version");


function registerPortalTelemetry(app, config) {
    const heartbeatApi = heartbeatApiFactory.create({ app, config });

    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if (await heartbeatApi.handler(req, res, url)) return;
            return false;
        } catch (error) {
            if (!res.headersSent) return json(res, error.statusCode || 400, {
                ok: false,
                code: error.code || "REQUEST_REJECTED",
                error: error.message || "Request failed."
            });
            res.destroy(error);
        }
    };
    app.router.prepend(handler);
    Object.assign(app, {
        version: VERSION,
        portalTelemetry: heartbeatApi.telemetry,
        portalRegistry: heartbeatApi.portals
    });
    return app
}

module.exports = { registerPortalTelemetry, VERSION };
