"use strict";

const { loadConfig, createApplication } = require("./application");
const { registerAuthHardening } = require("./modules/auth-hardening");
const { registerBreakGlassUi } = require("./modules/break-glass-ui");
const { registerWorkspaceAuthorization } = require("./modules/workspace-authorization");
const { registerWebAuthnAuthentication } = require("./modules/webauthn-authentication");
const { registerPasskeyManagement } = require("./modules/passkey-management");
const { registerWebAuthnAttestation } = require("./modules/webauthn-attestation");
const { registerUiAssets } = require("./modules/ui-assets");
const { registerContinuity } = require("./modules/continuity");
const { registerMaintenance } = require("./modules/maintenance");
const { registerPortalTelemetry } = require("./modules/portal-telemetry");
const { registerAdministration } = require("./modules/administration");
const { registerSecurityApi } = require("./modules/security-api");
const { registerApprovals } = require("./modules/approvals");
const { registerPortalCommands } = require("./modules/portal-commands");
const { registerTickets } = require("./modules/tickets");

const { VERSION } = require("./version");

function createCentralRuntime(config, options = {}) {
    const app = createApplication(config);
    const modules = [
        ["auth-hardening", registerAuthHardening],
        ["break-glass-ui", registerBreakGlassUi],
        ["workspace-authorization", registerWorkspaceAuthorization],
        ["webauthn-authentication", registerWebAuthnAuthentication],
        ["passkey-management", registerPasskeyManagement],
        ["webauthn-attestation", registerWebAuthnAttestation],
        ["ui-assets", registerUiAssets],
        ["continuity", registerContinuity],
        ["maintenance", registerMaintenance],
        ["portal-telemetry", registerPortalTelemetry],
        ["administration", registerAdministration],
        ["security-api", registerSecurityApi],
        ["approvals", registerApprovals],
        ["portal-commands", registerPortalCommands],
        ["tickets", registerTickets]
    ];
    const through = String(options.through || "");
    for (const [id, register] of modules) {
        register(app, config);
        if (through && id === through) break;
    }
    if (through && !modules.some(([id]) => id === through)) throw new Error("Unknown runtime module: " + through);
    app.version = VERSION;
    return app;
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createCentralRuntime(config);
    const shutdown = signal => {
        process.stdout.write("SIRK Central received " + signal + "; closing.\n");
        app.server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 15000).unref();
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
    app.server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central listening on " + config.bindHost + ":" + config.port + "\n"));
}

module.exports = { loadConfig, createApplication, createCentralRuntime, VERSION };
