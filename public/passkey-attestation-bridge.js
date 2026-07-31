"use strict";

(function () {
    if (!navigator.credentials || typeof navigator.credentials.create !== "function") return;
    let pendingAttestation = "";

    function toB64url(value) {
        const bytes = new Uint8Array(value || new ArrayBuffer(0));
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }

    const originalCreate = navigator.credentials.create.bind(navigator.credentials);
    navigator.credentials.create = async function (options) {
        pendingAttestation = "";
        const credential = await originalCreate(options);
        if (credential && credential.response && credential.response.attestationObject) {
            pendingAttestation = toB64url(credential.response.attestationObject);
        }
        return credential;
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        const url = new URL(typeof input === "string" ? input : input.url, location.href);
        if (url.origin === location.origin && url.pathname === "/api/break-glass/passkeys/finish-registration" && init && init.body && pendingAttestation) {
            try {
                const body = JSON.parse(String(init.body));
                body.credential = Object.assign({}, body.credential || {}, { attestationObject: pendingAttestation });
                init = Object.assign({}, init, { body: JSON.stringify(body) });
            } finally {
                pendingAttestation = "";
            }
        }
        return originalFetch(input, init);
    };

    addEventListener("pagehide", function () { pendingAttestation = ""; });
}());
