"use strict";

const http = require("node:http");
const path = require("node:path");
const organizationStoreFactory = require("./organization-store");
const approvalStoreFactory = require("./approval-store");
const portalAssignmentStoreFactory = require("./portal-assignment-store");
const organizationApiFactory = require("./organization-api");
const approvalApiFactory = require("./approval-api");
const portalAssignmentApiFactory = require("./portal-assignment-api");

const originalCreateServer = http.createServer.bind(http);
const dataDir = path.resolve(process.env.SIRK_DATA_DIR || path.join(process.cwd(), "data"));
const publicOrigin = String(process.env.SIRK_PUBLIC_ORIGIN || "").replace(/\/+$/, "");
const organizationStore = organizationStoreFactory.create({ dataDir });
const approvalStore = approvalStoreFactory.create({ dataDir });
const portalAssignmentStore = portalAssignmentStoreFactory.create({ dataDir });

function cloneRequest(req, url, method) {
    const clone = Object.create(req);
    Object.defineProperty(clone, "url", { value: url, writable: true, configurable: true });
    Object.defineProperty(clone, "method", { value: method || req.method, writable: true, configurable: true });
    return clone;
}

async function capture(handler, req) {
    let statusCode = 200;
    const chunks = [];
    let resolveFinished;
    const finished = new Promise(resolve => { resolveFinished = resolve; });
    const response = {
        statusCode: 200,
        headersSent: false,
        writableEnded: false,
        setHeader() {},
        getHeader() { return undefined; },
        removeHeader() {},
        writeHead(status) { statusCode = Number(status) || 200; this.statusCode = statusCode; this.headersSent = true; return this; },
        write(chunk) { if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
        end(chunk) { if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.writableEnded = true; resolveFinished(); },
        on() { return this; },
        once() { return this; },
        emit() { return false; }
    };
    await Promise.resolve(handler(req, response));
    if (!response.writableEnded) await finished;
    return { statusCode, body: Buffer.concat(chunks) };
}

function parseCookies(req) {
    const result = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return result;
}

function csrfValid(req) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
    const cookies = parseCookies(req);
    const cookie = String(cookies.sirk_central_csrf || "");
    const header = String(req.headers["x-sirk-csrf"] || "");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(cookie) || cookie !== header) return false;
    const origin = String(req.headers.origin || "");
    if (origin && publicOrigin && origin !== publicOrigin) return false;
    const site = String(req.headers["sec-fetch-site"] || "");
    return !site || site === "same-origin" || site === "none";
}

function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    res.end(data);
}

http.createServer = function patchedCreateServer(options, requestListener) {
    let listener = requestListener;
    let serverOptions = options;
    if (typeof options === "function") {
        listener = options;
        serverOptions = undefined;
    }
    if (typeof listener !== "function") return originalCreateServer(options, requestListener);

    const readIdentity = async req => {
        const result = await capture(listener, cloneRequest(req, "/api/session", "GET"));
        if (result.statusCode !== 200) return null;
        try { return JSON.parse(result.body.toString("utf8")); }
        catch (_) { return null; }
    };

    const readPortals = async req => {
        const result = await capture(listener, cloneRequest(req, "/api/portals", "GET"));
        if (result.statusCode !== 200) return [];
        try {
            const payload = JSON.parse(result.body.toString("utf8"));
            return Array.isArray(payload.portals) ? payload.portals : [];
        } catch (_) { return []; }
    };

    const organizationApi = organizationApiFactory.create({ store: organizationStore, readIdentity });
    const approvalApi = approvalApiFactory.create({ store: approvalStore, readIdentity });
    const portalAssignmentApi = portalAssignmentApiFactory.create({
        store: portalAssignmentStore,
        organizations: organizationStore,
        readIdentity,
        readPortals
    });

    const wrapped = async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const managed = url.pathname.startsWith("/api/organizations") ||
                url.pathname.startsWith("/api/approvals") ||
                url.pathname.startsWith("/api/portal-assignments");
            if (managed) {
                if (!csrfValid(req)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                if (await organizationApi(req, res, url)) return;
                if (await approvalApi(req, res, url)) return;
                if (await portalAssignmentApi(req, res, url)) return;
            }
            return listener(req, res);
        } catch (error) {
            if (!res.headersSent) return json(res, error.statusCode || 500, { ok: false, error: error.message || "Runtime API integration failed." });
            res.destroy(error);
        }
    };

    return serverOptions === undefined ? originalCreateServer(wrapped) : originalCreateServer(serverOptions, wrapped);
};
