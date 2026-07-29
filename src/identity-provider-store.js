"use strict";

const fs = require("node:fs");
const path = require("node:path");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTITY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function create(options) {
    const dataDir = path.resolve(options.dataDir);
    const storePath = path.join(dataDir, "identity-provider.json");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    function fallback() {
        const env = options.env || {};
        return {
            schema: 1,
            enabled: Boolean(env.SIRK_ENTRA_CLIENT_ID && env.SIRK_ENTRA_CLIENT_SECRET),
            tenant: String(env.SIRK_ENTRA_TENANT || "organizations"),
            clientId: String(env.SIRK_ENTRA_CLIENT_ID || ""),
            clientSecret: String(env.SIRK_ENTRA_CLIENT_SECRET || ""),
            allowedIdentities: String(env.SIRK_ENTRA_ADMIN_IDENTITIES || "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean),
            updatedAtUtc: null
        };
    }

    function read() {
        if (!fs.existsSync(storePath)) return fallback();
        const value = JSON.parse(fs.readFileSync(storePath, "utf8"));
        if (!value || value.schema !== 1) throw new Error("Identity provider configuration has an unsupported format.");
        value.allowedIdentities = Array.isArray(value.allowedIdentities) ? value.allowedIdentities : [];
        return value;
    }

    function publicView() {
        const value = read();
        return {
            enabled: Boolean(value.enabled),
            tenant: value.tenant,
            clientId: value.clientId,
            clientSecretConfigured: Boolean(value.clientSecret),
            allowedIdentities: value.allowedIdentities,
            redirectUri: options.authOrigin + "/auth/entra/callback",
            logoutUrl: options.authOrigin + "/auth/entra/frontchannel-logout",
            updatedAtUtc: value.updatedAtUtc
        };
    }

    function update(input, updateOptions) {
        const current = read();
        const allowSecurity = Boolean(updateOptions && updateOptions.allowSecurity);
        const tenant = String(input.tenant || "organizations").trim().toLowerCase();
        if (!(tenant === "organizations" || tenant === "common" || UUID.test(tenant))) throw new Error("Tenant must be organizations, common or a tenant UUID.");
        const clientId = String(input.clientId || "").trim();
        if (!UUID.test(clientId)) throw new Error("Application Client ID is invalid.");

        let allowedIdentities = current.allowedIdentities;
        let clientSecret = current.clientSecret;
        if (allowSecurity) {
            const identities = Array.isArray(input.allowedIdentities) ? input.allowedIdentities : String(input.allowedIdentities || "").split(/[\n,]+/);
            allowedIdentities = [...new Set(identities.map(v => String(v).trim().toLowerCase()).filter(Boolean))];
            if (allowedIdentities.some(v => !IDENTITY.test(v))) throw new Error("Allowed identities must use tenant-id:object-id format.");
            const suppliedSecret = String(input.clientSecret || "");
            clientSecret = suppliedSecret || current.clientSecret;
        }

        if (Boolean(input.enabled) && !clientSecret) throw new Error("Client Secret is required before enabling Entra.");
        const value = {
            schema: 1,
            enabled: Boolean(input.enabled),
            tenant,
            clientId,
            clientSecret,
            allowedIdentities,
            updatedAtUtc: new Date().toISOString()
        };
        const temporary = storePath + ".tmp-" + process.pid + "-" + Date.now();
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(temporary, storePath);
        return publicView();
    }

    return { read, publicView, update, storePath };
}

module.exports = { create };