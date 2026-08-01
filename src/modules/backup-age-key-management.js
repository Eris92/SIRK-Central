"use strict";

const { json, parseCookies, readBody, securityHeaders } = require("../http/transport");
const { verifySecret } = require("../security");
const backupAgeStoreFactory = require("../backup-age-key-store");
const { validRecipient } = require("../backup-age-key-store");
const { generateAgeIdentity } = require("../age-keygen");
const { VERSION } = require("../version");

const CONFIRMATION = "GENERATE AGE BACKUP KEY";
const DOWNLOAD_NAME = "sirk-central-backup.agekey";

function breakGlassActor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    const actor = token && app.sessions ? app.sessions.get(token, true) : null;
    if (!actor || actor.builtIn !== true || actor.source !== "local" || actor.role !== "BreakGlass") return null;
    return actor;
}

function passwordHash(app, config) {
    const overrides = app.userStore && typeof app.userStore.securityOverrides === "function"
        ? app.userStore.securityOverrides()
        : {};
    return overrides.breakGlassPasswordHash || config.adminPasswordHash;
}

function status(store, config) {
    const saved = store.read();
    if (saved) return Object.assign({ configured: true, source: "break-glass-ui" }, saved);
    const recipient = String(config.env.SIRK_BACKUP_AGE_RECIPIENT || "").trim();
    if (!recipient) return { configured: false, source: "none", recipient: "", updatedAtUtc: "", updatedBy: "" };
    if (!validRecipient(recipient)) {
        throw Object.assign(new Error("Configured age backup recipient is invalid."), {
            code: "BACKUP_AGE_RECIPIENT_INVALID",
            statusCode: 503
        });
    }
    return { configured: true, source: "environment", recipient, updatedAtUtc: "", updatedBy: "environment" };
}

function registerBackupAgeKeyManagement(app, config) {
    const store = backupAgeStoreFactory.create({ dataDir: config.dataDir });

    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const isStatus = req.method === "GET" && url.pathname === "/api/break-glass/backup-age/status";
            const isGenerate = req.method === "POST" && url.pathname === "/api/break-glass/backup-age/identity";
            if (!isStatus && !isGenerate) return false;

            const actor = breakGlassActor(app, req);
            if (!actor) return json(res, 403, { ok: false, error: "Break-Glass session required." });

            if (isStatus) return json(res, 200, Object.assign({ ok: true }, status(store, config)));

            const origin = String(req.headers.origin || "");
            if (origin && origin !== config.publicOrigin) return json(res, 403, { ok: false, error: "Origin rejected." });
            const body = await readBody(req, 16384);
            if (!verifySecret(String(body.currentPassword || ""), passwordHash(app, config))) {
                return json(res, 401, { ok: false, error: "Current password is invalid." });
            }
            if (body.confirm !== CONFIRMATION) {
                return json(res, 400, { ok: false, error: "Backup key generation confirmation is invalid." });
            }

            const previous = status(store, config);
            const generated = typeof app.generateAgeIdentity === "function"
                ? app.generateAgeIdentity()
                : generateAgeIdentity();
            if (!generated || !validRecipient(generated.recipient) || typeof generated.identity !== "string") {
                throw Object.assign(new Error("Age key generator returned an invalid result."), { statusCode: 503 });
            }
            const record = store.set(generated.recipient, actor);
            if (app.securityCenter && typeof app.securityCenter.audit === "function") {
                app.securityCenter.audit("breakglass.backup_age_identity.generated", actor, {
                    recipient: record.recipient,
                    rotated: Boolean(previous.configured),
                    previousSource: previous.source
                });
            }

            const data = Buffer.from(generated.identity, "utf8");
            res.writeHead(200, Object.assign({}, securityHeaders(), {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(data.length),
                "Content-Disposition": `attachment; filename="${DOWNLOAD_NAME}"`,
                "Cache-Control": "no-store, max-age=0",
                "Pragma": "no-cache",
                "X-SIRK-Age-Recipient": record.recipient,
                "X-SIRK-Age-Key-Shown-Once": "true",
                "X-Content-Type-Options": "nosniff"
            }));
            return res.end(data);
        } catch (error) {
            const code = error.code || "REQUEST_REJECTED";
            const responseStatus = Number.isInteger(error.statusCode) ? error.statusCode : 500;
            const message = responseStatus >= 500 ? "Age backup key generation failed." : error.message || "Request failed.";
            if (!res.headersSent) return json(res, responseStatus, { ok: false, code, error: message });
            res.destroy(error);
        }
    };

    app.router.prepend(handler);
    Object.assign(app, { backupAgeStore: store, version: VERSION });
    return app;
}

module.exports = {
    registerBackupAgeKeyManagement,
    breakGlassActor,
    status,
    CONFIRMATION,
    DOWNLOAD_NAME,
    VERSION
};
