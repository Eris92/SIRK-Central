"use strict";

(() => {
  const byId = id => document.getElementById(id);
  const accessCode = new URLSearchParams(location.hash.replace(/^#/, "")).get("access") || "";
  const base64UrlToBytes = value => {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  };
  const bytesToBase64Url = value => {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value || []);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  };
  const jsonRequest = async (path, options = {}) => {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.code || `HTTP ${response.status}`);
    return body;
  };
  const csrf = async () => {
    const value = await jsonRequest("/api/v1/auth/csrf");
    return { [value.headerName || "X-SIRK-CSRF"]: value.requestToken };
  };
  const publicKeyCreateOptions = options => {
    const value = structuredClone(options);
    value.challenge = base64UrlToBytes(value.challenge);
    value.user.id = base64UrlToBytes(value.user.id);
    value.excludeCredentials = (value.excludeCredentials || []).map(item => ({ ...item, id: base64UrlToBytes(item.id) }));
    return value;
  };
  const publicKeyRequestOptions = options => {
    const value = structuredClone(options);
    value.challenge = base64UrlToBytes(value.challenge);
    value.allowCredentials = (value.allowCredentials || []).map(item => ({ ...item, id: base64UrlToBytes(item.id) }));
    return value;
  };
  const attestationResponse = credential => ({
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      attestationObject: bytesToBase64Url(credential.response.attestationObject),
      clientDataJSON: bytesToBase64Url(credential.response.clientDataJSON),
      transports: typeof credential.response.getTransports === "function" ? credential.response.getTransports() : []
    },
    clientExtensionResults: credential.getClientExtensionResults()
  });
  const assertionResponse = credential => ({
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: bytesToBase64Url(credential.response.authenticatorData),
      clientDataJSON: bytesToBase64Url(credential.response.clientDataJSON),
      signature: bytesToBase64Url(credential.response.signature),
      userHandle: credential.response.userHandle ? bytesToBase64Url(credential.response.userHandle) : null
    },
    clientExtensionResults: credential.getClientExtensionResults()
  });

  async function signInWithSecurityKey() {
    const username = byId("username")?.value?.trim();
    const message = byId("webauthnLoginMessage");
    if (!accessCode || !username) {
      message.textContent = "Podaj użytkownika i otwórz poprawny Break-Glass access URL.";
      return;
    }
    message.textContent = "Dotknij klucza bezpieczeństwa...";
    try {
      const issued = await jsonRequest(`/api/v1/break-glass/${encodeURIComponent(accessCode)}/webauthn/options`, {
        method: "POST",
        body: JSON.stringify({ userName: username, accessCode })
      });
      const credential = await navigator.credentials.get({ publicKey: publicKeyRequestOptions(issued.options) });
      if (!credential) throw new Error("Nie otrzymano odpowiedzi z klucza bezpieczeństwa.");
      await jsonRequest(`/api/v1/break-glass/${encodeURIComponent(accessCode)}/webauthn/verify`, {
        method: "POST",
        body: JSON.stringify({ ceremonyId: issued.ceremonyId, accessCode, response: assertionResponse(credential) })
      });
      location.reload();
    } catch (error) {
      message.textContent = error.name === "NotAllowedError" ? "Operacja została anulowana lub przekroczono czas." : error.message;
    }
  }

  async function refreshCredentials() {
    const list = byId("webauthnCredentialList");
    if (!list) return;
    try {
      const credentials = await jsonRequest("/api/v1/webauthn/credentials");
      list.replaceChildren(...credentials.map(item => {
        const row = document.createElement("article");
        row.className = "user-row";
        const text = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = item.displayName || "Security key";
        const details = document.createElement("small");
        details.className = "muted";
        details.textContent = `${item.aaGuid || "AAGUID unknown"} · ${item.transports?.join(", ") || "transport unknown"}`;
        text.append(name, document.createElement("br"), details);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary";
        remove.textContent = "Usuń";
        remove.addEventListener("click", async () => {
          try {
            await jsonRequest(`/api/v1/webauthn/credentials/${encodeURIComponent(item.credentialId)}`, {
              method: "DELETE",
              headers: await csrf()
            });
            await refreshCredentials();
          } catch (error) {
            byId("webauthnRegisterMessage").textContent = error.message;
          }
        });
        row.append(text, remove);
        return row;
      }));
    } catch (_) {
      list.replaceChildren();
    }
  }

  async function registerSecurityKey() {
    const message = byId("webauthnRegisterMessage");
    message.textContent = "Dotknij klucza bezpieczeństwa...";
    try {
      const issued = await jsonRequest("/api/v1/webauthn/registration/options", {
        method: "POST",
        headers: await csrf(),
        body: JSON.stringify({ displayName: byId("webauthnDisplayName").value.trim() || "YubiKey" })
      });
      const credential = await navigator.credentials.create({ publicKey: publicKeyCreateOptions(issued.options) });
      if (!credential) throw new Error("Nie otrzymano odpowiedzi z klucza bezpieczeństwa.");
      await jsonRequest("/api/v1/webauthn/registration/verify", {
        method: "POST",
        headers: await csrf(),
        body: JSON.stringify({ ceremonyId: issued.ceremonyId, response: attestationResponse(credential) })
      });
      message.textContent = "Klucz bezpieczeństwa został zarejestrowany.";
      await refreshCredentials();
    } catch (error) {
      message.textContent = error.name === "NotAllowedError" ? "Operacja została anulowana lub przekroczono czas." : error.message;
    }
  }

  function installLoginButton() {
    const form = byId("loginForm");
    if (!form || byId("webauthnLoginButton") || !window.PublicKeyCredential) return;
    const button = document.createElement("button");
    button.id = "webauthnLoginButton";
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Zaloguj kluczem YubiKey / Passkey";
    const message = document.createElement("p");
    message.id = "webauthnLoginMessage";
    message.className = "error";
    message.setAttribute("role", "alert");
    button.addEventListener("click", signInWithSecurityKey);
    form.append(button, message);
  }

  function installRegistrationCard() {
    const view = byId("breakGlassView");
    const grid = view?.querySelector(".settings-grid");
    if (!grid || byId("webauthnCard") || !window.PublicKeyCredential) return;
    const card = document.createElement("article");
    card.id = "webauthnCard";
    card.className = "settings-card";
    card.innerHTML = `<h2>YubiKey / Passkeys</h2><p class="muted">Zarejestruj co najmniej dwa klucze bezpieczeństwa. User verification jest wymagane.</p><label>Nazwa klucza<input id="webauthnDisplayName" maxlength="120" value="YubiKey"></label><div class="form-actions"><button id="webauthnRegisterButton" type="button">Dodaj klucz</button></div><div id="webauthnCredentialList" class="users-list"></div><p id="webauthnRegisterMessage" class="error" role="status"></p>`;
    grid.append(card);
    byId("webauthnRegisterButton").addEventListener("click", registerSecurityKey);
    refreshCredentials();
  }

  const observer = new MutationObserver(() => {
    installLoginButton();
    installRegistrationCard();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  installLoginButton();
  installRegistrationCard();
})();
