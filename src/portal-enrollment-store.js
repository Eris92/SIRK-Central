"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { hashSecret, verifySecret, randomToken } = require("./security");

function nowIso() {
    return new Date().toISOString();
}

function futureIso(milliseconds) {
    return new Date(Date.now() + milliseconds).toISOString();
}

function safeId(value, label) {
    const id = String(value || "").trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw new Error(label + " is invalid.");
    return id;
}

function safePortalId(value) {
    const id = String(value || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(id)) {
        throw new Error("Portal ID must use 3-63 lowercase letters, digits or hyphens.");
    }
    return id;
}

function validatePublicKey(value) {
    const publicKeyPem = String(value || "").trim();
    if (publicKeyPem.length < 400 || publicKeyPem.length > 8192) throw new Error("Portal public key is invalid.");
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "rsa") throw new Error("Portal public key must use RSA.");
    const details = key.asymmetricKeyDetails || {};
    if (Number(details.modulusLength || 0) < 3072) throw new Error("Portal RSA key must contain at least 3072 bits.");
    return key.export({ type: "spki", format: "pem" }).toString();
}

function create(options) {
    const dataDir = path.resolve(options.dataDir);
    const storePath = path.join(dataDir, "portal-enrollment.json");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    function empty() {
        return { schema: 1, tokens: [], requests: [] };
    }

    function read() {
        if (!fs.existsSync(storePath)) return empty();
        const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
        if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.tokens) || !Array.isArray(parsed.requests)) {
            throw new Error("Portal enrollment registry has an unsupported format.");
        }
        return parsed;
    }

    function write(value) {
        const temporary = storePath + ".tmp-" + process.pid + "-" + Date.now();
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(temporary, storePath);
    }

    function prune(registry) {
        const now = Date.now();
        registry.tokens = registry.tokens.filter(item => !item.consumedAtUtc && Date.parse(item.expiresAtUtc) > now);
        registry.requests = registry.requests.filter(item => {
            if (item.status === "claimed" || item.status === "rejected") return Date.parse(item.updatedAtUtc) + 86400000 > now;
            return Date.parse(item.expiresAtUtc) > now;
        });
        return registry;
    }

    function issueToken(input = {}) {
        const registry = prune(read());
        const token = randomToken(32);
        const record = {
            id: randomToken(18),
            tokenHash: hashSecret(token),
            label: String(input.label || "Portal enrollment").trim().slice(0, 100),
            createdAtUtc: nowIso(),
            expiresAtUtc: futureIso(Math.max(5, Math.min(1440, Number(input.ttlMinutes || 30))) * 60000),
            consumedAtUtc: null
        };
        registry.tokens.push(record);
        write(registry);
        return { id: record.id, token, label: record.label, createdAtUtc: record.createdAtUtc, expiresAtUtc: record.expiresAtUtc };
    }

    function createRequest(input, enrollmentToken) {
        const registry = prune(read());
        const tokenRecord = registry.tokens.find(item => verifySecret(String(enrollmentToken || ""), item.tokenHash));
        if (!tokenRecord) throw Object.assign(new Error("Enrollment token is invalid or expired."), { statusCode: 401, code: "ENROLLMENT_TOKEN_REJECTED" });

        const portalId = safePortalId(input.portalId);
        if (registry.requests.some(item => item.portalId === portalId && item.status === "pending")) {
            throw Object.assign(new Error("A pending enrollment request already exists for this Portal ID."), { statusCode: 409, code: "ENROLLMENT_ALREADY_PENDING" });
        }

        const portalName = String(input.portalName || "").trim();
        if (portalName.length < 2 || portalName.length > 100) throw new Error("Portal name must contain 2-100 characters.");

        const requestId = randomToken(18);
        const pollToken = randomToken(32);
        const now = nowIso();
        tokenRecord.consumedAtUtc = now;
        const record = {
            id: requestId,
            portalId,
            portalName,
            publicUrl: String(input.publicUrl || "").trim().slice(0, 512),
            version: String(input.version || "").trim().slice(0, 64),
            platform: String(input.platform || "").trim().slice(0, 64),
            publicKeyPem: validatePublicKey(input.publicKeyPem),
            pollTokenHash: hashSecret(pollToken),
            status: "pending",
            encryptedBootstrap: null,
            createdAtUtc: now,
            updatedAtUtc: now,
            expiresAtUtc: futureIso(24 * 60 * 60000),
            approvedAtUtc: null,
            rejectedAtUtc: null,
            claimedAtUtc: null
        };
        registry.requests.push(record);
        write(registry);
        return { requestId, pollToken, status: record.status, expiresAtUtc: record.expiresAtUtc };
    }

    function listRequests() {
        const registry = prune(read());
        write(registry);
        return registry.requests.map(item => ({
            id: item.id,
            portalId: item.portalId,
            portalName: item.portalName,
            publicUrl: item.publicUrl,
            version: item.version,
            platform: item.platform,
            status: item.status,
            createdAtUtc: item.createdAtUtc,
            updatedAtUtc: item.updatedAtUtc,
            expiresAtUtc: item.expiresAtUtc,
            approvedAtUtc: item.approvedAtUtc,
            rejectedAtUtc: item.rejectedAtUtc,
            claimedAtUtc: item.claimedAtUtc
        }));
    }

    function getRequest(id) {
        const requestId = safeId(id, "Enrollment request ID");
        return read().requests.find(item => item.id === requestId) || null;
    }

    function approve(id, encryptedBootstrap) {
        const requestId = safeId(id, "Enrollment request ID");
        const registry = prune(read());
        const request = registry.requests.find(item => item.id === requestId);
        if (!request) throw Object.assign(new Error("Enrollment request was not found."), { statusCode: 404 });
        if (request.status !== "pending") throw Object.assign(new Error("Enrollment request is not pending."), { statusCode: 409 });
        request.status = "approved";
        request.encryptedBootstrap = String(encryptedBootstrap || "");
        request.approvedAtUtc = nowIso();
        request.updatedAtUtc = request.approvedAtUtc;
        write(registry);
        return request;
    }

    function reject(id) {
        const requestId = safeId(id, "Enrollment request ID");
        const registry = prune(read());
        const request = registry.requests.find(item => item.id === requestId);
        if (!request) throw Object.assign(new Error("Enrollment request was not found."), { statusCode: 404 });
        if (request.status !== "pending") throw Object.assign(new Error("Enrollment request is not pending."), { statusCode: 409 });
        request.status = "rejected";
        request.rejectedAtUtc = nowIso();
        request.updatedAtUtc = request.rejectedAtUtc;
        write(registry);
        return request;
    }

    function poll(id, pollToken) {
        const requestId = safeId(id, "Enrollment request ID");
        const registry = prune(read());
        const request = registry.requests.find(item => item.id === requestId);
        if (!request || !verifySecret(String(pollToken || ""), request.pollTokenHash)) {
            throw Object.assign(new Error("Enrollment request authentication failed."), { statusCode: 401, code: "ENROLLMENT_POLL_REJECTED" });
        }

        if (request.status !== "approved") {
            write(registry);
            return { status: request.status, updatedAtUtc: request.updatedAtUtc, expiresAtUtc: request.expiresAtUtc };
        }

        const payload = request.encryptedBootstrap;
        request.status = "claimed";
        request.claimedAtUtc = nowIso();
        request.updatedAtUtc = request.claimedAtUtc;
        request.encryptedBootstrap = null;
        write(registry);
        return { status: "approved", encryptedBootstrap: payload, claimedAtUtc: request.claimedAtUtc };
    }

    return { issueToken, createRequest, listRequests, getRequest, approve, reject, poll };
}

module.exports = { create, validatePublicKey, safePortalId };
