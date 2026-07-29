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
    Admin: ["portals.read", "portals.connect", "portals.manage", "settings.read", "settings.manage", "users.manage"],
    SecAdmin: ["portals.read", "portals.connect", "settings.read", "security.manage", "users.manage", "roles.secadmin", "audit.read"],
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

function hasPermission(identity, permission) {
    if (!identity) return false;
    const permissions = permissionsFor(identity.role, identity.builtIn);
    return permissions.includes("*") || permissions.includes(permission);
}

function canAssignRole(actor, targetRole, currentRole) {
    const role = normalizeRole(targetRole);
    if (!actor) return false;
    if (actor.builtIn || actor.role === "SecAdmin") return true;
    if (actor.role !== "Admin") return false;
    if (role === "SecAdmin" || currentRole === "SecAdmin") return false;
    return true;
}

module.exports = {
    ASSIGNABLE_ROLES,
    ROLE_PERMISSIONS,
    normalizeRole,
    permissionsFor,
    hasPermission,
    canAssignRole
};
