"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    parseCookies,
    validToken,
    csrfRequired,
    csrfAccepted,
    securityHeaders
} = require("../src/server-v2");

function request(method, headers = {}, cookie = "") {
    return { method, headers: Object.assign({ cookie }, headers) };
}

test("CSRF validation requires matching cookie and header for mutating API calls", () => {
    const token = "a".repeat(43);
    const config = { publicOrigin: "https://central.sirkportal.com" };
    const req = request("POST", {
        origin: config.publicOrigin,
        "sec-fetch-site": "same-origin",
        "x-sirk-csrf": token
    }, "sirk_central_csrf=" + token);

    assert.equal(csrfRequired(req, new URL("https://local/api/organizations/tenants")), true);
    assert.equal(csrfAccepted(req, config, parseCookies(req)), true);

    req.headers["x-sirk-csrf"] = "b".repeat(43);
    assert.equal(csrfAccepted(req, config, parseCookies(req)), false);
});

test("login and safe methods are exempt while cross-site requests are rejected", () => {
    const token = "c".repeat(43);
    const config = { publicOrigin: "https://central.sirkportal.com" };
    const login = request("POST");
    assert.equal(csrfRequired(login, new URL("https://local/api/login")), false);
    assert.equal(csrfRequired(request("GET"), new URL("https://local/api/security/overview")), false);

    const crossSite = request("DELETE", {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "x-sirk-csrf": token
    }, "sirk_central_csrf=" + token);
    assert.equal(csrfAccepted(crossSite, config, parseCookies(crossSite)), false);
});

test("security headers deny framing and sensitive browser capabilities", () => {
    const headers = securityHeaders();
    assert.equal(headers["X-Frame-Options"], "DENY");
    assert.match(headers["Permissions-Policy"], /camera=\(\)/);
    assert.match(headers["Strict-Transport-Security"], /max-age=31536000/);
    assert.equal(validToken("x".repeat(32)), true);
    assert.equal(validToken("too-short"), false);
});
