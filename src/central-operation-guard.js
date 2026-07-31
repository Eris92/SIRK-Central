"use strict";

const { identityActive } = require("./rbac");

function isSensitiveWrite(method, pathname) {
    const verb = String(method || "").toUpperCase();
    const route = String(pathname || "");
    if (verb === "POST" && [
        "/api/settings/update/run",
        "/api/settings/update/rollback",
        "/api/settings/backup/run",
        "/api/settings/backup/run-v2",
        "/api/settings/backup/restore"
    ].includes(route)) return true;
    if (verb === "PUT" && [
        "/api/settings/backup/policy",
        "/api/backup-management/policy"
    ].includes(route)) return true;
    if (verb === "DELETE" && /^\/api\/settings\/backup\/[^/]+$/.test(route)) return true;
    return false;
}

function canExecute(actor) {
    return Boolean(identityActive(actor) && (actor.builtIn === true || actor.role === "Admin"));
}

function evaluate(actor, method, pathname) {
    if (!isSensitiveWrite(method, pathname)) return { handled: false, allowed: true, status: 0 };
    if (!actor) return { handled: true, allowed: false, status: 401, error: "Authentication required." };
    if (!canExecute(actor)) return { handled: true, allowed: false, status: 403, error: "Admin or Break-Glass is required for this operation." };
    return { handled: false, allowed: true, status: 0 };
}

module.exports = { isSensitiveWrite, canExecute, evaluate };
