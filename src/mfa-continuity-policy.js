"use strict";

function snapshot(passkeys, recoveryCodes, identity) {
    const activePasskeys = Math.max(0, Number(passkeys.activeCount(identity) || 0));
    const recovery = recoveryCodes.status(identity) || {};
    const recoveryRemaining = Math.max(0, Number(recovery.remaining || 0));
    return {
        activePasskeys,
        recoveryConfigured: recovery.configured === true,
        recoveryRemaining,
        hasPasskey: activePasskeys > 0,
        hasRecovery: recoveryRemaining > 0,
        methods: [activePasskeys > 0 ? "passkey" : null, recoveryRemaining > 0 ? "recovery-code" : null].filter(Boolean)
    };
}

function assertCanRevokePasskey(passkeys, recoveryCodes, identity, credentialId) {
    const current = passkeys.getActive(credentialId, identity);
    const state = snapshot(passkeys, recoveryCodes, identity);
    if (!current) throw new Error("Passkey not found or revoked.");
    if (state.activePasskeys <= 1 && !state.hasRecovery) {
        const error = new Error("Cannot revoke the last active passkey without at least one unused recovery code.");
        error.statusCode = 409;
        error.code = "MFA_CONTINUITY_REQUIRED";
        throw error;
    }
    return state;
}

function assertCanRevokeRecoveryCodes(passkeys, recoveryCodes, identity) {
    const state = snapshot(passkeys, recoveryCodes, identity);
    if (!state.hasPasskey) {
        const error = new Error("Cannot revoke recovery codes without at least one active passkey.");
        error.statusCode = 409;
        error.code = "MFA_CONTINUITY_REQUIRED";
        throw error;
    }
    return state;
}

module.exports = { snapshot, assertCanRevokePasskey, assertCanRevokeRecoveryCodes };
