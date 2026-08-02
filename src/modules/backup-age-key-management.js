"use strict";

const { json, parseCookies, readBody, securityHeaders } = require("../http/transport");
const { verifySecret } = require("../security");
const backupAgeStoreFactory = require("../backup-age-key-store");
const { validRecipient, validIdentity } = require("../backup-age-key-store");
const { generateAgeIdentity } = require("../age-keygen");
const { VERSION } = require("../version");

const CONFIRMATION = "GENERATE AGE BACKUP KEY";
const EXPORT_NAME = "sirk-central-backup-key.sirkkey";

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
    if (!recipient) return {
        configured: false,
        source: "none",
        recipient: "",
        keyPersisted: false,
        migrationRequired: false,
        updatedAtUtc: "",
        updatedBy: ""
    };
    if (!validRecipient(recipient)) {
        throw Object.assign(new Error("Configured age backup recipient is invalid."), {
            code: "BACKUP_AGE_RECIPIENT_INVALID",
            statusCode: 503
        });
    }
    return {
        configured: true,
        source: "environment",
        recipient,
        keyPersisted: false,
        migrationRequired: true,
        updatedAtUtc: "",
        updatedBy: "environment"
    };
}

function downloadEncryptedExport(res, store, headers = {}) {
    const data = store.exportEncrypted();
    res.writeHead(200, Object.assign({}, securityHeaders(), {
        "Content-Type": "application/vnd.sirk.encrypted-key+json",
        "Content-Length": String(data.length),
        "Content-Disposition": `attachment; filename="${EXPORT_NAME}"`,
        "Cache-Control": "no-store, max-age=0",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff"
    }, headers));
    res.end(data);
}

function audit(app, event, actor, details) {
    if (app.securityCenter && typeof app.securityCenter.audit === "function") {
        app.securityCenter.audit(event, actor, details || {});
    }
}

function clearSessionCookie() {
    return "sirk_central_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

function changePassword(app, config, store, actor, currentPassword, newPassword, req, res) {
    if (!verifySecret(currentPassword, passwordHash(app, config))) {
        return json(res, 401, { ok: false, error: "Current password is invalid." });
    }
    if (typeof newPassword !== "string" || newPassword.length < 12 || Buffer.byteLength(newPassword, "utf8") > 4096) {
        return json(res, 400, { ok: false, error: "New Break-Glass password is invalid." });
    }
    const transaction = store.stageRewrap(currentPassword, newPassword, actor);
    let passwordChanged = false;
    try {
        app.userStore.setBreakGlassPassword(newPassword);
        passwordChanged = true;
        transaction.commit();
    } catch (error) {
        transaction.abort();
        if (passwordChanged) {
            try { app.userStore.setBreakGlassPassword(currentPassword); }
            catch (rollbackError) {
                audit(app, "breakglass.password.rollback_failed", actor, {
                    backupKeyConfigured: transaction.configured,
                    errorCode: String(rollbackError.code || "ROLLBACK_FAILED")
                });
                throw Object.assign(new Error("Break-Glass password change failed and rollback requires recovery."), {
                    code: "BREAKGLASS_PASSWORD_ROLLBACK_FAILED",
                    statusCode: 503,
                    cause: error
                });
            }
        }
        throw error;
    }
    const currentToken = parseCookies(req).sirk_central_session || "";
    const revoked = app.sessions && typeof app.sessions.revokeWhere === "function"
        ? app.sessions.revokeWhere(record => record.builtIn === true && record.source === "local", currentToken)
        : 0;
    if (app.sessions && typeof app.sessions.revokeToken === "function" && currentToken) app.sessions.revokeToken(currentToken);
    audit(app, "breakglass.password.changed", actor, {
        revokedSessions: revoked,
        backupKeyRewrapped: transaction.configured
    });
    return json(res, 200, {
        ok: true,
        reauthenticationRequired: true,
        revokedSessions: revoked,
        backupKeyRewrapped: transaction.configured
    }, { "Set-Cookie": clearSessionCookie() });
}

function registerBackupAgeKeyManagement(app, config) {
    const store = backupAgeStoreFactory.create({ dataDir: config.dataDir });

    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const isStatus = req.method === "GET" && url.pathname === "/api/break-glass/backup-age/status";
            const isGenerate = req.method === "POST" && url.pathname === "/api/break-glass/backup-age/identity";
            const isExport = req.method === "POST" && url.pathname === "/api/break-glass/backup-age/export";
            const isPasswordChange = req.method === "POST" && url.pathname === "/api/break-glass/password";
            if (!isStatus && !isGenerate && !isExport && !isPasswordChange) return false;

            const actor = breakGlassActor(app, req);
            if (!actor) return json(res, 403, { ok: false, error: "Break-Glass session required." });
            if (isStatus) return json(res, 200, Object.assign({ ok: true }, status(store, config)));

            const origin = String(req.headers.origin || "");
            if (origin && origin !== config.publicOrigin) return json(res, 403, { ok: false, error: "Origin rejected." });
            const body = await readBody(req, 16384);
            const currentPassword = String(body.currentPassword || "");

            if (isPasswordChange) {
                return changePassword(app, config, store, actor, currentPassword, body.newPassword, req, res);
            }

            if (!verifySecret(currentPassword, passwordHash(app, config))) {
                return json(res, 401, { ok: false, error: "Current password is invalid." });
            }

            if (isExport) {
                store.unlock(currentPassword);
                audit(app, "breakglass.backup_age_key.exported", actor, { recipient: store.read().recipient });
                return downloadEncryptedExport(res, store, { "X-SIRK-Age-Recipient": store.read().recipient });
            }

            if (body.confirm !== CONFIRMATION) {
                return json(res, 400, { ok: false, error: "Backup key generation confirmation is invalid." });
            }

            const previous = status(store, config);
            const generated = typeof app.generateAgeIdentity === "function"
                ? app.generateAgeIdentity()
                : generateAgeIdentity();
            if (!generated || !validRecipient(generated.recipient) || !validIdentity(generated.identity)) {
                throw Object.assign(new Error("Age key generator returned an invalid result."), { statusCode: 503 });
            }
            const record = store.setIdentity(generated.identity, generated.recipient, currentPassword, actor);
            audit(app, "breakglass.backup_age_identity.generated", actor, {
                recipient: record.recipient,
                rotated: Boolean(previous.configured),
                previousSource: previous.source,
                keyPersisted: true,
                rotation: record.rotation
            });

            return downloadEncryptedExport(res, store, {
                "X-SIRK-Age-Recipient": record.recipient,
                "X-SIRK-Age-Key-Persisted": "true",
                "X-SIRK-Age-Key-Rotation": String(record.rotation || 1)
            });
        } catch (error) {
            const code = error.code || "REQUEST_REJECTED";
            const responseStatus = Number.isInteger(error.statusCode) ? error.statusCode : 500;
            const message = responseStatus >= 500 ? "Encrypted backup key operation failed." : error.message || "Request failed.";
            audit(app, "breakglass.backup_age_key.operation_failed", null, { code, statusCode: responseStatus });
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
    passwordHash,
    status,
    downloadEncryptedExport,
    changePassword,
    CONFIRMATION,
    EXPORT_NAME,
    VERSION
};
