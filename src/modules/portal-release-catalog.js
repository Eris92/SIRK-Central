"use strict";

const https = require("node:https");
const { json, parseCookies } = require("../http/transport");
const { identityActive } = require("../rbac");
const { VERSION } = require("../version");

const API_HOST = "api.github.com";
const REPOSITORY_PATH = "/repos/Eris92/SIRK-Portal/releases";
const CACHE_MS = 300000;
const TRUSTED_HOSTS = new Set(["api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);

function requestJson(hostname, requestPath, redirectsLeft = 3) {
    hostname = String(hostname || "").toLowerCase();
    if (!TRUSTED_HOSTS.has(hostname)) return Promise.reject(new Error("GitHub response host is not trusted."));
    return new Promise((resolve, reject) => {
        const request = https.request({
            hostname,
            path: requestPath,
            method: "GET",
            timeout: 10000,
            headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": "SIRK-Central/" + VERSION,
                "X-GitHub-Api-Version": "2022-11-28"
            }
        }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if (redirectsLeft <= 0) return reject(new Error("GitHub release redirect limit exceeded."));
                let redirected;
                try { redirected = new URL(response.headers.location, "https://" + hostname + requestPath); }
                catch (_) { return reject(new Error("GitHub release redirect is invalid.")); }
                if (redirected.protocol !== "https:" || !TRUSTED_HOSTS.has(redirected.hostname.toLowerCase())) return reject(new Error("GitHub release redirect host is not trusted."));
                requestJson(redirected.hostname, redirected.pathname + redirected.search, redirectsLeft - 1).then(resolve, reject);
                return;
            }
            const chunks = [];
            let size = 0;
            response.on("data", chunk => {
                size += chunk.length;
                if (size > 2 * 1024 * 1024) return request.destroy(new Error("Release response is too large."));
                chunks.push(chunk);
            });
            response.on("end", () => {
                if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error("GitHub release request failed with HTTP " + response.statusCode + "."));
                try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")); }
                catch (_) { reject(new Error("GitHub release response is invalid JSON.")); }
            });
        });
        request.on("timeout", () => request.destroy(new Error("GitHub release request timed out.")));
        request.on("error", reject);
        request.end();
    });
}

function requestMetadata(urlText) {
    const parsed = new URL(urlText);
    if (parsed.protocol !== "https:" || !TRUSTED_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error("Release metadata URL is not trusted.");
    return requestJson(parsed.hostname, parsed.pathname + parsed.search);
}

function validateMetadata(value) {
    if (!value || value.schemaVersion !== 1 || value.applicationId !== "sirk-portal") throw new Error("Portal release metadata schema is invalid.");
    const version = String(value.version || "");
    const packageUrl = String(value.packageUrl || "");
    const sha256 = String(value.sha256 || "").toUpperCase();
    const channel = String(value.channel || "");
    if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/.test(version)) throw new Error("Portal release version is invalid.");
    if (!/^[A-F0-9]{64}$/.test(sha256)) throw new Error("Portal release SHA-256 is invalid.");
    const parsed = new URL(packageUrl);
    if (parsed.protocol !== "https:" || !TRUSTED_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error("Portal package URL is not trusted.");
    if (!/SIRK-Portal-[^/]+-win-x64\.zip$/i.test(parsed.pathname)) throw new Error("Portal package asset name is invalid.");
    return {
        schemaVersion: 1,
        applicationId: "sirk-portal",
        version,
        channel: channel === "stable" ? "stable" : "dev",
        packageUrl: parsed.toString(),
        sha256,
        architecture: "win-x64",
        publishedAtUtc: value.publishedAtUtc || null,
        commit: String(value.commit || "").slice(0, 80)
    };
}

function registerPortalReleaseCatalog(app) {
    const cache = new Map();
    async function latest(channel) {
        const cached = cache.get(channel);
        if (cached && cached.expiresAt > Date.now()) return cached.value;
        const releases = await requestJson(API_HOST, REPOSITORY_PATH + "?per_page=30");
        if (!Array.isArray(releases)) throw new Error("GitHub releases response is invalid.");
        const release = releases.find(item => item && item.draft !== true && (channel === "stable" ? item.prerelease !== true : true) && Array.isArray(item.assets) && item.assets.some(asset => /SIRK-Portal-.+-release\.json$/i.test(asset.name || "")));
        if (!release) throw Object.assign(new Error("No matching SIRK Portal release was found."), { statusCode: 404 });
        const asset = release.assets.find(item => /SIRK-Portal-.+-release\.json$/i.test(item.name || ""));
        const metadata = validateMetadata(await requestMetadata(asset.browser_download_url));
        if (channel === "stable" && metadata.channel !== "stable") throw new Error("Stable release metadata has a non-stable channel.");
        cache.set(channel, { value: metadata, expiresAt: Date.now() + CACHE_MS });
        return metadata;
    }

    const handler = async (req, res) => {
        const url = new URL(req.url, "http://central.local");
        if (req.method !== "GET" || url.pathname !== "/api/portal-releases/latest") return false;
        const sessionToken = parseCookies(req).sirk_central_session || "";
        const actor = sessionToken && app.sessions ? app.sessions.get(sessionToken, true) : null;
        if (!identityActive(actor)) return json(res, 401, { ok: false, error: "Authentication required." }), true;
        try {
            const channel = url.searchParams.get("channel") === "stable" ? "stable" : "dev";
            return json(res, 200, { ok: true, release: await latest(channel), generatedAtUtc: new Date().toISOString() }), true;
        } catch (error) {
            return json(res, error.statusCode || 502, { ok: false, code: "PORTAL_RELEASE_LOOKUP_FAILED", error: error.message }), true;
        }
    };
    app.router.prepend(handler);
    app.portalReleaseCatalog = { latest };
    return app;
}

module.exports = { registerPortalReleaseCatalog, validateMetadata, VERSION, TRUSTED_HOSTS };
