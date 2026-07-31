"use strict";

const ASSIGNABLE_ROLES = Object.freeze([
    "Auditor",
    "OperatorL1",
    "SupportL2",
    "EngineerL3",
    "Admin",
    "SecAdmin"
]);

const ROLE_PERMISSIONS = Object.freeze({
    Auditor: ["portals.read", "settings.read", "audit.read"],
    OperatorL1: ["portals.read", "portals.connect", "operations.l1"],
    SupportL2: ["portals.read", "portals.connect", "operations.l1", "operations.l2"],
    EngineerL3: ["portals.read", "portals.connect", "operations.l1", "operations.l2", "operations.l3"],
    Admin: ["portals.read", "portals.connect", "portals.manage", "settings.read", "settings.manage", "identity.manage", "users.manage", "access.manage"],
    SecAdmin: ["portals.read", "portals.connect", "settings.read", "identity.manage", "security.manage", "security.sessions", "security.policies", "security.incidents", "users.manage", "roles.secadmin", "audit.read", "access.manage"],
    BreakGlass: ["*"]
});

function normalizeRole(value) {
    const role = String(value || "").trim();
    if (!ASSIGNABLE_ROLES.includes(role)) {
        throw new Error("Unsupported role. Expected one of: " + ASSIGNABLE_ROLES.join(", ") + ".");
    }
    return role;
}

function permissionsFor(role, builtIn) {
    if (builtIn) return ROLE_PERMISSIONS.BreakGlass.slice();
    if (!role) return [];
    return (ROLE_PERMISSIONS[normalizeRole(role)] || []).slice();
}

function identityActive(identity) {
    if (!identity) return false;
    if (identity.builtIn === true) return identity.source === "local" && identity.role === "BreakGlass";
    return !identity.status || identity.status === "active";
}

function hasPermission(identity, permission) {
    if (!identityActive(identity)) return false;
    const permissions = permissionsFor(identity.role, identity.builtIn);
    return permissions.includes("*") || permissions.includes(permission);
}

function canAssignRole(actor, targetRole, currentRole) {
    const role = normalizeRole(targetRole);
    const current = currentRole ? normalizeRole(currentRole) : "";
    if (!identityActive(actor)) return false;
    if (actor.builtIn === true) return true;
    if (actor.role === "SecAdmin") {
        return role === "SecAdmin" && current !== "Admin";
    }
    if (actor.role !== "Admin") return false;
    if (role === "SecAdmin" || current === "SecAdmin") return false;
    return true;
}

module.exports = {
    ASSIGNABLE_ROLES,
    ROLE_PERMISSIONS,
    normalizeRole,
    permissionsFor,
    identityActive,
    hasPermission,
    canAssignRole
};
