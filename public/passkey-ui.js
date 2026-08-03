"use strict";

(function () {
    function fromBase64Url(value) {
        const text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
        const padded = text + "=".repeat((4 - text.length % 4) % 4);
        const binary = atob(padded);
        return Uint8Array.from(binary, character => character.charCodeAt(0));
    }

    function toBase64Url(value) {
        const bytes = value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value || []);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary)
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
    }

    function language() {
        return document.documentElement.lang === "en" ? "en" : "pl";
    }

    function message(polish, english) {
        return language() === "en" ? english : polish;
    }

    function accessCode() {
        return new URLSearchParams(location.hash.replace(/^#/, "")).get("access") || "";
    }

    function clearAccessAndReload() {
        history.replaceState(null, "", location.pathname + location.search);
        location.reload();
    }

    async function request(path, options) {
        const supplied = options || {};
        const headers = new Headers(supplied.headers || {});
        if (!headers.has("Content-Type") && supplied.body !== undefined)
            headers.set("Content-Type", "application/json");
        const response = await fetch(path, Object.assign({}, supplied, {
            credentials: "same-origin",
            cache: "no-store",
            headers
        }));
        const result = await response.json().catch(() => ({}));
        if (!response.ok)
            throw Object.assign(
                new Error(result.error || result.code || `HTTP ${response.status}`),
                { status: response.status, data: result });
        return result;
    }

    async function csrfHeaders() {
        const token = await request("/api/v1/auth/csrf");
        return { [token.headerName || "X-SIRK-CSRF"]: token.requestToken };
    }

    function creationOptions(options) {
        const value = structuredClone(options);
        value.challenge = fromBase64Url(value.challenge);
        value.user.id = fromBase64Url(value.user.id);
        value.excludeCredentials = (value.excludeCredentials || []).map(item =>
            Object.assign({}, item, { id: fromBase64Url(item.id) }));
        return value;
    }

    function assertionOptions(options) {
        const value = structuredClone(options);
        value.challenge = fromBase64Url(value.challenge);
        value.allowCredentials = (value.allowCredentials || []).map(item =>
            Object.assign({}, item, { id: fromBase64Url(item.id) }));
        return value;
    }

    function attestationResponse(credential) {
        return {
            id: credential.id,
            rawId: toBase64Url(credential.rawId),
            type: credential.type,
            response: {
                attestationObject: toBase64Url(credential.response.attestationObject),
                clientDataJSON: toBase64Url(credential.response.clientDataJSON),
                transports: typeof credential.response.getTransports === "function"
                    ? credential.response.getTransports()
                    : []
            },
            clientExtensionResults: credential.getClientExtensionResults()
        };
    }

    function assertionResponse(credential) {
        return {
            id: credential.id,
            rawId: toBase64Url(credential.rawId),
            type: credential.type,
            response: {
                authenticatorData: toBase64Url(credential.response.authenticatorData),
                clientDataJSON: toBase64Url(credential.response.clientDataJSON),
                signature: toBase64Url(credential.response.signature),
                userHandle: credential.response.userHandle
                    ? toBase64Url(credential.response.userHandle)
                    : null
            },
            clientExtensionResults: credential.getClientExtensionResults()
        };
    }

    function initializeLogin() {
        const loginForm = document.getElementById("loginForm");
        const recoveryForm = document.getElementById("mfaRecoveryForm");
        const recoveryCode = document.getElementById("mfaRecoveryCode");
        const recoveryError = document.getElementById("mfaRecoveryError");
        const cancelButton = document.getElementById("cancelMfaButton");
        if (!loginForm || !recoveryForm || !recoveryCode || !recoveryError || !cancelButton)
            return;

        let transactionToken = "";
        let expiresTimer = null;
        let methods = [];

        const originalPrompt = recoveryForm.querySelector("p");
        const recoveryLabel = recoveryForm.querySelector("label");
        const submit = recoveryForm.querySelector('button[type="submit"]');
        const actions = recoveryForm.querySelector(".mfa-actions");

        const methodHeading = document.createElement("h2");
        methodHeading.hidden = true;
        const methodDescription = document.createElement("p");
        methodDescription.className = "muted";
        methodDescription.hidden = true;
        const methodActions = document.createElement("div");
        methodActions.className = "form-actions mfa-method-actions";
        methodActions.hidden = true;

        const passkeyButton = document.createElement("button");
        passkeyButton.type = "button";
        const recoveryChoiceButton = document.createElement("button");
        recoveryChoiceButton.type = "button";
        recoveryChoiceButton.className = "secondary";
        const backToMethodsButton = document.createElement("button");
        backToMethodsButton.type = "button";
        backToMethodsButton.className = "secondary";
        backToMethodsButton.hidden = true;

        methodActions.append(passkeyButton, recoveryChoiceButton);
        recoveryForm.insertBefore(methodHeading, recoveryForm.firstChild);
        recoveryForm.insertBefore(methodDescription, methodHeading.nextSibling);
        recoveryForm.insertBefore(methodActions, methodDescription.nextSibling);
        if (actions) actions.insertBefore(backToMethodsButton, cancelButton);

        function applyLabels() {
            methodHeading.textContent = message(
                "Potwierdź logowanie",
                "Confirm sign-in");
            methodDescription.textContent = message(
                "Hasło zostało zweryfikowane. Użyj Windows Hello, YubiKey lub jednorazowego kodu odzyskiwania.",
                "Your password was verified. Use Windows Hello, a YubiKey, or a one-time recovery code.");
            passkeyButton.textContent = message(
                "Windows Hello / YubiKey / passkey",
                "Windows Hello / YubiKey / passkey");
            recoveryChoiceButton.textContent = message(
                "Użyj kodu odzyskiwania",
                "Use recovery code");
            backToMethodsButton.textContent = message(
                "Wróć do wyboru metody",
                "Back to method selection");
        }

        function supportsPasskey() {
            return methods.includes("passkey") &&
                Boolean(window.PublicKeyCredential && navigator.credentials);
        }

        function supportsRecoveryCode() {
            return methods.includes("recovery-code");
        }

        function showMethodChoice() {
            methodHeading.hidden = false;
            methodDescription.hidden = false;
            methodActions.hidden = false;
            passkeyButton.hidden = !supportsPasskey();
            recoveryChoiceButton.hidden = !supportsRecoveryCode();
            if (originalPrompt) originalPrompt.hidden = true;
            if (recoveryLabel) recoveryLabel.hidden = true;
            if (submit) submit.hidden = true;
            backToMethodsButton.hidden = true;
            recoveryCode.value = "";
            recoveryError.textContent = "";
        }

        function showRecoveryCode() {
            methodHeading.hidden = true;
            methodDescription.hidden = true;
            methodActions.hidden = true;
            if (originalPrompt) {
                originalPrompt.textContent = message(
                    "Podaj jednorazowy kod odzyskiwania Break-Glass.",
                    "Enter a one-time Break-Glass recovery code.");
                originalPrompt.hidden = false;
            }
            if (recoveryLabel) recoveryLabel.hidden = false;
            if (submit) submit.hidden = false;
            backToMethodsButton.hidden = !(supportsPasskey() && supportsRecoveryCode());
            recoveryCode.focus();
        }

        function clearTransaction() {
            transactionToken = "";
            methods = [];
            recoveryCode.value = "";
            recoveryError.textContent = "";
            recoveryForm.hidden = true;
            loginForm.hidden = false;
            methodHeading.hidden = true;
            methodDescription.hidden = true;
            methodActions.hidden = true;
            backToMethodsButton.hidden = true;
            if (originalPrompt) originalPrompt.hidden = false;
            if (recoveryLabel) recoveryLabel.hidden = false;
            if (submit) submit.hidden = false;
            if (expiresTimer) clearTimeout(expiresTimer);
            expiresTimer = null;
        }

        function showMfa(result) {
            transactionToken = String(result.transactionToken || "");
            methods = Array.isArray(result.methods) ? result.methods : [];
            if (!transactionToken)
                throw new Error(message(
                    "Brak transakcji MFA.",
                    "The MFA transaction is missing."));
            loginForm.hidden = true;
            recoveryForm.hidden = false;
            recoveryError.textContent = "";
            if (supportsPasskey()) showMethodChoice();
            else if (supportsRecoveryCode()) showRecoveryCode();
            else throw new Error(message(
                "Brak dostępnej metody MFA.",
                "No MFA method is available."));

            const expiresAt = Date.parse(result.expiresAtUtc || "");
            expiresTimer = setTimeout(function () {
                clearTransaction();
                const target = document.getElementById("loginError");
                if (target) target.textContent = message(
                    "Żądanie MFA wygasło. Zaloguj się ponownie.",
                    "The MFA request expired. Sign in again.");
            }, Number.isFinite(expiresAt)
                ? Math.max(1000, expiresAt - Date.now())
                : 300000);
        }

        async function usePasskey() {
            recoveryError.textContent = "";
            passkeyButton.disabled = true;
            recoveryChoiceButton.disabled = true;
            try {
                const begin = await request("/api/login/mfa/passkey/begin", {
                    method: "POST",
                    body: JSON.stringify({ transactionToken })
                });
                const options = begin.publicKey || begin.options;
                const credential = await navigator.credentials.get({
                    publicKey: assertionOptions(options)
                });
                if (!credential)
                    throw new Error(message(
                        "Nie wybrano metody WebAuthn.",
                        "No WebAuthn method was selected."));
                await request("/api/login/mfa/passkey/finish", {
                    method: "POST",
                    body: JSON.stringify({
                        transactionToken,
                        challengeId: begin.challengeId,
                        credential: assertionResponse(credential)
                    })
                });
                transactionToken = "";
                clearAccessAndReload();
            } catch (error) {
                recoveryError.textContent = error.name === "NotAllowedError"
                    ? message(
                        "Operacja została anulowana lub przekroczono czas.",
                        "The operation was cancelled or timed out.")
                    : error.message;
                if (!supportsRecoveryCode() &&
                    (error.status === 401 || error.status === 410))
                    clearTransaction();
            } finally {
                passkeyButton.disabled = false;
                recoveryChoiceButton.disabled = false;
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
                    cache: "no-store",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: "Bearer " + accessCode()
                    },
                    body: JSON.stringify({
                        userName: document.getElementById("username").value,
                        password: document.getElementById("password").value
                    })
                });
                const result = await response.json().catch(() => ({}));
                document.getElementById("password").value = "";
                if (response.status === 202 && result.mfaRequired) {
                    showMfa(result);
                    return;
                }
                if (!response.ok)
                    throw new Error(result.error || message(
                        "Logowanie nie powiodło się.",
                        "Sign-in failed."));
                clearAccessAndReload();
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
                await request("/api/login/mfa/recovery", {
                    method: "POST",
                    headers: { Authorization: "Bearer " + accessCode() },
                    body: JSON.stringify({
                        transactionToken,
                        recoveryCode: recoveryCode.value
                    })
                });
                transactionToken = "";
                clearAccessAndReload();
            } catch (error) {
                recoveryCode.value = "";
                recoveryCode.focus();
                recoveryError.textContent = error.message;
                if (error.status === 401 || error.status === 410)
                    clearTransaction();
            }
        }, true);

        passkeyButton.addEventListener("click", usePasskey);
        recoveryChoiceButton.addEventListener("click", showRecoveryCode);
        backToMethodsButton.addEventListener("click", showMethodChoice);
        cancelButton.addEventListener("click", function (event) {
            event.stopImmediatePropagation();
            clearTransaction();
        }, true);
        addEventListener("pagehide", function () {
            transactionToken = "";
        });
        new MutationObserver(applyLabels).observe(
            document.documentElement,
            { attributes: true, attributeFilter: ["lang"] });
        applyLabels();
    }

    function initializeManagement() {
        const view = document.getElementById("breakGlassView");
        const grid = view && view.querySelector(".settings-grid");
        if (!grid || document.getElementById("webauthnManagementCard")) return;

        const article = document.createElement("article");
        article.id = "webauthnManagementCard";
        article.className = "settings-card danger-card";
        article.innerHTML = [
            '<h2 data-passkey-title></h2>',
            '<p class="muted" data-passkey-status></p>',
            '<label><span data-passkey-name-label></span><input data-passkey-name maxlength="120" value="YubiKey"></label>',
            '<div class="users-list" data-passkey-list></div>',
            '<div class="form-actions">',
            '  <button type="button" data-passkey-register></button>',
            '  <button type="button" class="secondary" data-passkey-refresh></button>',
            '</div>',
            '<p class="error" role="status" data-passkey-message></p>'
        ].join("");
        grid.append(article);

        const title = article.querySelector("[data-passkey-title]");
        const status = article.querySelector("[data-passkey-status]");
        const nameLabel = article.querySelector("[data-passkey-name-label]");
        const name = article.querySelector("[data-passkey-name]");
        const list = article.querySelector("[data-passkey-list]");
        const register = article.querySelector("[data-passkey-register]");
        const refresh = article.querySelector("[data-passkey-refresh]");
        const output = article.querySelector("[data-passkey-message]");

        function applyLabels() {
            title.textContent = "Windows Hello / YubiKey / WebAuthn";
            nameLabel.textContent = message("Nazwa metody", "Method name");
            register.textContent = message("Dodaj metodę", "Add method");
            refresh.textContent = message("Odśwież", "Refresh");
        }

        async function load() {
            output.textContent = "";
            try {
                const credentials = await request("/api/v1/webauthn/credentials");
                status.textContent = credentials.length
                    ? message("Aktywne metody: ", "Active methods: ") + credentials.length
                    : message(
                        "Brak skonfigurowanego Windows Hello lub YubiKey.",
                        "Windows Hello or a YubiKey is not configured.");
                list.replaceChildren(...credentials.map(item => {
                    const row = document.createElement("div");
                    row.className = "user-row";
                    const info = document.createElement("div");
                    const strong = document.createElement("strong");
                    strong.textContent = item.displayName || "Passkey";
                    const details = document.createElement("small");
                    details.textContent = (item.transports || []).join(", ") +
                        " · " + new Date(item.registeredAtUtc).toLocaleString(language());
                    info.append(strong, document.createElement("br"), details);
                    const remove = document.createElement("button");
                    remove.type = "button";
                    remove.className = "danger";
                    remove.textContent = message("Usuń", "Remove");
                    remove.addEventListener("click", async function () {
                        if (!confirm(message(
                            "Usunąć tę metodę uwierzytelnienia?",
                            "Remove this authentication method?"))) return;
                        await request(
                            "/api/v1/webauthn/credentials/" +
                                encodeURIComponent(item.credentialId),
                            { method: "DELETE", headers: await csrfHeaders() });
                        await load();
                    });
                    row.append(info, remove);
                    return row;
                }));
            } catch (error) {
                status.textContent = error.status === 401 || error.status === 403
                    ? ""
                    : error.message;
            }
        }

        register.addEventListener("click", async function () {
            output.textContent = "";
            register.disabled = true;
            try {
                if (!window.PublicKeyCredential || !navigator.credentials)
                    throw new Error(message(
                        "Ta przeglądarka nie obsługuje WebAuthn.",
                        "This browser does not support WebAuthn."));
                const issued = await request("/api/v1/webauthn/registration/options", {
                    method: "POST",
                    headers: await csrfHeaders(),
                    body: JSON.stringify({
                        displayName: name.value.trim() || "YubiKey"
                    })
                });
                const credential = await navigator.credentials.create({
                    publicKey: creationOptions(issued.options)
                });
                if (!credential)
                    throw new Error(message(
                        "Nie utworzono metody WebAuthn.",
                        "No WebAuthn method was created."));
                await request("/api/v1/webauthn/registration/verify", {
                    method: "POST",
                    headers: await csrfHeaders(),
                    body: JSON.stringify({
                        ceremonyId: issued.ceremonyId,
                        response: attestationResponse(credential)
                    })
                });
                output.textContent = message(
                    "Metoda została zarejestrowana.",
                    "The method was registered.");
                await load();
            } catch (error) {
                output.textContent = error.name === "NotAllowedError"
                    ? message(
                        "Rejestracja została anulowana lub przekroczono czas.",
                        "Registration was cancelled or timed out.")
                    : error.message;
            } finally {
                register.disabled = false;
            }
        });

        refresh.addEventListener("click", load);
        new MutationObserver(applyLabels).observe(
            document.documentElement,
            { attributes: true, attributeFilter: ["lang"] });
        applyLabels();
        load();
    }

    function initialize() {
        initializeLogin();
        initializeManagement();
    }

    if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else
        initialize();
}());
