"use strict";

const { loadConfig, createApplication } = require("./application");
const { attachRuntimeLifecycle } = require("./runtime-lifecycle");
const { registerAuthHardening } = require("./modules/auth-hardening");
const { registerCanonicalLoginRoute } = require("./modules/canonical-login-route");
const { registerBreakGlassUi } = require("./modules/break-glass-ui");
const { registerBackupAgeKeyManagement } = require("./modules/backup-age-key-management");
const { registerApplianceManagement } = require("./modules/appliance-management");
const { registerWorkspaceAuthorization } = require("./modules/workspace-authorization");
const { registerWebAuthnAuthentication } = require("./modules/webauthn-authentication");
const { registerPasskeyManagement } = require("./modules/passkey-management");
const { registerWebAuthnAttestation } = require("./modules/webauthn-attestation");
const { registerUiAssets } = require("./modules/ui-assets");
const { registerContinuity } = require("./modules/continuity");
const { registerMaintenance } = require("./modules/maintenance");
const { registerPortalTelemetry } = require("./modules/portal-telemetry");
const { registerPortalBootstrap } = require("./modules/portal-bootstrap");
const { registerPortalEnrollment } = require("./modules/portal-enrollment");
const { registerPortalReleaseCatalog } = require("./modules/portal-release-catalog");
const { registerAdministration } = require("./modules/administration");
const { registerSecurityApi } = require("./modules/security-api");
const { registerApprovals } = require("./modules/approvals");
const { registerPortalCommands } = require("./modules/portal-commands");
const { registerTickets } = require("./modules/tickets");
const { registerPortalTunnel } = require("./modules/portal-tunnel");

const { VERSION } = require("./version");

function createCentralRuntime(config) {
    const app = createApplication(config);
    const modules = [
        registerAuthHardening,
        registerCanonicalLoginRoute,
        registerBreakGlassUi,
        registerBackupAgeKeyManagement,
        registerApplianceManagement,
        registerWorkspaceAuthorization,
        registerWebAuthnAuthentication,
        registerPasskeyManagement,
        registerWebAuthnAttestation,
        registerUiAssets,
        registerContinuity,
        registerMaintenance,
        registerPortalTelemetry,
        registerPortalBootstrap,
        registerPortalEnrollment,
        registerPortalReleaseCatalog,
        registerAdministration,
        registerSecurityApi,
        registerApprovals,
        registerPortalCommands,
        registerTickets,
        registerPortalTunnel
    ];
    for (const register of modules) register(app, config);
    app.version = VERSION;
    return attachRuntimeLifecycle(app);
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createCentralRuntime(config);
    const shutdown = signal => {
        process.stdout.write("SIRK Central received " + signal + "; closing.\n");
        app.close().then(() => process.exit(0), () => process.exit(1));
        setTimeout(() => process.exit(1), 15000).unref();
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
    app.server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central listening on " + config.bindHost + ":" + config.port + "\n"));
}

module.exports = { loadConfig, createApplication, createCentralRuntime, VERSION };
