"use strict";

(function () {
    function fromB64url(value) {
        const text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
        const padded = text + "=".repeat((4 - text.length % 4) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes.buffer;
    }

    function toB64url(value) {
        const bytes = new Uint8Array(value || new ArrayBuffer(0));
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }

    async function request(path, options) {
        const response = await fetch(path, Object.assign({
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Content-Type": "application/json" }
        }, options || {}));
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(result.error || "Request failed."), { status: response.status, data: result });
        return result;
    }

    function accessKey() {
        return new URLSearchParams(location.hash.replace(/^#/, "")).get("access") || "";
    }

    function language() { return document.documentElement.lang === "en" ? "en" : "pl"; }
    function message(pl, en) { return language() === "en" ? en : pl; }

    function registrationOptions(publicKey) {
        const copy = Object.assign({}, publicKey, {
            challenge: fromB64url(publicKey.challenge),
            user: Object.assign({}, publicKey.user, { id: fromB64url(publicKey.user.id) }),
            excludeCredentials: (publicKey.excludeCredentials || []).map(item => Object.assign({}, item, { id: fromB64url(item.id) }))
        });
        return copy;
    }

    function authenticationOptions(publicKey) {
        return Object.assign({}, publicKey, {
            challenge: fromB64url(publicKey.challenge),
            allowCredentials: (publicKey.allowCredentials || []).map(item => Object.assign({}, item, { id: fromB64url(item.id) }))
        });
    }

    function registrationPayload(credential) {
        const response = credential.response;
        if (typeof response.getPublicKey !== "function" || typeof response.getAuthenticatorData !== "function" || typeof response.getPublicKeyAlgorithm !== "function") {
            throw new Error(message("Ta przeglądarka nie udostępnia wymaganych metod WebAuthn.", "This browser does not expose the required WebAuthn methods."));
        }
        const publicKey = response.getPublicKey();
        const authenticatorData = response.getAuthenticatorData();
        if (!publicKey || !authenticatorData) throw new Error(message("Nie udało się odczytać klucza publicznego.", "The public key could not be read."));
        return {
            credentialId: toB64url(credential.rawId),
            rawId: toB64url(credential.rawId),
            clientDataJSON: toB64url(response.clientDataJSON),
            authenticatorData: toB64url(authenticatorData),
            publicKey: toB64url(publicKey),
            publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
            transports: typeof response.getTransports === "function" ? response.getTransports() : []
        };
    }

    function authenticationPayload(credential) {
        const response = credential.response;
        return {
            credentialId: toB64url(credential.rawId),
            rawId: toB64url(credential.rawId),
            clientDataJSON: toB64url(response.clientDataJSON),
            authenticatorData: toB64url(response.authenticatorData),
            signature: toB64url(response.signature),
            userHandle: response.userHandle ? toB64url(response.userHandle) : ""
        };
    }

    function initializeLogin() {
        const loginForm = document.getElementById("loginForm");
        const recoveryForm = document.getElementById("mfaRecoveryForm");
        const recoveryCode = document.getElementById("mfaRecoveryCode");
        const recoveryError = document.getElementById("mfaRecoveryError");
        const cancelButton = document.getElementById("cancelMfaButton");
        if (!loginForm || !recoveryForm || !recoveryCode || !cancelButton) return;
        let transactionToken = "";
        let expiresTimer = null;
        let methods = [];

        const passkeyButton = document.createElement("button");
        passkeyButton.type = "button";
        passkeyButton.textContent = message("Użyj klucza bezpieczeństwa", "Use security key");
        passkeyButton.hidden = true;
        recoveryForm.insertBefore(passkeyButton, recoveryForm.querySelector(".mfa-actions"));

        function clearTransaction() {
            transactionToken = "";
            methods = [];
            recoveryCode.value = "";
            recoveryError.textContent = "";
            recoveryForm.hidden = true;
            loginForm.hidden = false;
            passkeyButton.hidden = true;
            if (expiresTimer) clearTimeout(expiresTimer);
            expiresTimer = null;
        }

        function showMfa(result) {
            transactionToken = String(result.transactionToken || "");
            methods = Array.isArray(result.methods) ? result.methods : [];
            if (!transactionToken) throw new Error("Missing MFA transaction token.");
            loginForm.hidden = true;
            recoveryForm.hidden = false;
            passkeyButton.hidden = !methods.includes("passkey") || !window.PublicKeyCredential;
            const recoveryLabel = recoveryForm.querySelector("label");
            if (recoveryLabel) recoveryLabel.hidden = !methods.includes("recovery-code");
            const submit = recoveryForm.querySelector('button[type="submit"]');
            if (submit) submit.hidden = !methods.includes("recovery-code");
            recoveryError.textContent = "";
            const expiresAt = Date.parse(result.expiresAtUtc || "");
            expiresTimer = setTimeout(function () {
                clearTransaction();
                const target = document.getElementById("loginError");
                if (target) target.textContent = message("Żądanie MFA wygasło. Zaloguj się ponownie.", "The MFA request expired. Sign in again.");
            }, Number.isFinite(expiresAt) ? Math.max(1000, expiresAt - Date.now()) : 300000);
        }

        async function usePasskey() {
            recoveryError.textContent = "";
            passkeyButton.disabled = true;
            try {
                const begin = await request("/api/login/mfa/passkey/begin", { method: "POST", body: JSON.stringify({ transactionToken }) });
                const credential = await navigator.credentials.get({ publicKey: authenticationOptions(begin.publicKey) });
                if (!credential) throw new Error(message("Nie wybrano klucza bezpieczeństwa.", "No security key was selected."));
                await request("/api/login/mfa/passkey/finish", { method: "POST", body: JSON.stringify({ transactionToken, challengeId: begin.challengeId, credential: authenticationPayload(credential) }) });
                transactionToken = "";
                location.reload();
            } catch (error) {
                recoveryError.textContent = error.name === "NotAllowedError" ? message("Operacja klucza została anulowana lub przekroczono czas.", "The security-key operation was cancelled or timed out.") : error.message;
                if (!methods.includes("recovery-code") && (error.status === 401 || error.status === 410)) clearTransaction();
            } finally {
                passkeyButton.disabled = false;
            }
        }

        loginForm.addEventListener("submit", async function (event) {
            event.preventDefault();
            event.stopImmediatePropagation();
            const errorTarget = document.getElementById("loginError");
            if (errorTarget) errorTarget.textContent = "";
            try {
                const response = await fetch("/api/login", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessKey() },
                    body: JSON.stringify({ username: document.getElementById("username").value, password: document.getElementById("password").value })
                });
                const result = await response.json();
                document.getElementById("password").value = "";
                if (response.status === 202 && result.mfaRequired) {
                    showMfa(result);
                    if (result.preferredMethod === "passkey" && window.PublicKeyCredential) await usePasskey();
                    else recoveryCode.focus();
                    return;
                }
                if (!response.ok) throw new Error(result.error || message("Logowanie nie powiodło się.", "Sign-in failed."));
                location.reload();
            } catch (error) {
                if (errorTarget) errorTarget.textContent = error.message;
            }
        }, true);

        recoveryForm.addEventListener("submit", async function (event) {
            event.preventDefault();
            event.stopImmediatePropagation();
            recoveryError.textContent = "";
            if (!transactionToken) return clearTransaction();
            try {
                await request("/api/login/mfa/recovery", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessKey() }, body: JSON.stringify({ transactionToken, recoveryCode: recoveryCode.value }) });
                transactionToken = "";
                location.reload();
            } catch (error) {
                recoveryCode.value = "";
                recoveryCode.focus();
                recoveryError.textContent = error.message;
                if (error.status === 401 || error.status === 410) clearTransaction();
            }
        }, true);

        passkeyButton.addEventListener("click", usePasskey);
        cancelButton.addEventListener("click", function (event) { event.stopImmediatePropagation(); clearTransaction(); }, true);
        addEventListener("pagehide", function () { transactionToken = ""; });
    }

    function initializeManagement() {
        const view = document.getElementById("breakGlassView");
        if (!view) return;
        const article = document.createElement("article");
        article.className = "settings-card danger-card";
        article.innerHTML = '<h2>YubiKey / WebAuthn</h2><p class="muted" data-passkey-status></p><div class="users-list" data-passkey-list></div><div class="form-actions"><button type="button" data-passkey-register></button><button type="button" class="secondary" data-passkey-refresh></button></div><p class="error" role="status" data-passkey-message></p>';
        const grid = view.querySelector(".settings-grid") || view;
        grid.append(article);
        const status = article.querySelector("[data-passkey-status]");
        const list = article.querySelector("[data-passkey-list]");
        const register = article.querySelector("[data-passkey-register]");
        const refresh = article.querySelector("[data-passkey-refresh]");
        const output = article.querySelector("[data-passkey-message]");

        function applyLabels() {
            register.textContent = message("Zarejestruj YubiKey", "Register YubiKey");
            refresh.textContent = message("Odśwież", "Refresh");
        }

        async function load() {
            output.textContent = "";
            try {
                const result = await request("/api/break-glass/passkeys");
                const active = (result.passkeys || []).filter(item => item.status === "active");
                status.textContent = active.length ? message("Aktywne klucze: ", "Active keys: ") + active.length : message("Brak zarejestrowanego klucza.", "No security key is registered.");
                list.replaceChildren(...(result.passkeys || []).map(item => {
                    const row = document.createElement("div");
                    row.className = "user-row";
                    const info = document.createElement("div");
                    info.innerHTML = "<strong></strong><small></small>";
                    info.querySelector("strong").textContent = item.displayName || "Passkey";
                    info.querySelector("small").textContent = item.status + " · " + (item.transports || []).join(", ") + " · " + new Date(item.createdAtUtc).toLocaleString(language());
                    const remove = document.createElement("button");
                    remove.type = "button";
                    remove.className = "danger";
                    remove.textContent = message("Usuń", "Remove");
                    remove.disabled = item.status !== "active";
                    remove.addEventListener("click", async function () {
                        if (!confirm(message("Unieważnić ten klucz bezpieczeństwa?", "Revoke this security key?"))) return;
                        await request("/api/break-glass/passkeys/" + encodeURIComponent(item.credentialId), { method: "DELETE" });
                        await load();
                    });
                    row.append(info, remove);
                    return row;
                }));
            } catch (error) {
                status.textContent = error.message;
            }
        }

        register.addEventListener("click", async function () {
            output.textContent = "";
            register.disabled = true;
            try {
                if (!window.PublicKeyCredential || !navigator.credentials) throw new Error(message("Ta przeglądarka nie obsługuje WebAuthn.", "This browser does not support WebAuthn."));
                const displayName = prompt(message("Nazwa klucza:", "Security-key name:"), "YubiKey") || "YubiKey";
                const begin = await request("/api/break-glass/passkeys/begin-registration", { method: "POST", body: "{}" });
                const credential = await navigator.credentials.create({ publicKey: registrationOptions(begin.publicKey) });
                if (!credential) throw new Error(message("Nie utworzono klucza.", "No credential was created."));
                await request("/api/break-glass/passkeys/finish-registration", { method: "POST", body: JSON.stringify({ challengeId: begin.challengeId, displayName, credential: registrationPayload(credential) }) });
                output.textContent = message("Klucz został zarejestrowany.", "The security key was registered.");
                await load();
            } catch (error) {
                output.textContent = error.name === "NotAllowedError" ? message("Rejestracja została anulowana lub przekroczono czas.", "Registration was cancelled or timed out.") : error.message;
            } finally {
                register.disabled = false;
            }
        });

        refresh.addEventListener("click", load);
        new MutationObserver(applyLabels).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
        applyLabels();
        load();
    }

    function initialize() {
        initializeLogin();
        initializeManagement();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
