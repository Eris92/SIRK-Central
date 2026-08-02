"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const passkey = fs.readFileSync("public/passkey-ui.js", "utf8");
const caddy = fs.readFileSync("deploy/dotnet10/Caddyfile", "utf8");

test("local login is present but hidden until a valid Access URL is verified", () => {
    assert.match(index, /id="breakGlassPanel" hidden/);
    assert.match(index, /id="loginForm"/);
    assert.match(app, /api\("\/api\/access"\)/);
    assert.match(app, /showLogin\(true\)/);
    assert.match(app, /if\(!accessKey\)return showLogin\(false\)/);
});

test("BreakGlass login always verifies username and password before MFA", () => {
    assert.match(passkey, /fetch\("\/api\/login"/);
    assert.match(passkey, /userName:/);
    assert.match(passkey, /password:/);
    assert.match(passkey, /response\.status === 202 && result\.mfaRequired/);
    assert.match(passkey, /transactionToken/);
    assert.match(passkey, /\/api\/login\/mfa\/passkey\/begin/);
    assert.match(passkey, /\/api\/login\/mfa\/passkey\/finish/);
    assert.match(passkey, /\/api\/login\/mfa\/recovery/);
    assert.doesNotMatch(passkey, /Zaloguj kluczem YubiKey \/ Passkey/);
});

test("public websites and Central use independent Caddy handlers", () => {
    assert.match(caddy, /root \* \/srv\/website/);
    assert.match(caddy, /root \* \/srv\/sir-k/);
    assert.match(caddy, /reverse_proxy central:8080/);
    assert.doesNotMatch(
        caddy,
        /\{\$SIRK_(?:WEBSITE|BUSINESS)_DOMAIN\}[\s\S]{0,200}redir https:\/\/\{\$SIRK_CENTRAL_DOMAIN\}/
    );
});
