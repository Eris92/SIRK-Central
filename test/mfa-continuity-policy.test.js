"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const policy = require("../src/mfa-continuity-policy");

function stores(activePasskeys, recoveryRemaining) {
    return {
        passkeys: {
            activeCount() { return activePasskeys; },
            getActive(id) { return id === "credential-active" ? { credentialId: id } : null; }
        },
        recoveryCodes: {
            status() { return { configured: recoveryRemaining > 0, remaining: recoveryRemaining }; }
        }
    };
}

const identity = { identityKey: "breakglass:admin", username: "admin" };

test("last passkey cannot be revoked without unused recovery code", () => {
    const value = stores(1, 0);
    assert.throws(
        () => policy.assertCanRevokePasskey(value.passkeys, value.recoveryCodes, identity, "credential-active"),
        error => error.code === "MFA_CONTINUITY_REQUIRED" && error.statusCode === 409
    );
});

test("last passkey can be revoked when recovery code remains", () => {
    const value = stores(1, 1);
    const state = policy.assertCanRevokePasskey(value.passkeys, value.recoveryCodes, identity, "credential-active");
    assert.equal(state.hasRecovery, true);
});

test("one of multiple passkeys can be revoked without recovery code", () => {
    const value = stores(2, 0);
    const state = policy.assertCanRevokePasskey(value.passkeys, value.recoveryCodes, identity, "credential-active");
    assert.equal(state.activePasskeys, 2);
});

test("recovery codes cannot be revoked without an active passkey", () => {
    const value = stores(0, 5);
    assert.throws(
        () => policy.assertCanRevokeRecoveryCodes(value.passkeys, value.recoveryCodes, identity),
        error => error.code === "MFA_CONTINUITY_REQUIRED" && error.statusCode === 409
    );
});

test("recovery codes can be revoked when a passkey is active", () => {
    const value = stores(1, 5);
    const state = policy.assertCanRevokeRecoveryCodes(value.passkeys, value.recoveryCodes, identity);
    assert.equal(state.hasPasskey, true);
});
