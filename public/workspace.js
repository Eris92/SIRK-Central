"use strict";

(() => {
  const state = {
    session: null,
    csrf: null,
    portals: [],
    mfa: null,
    lang: localStorage.getItem("sirk.lang") === "en" ? "en" : "pl"
  };

  const modulePresets = {
    approvals: [
      ["GET", "/api/v1/approvals", {}],
      ["POST", "/api/v1/approvals", { portalId: "", operation: "", payload: {} }],
      ["POST", "/api/v1/approvals/{id}/decision", { approved: true, note: "" }]
    ],
    tickets: [
      ["GET", "/api/v1/tickets", {}],
      ["POST", "/api/v1/tickets", { title: "", description: "", priority: "normal", portalId: "" }],
      ["POST", "/api/v1/tickets/{id}/comments", { body: "" }],
      ["PATCH", "/api/v1/tickets/{id}", { status: "in-progress" }]
    ],
    organizations: [
      ["GET", "/api/v1/organizations", {}],
      ["POST", "/api/v1/organizations", { name: "", description: "" }],
      ["PUT", "/api/v1/organizations/{id}", { name: "", description: "" }]
    ],
    backup: [
      ["GET", "/api/v1/backup/status", {}],
      ["POST", "/api/v1/backup/archive", {}],
      ["POST", "/api/v1/security/backup-key/export", { password: "" }],
      ["POST", "/api/v1/security/backup-key/rotate", { password: "" }]
    ],
    operations: [
      ["GET", "/api/v1/operations/status", {}],
      ["GET", "/api/v1/operations/releases", {}],
      ["POST", "/api/v1/operations/maintenance", { enabled: true, reason: "" }],
      ["POST", "/api/v1/operations/update", { version: "" }]
    ]
  };

  const $ = (id) => document.getElementById(id);
  const pretty = (value) => JSON.stringify(value, null, 2);
  const parseJson = (text) => {
    const normalized = String(text || "").trim();
    return normalized ? JSON.parse(normalized) : {};
  };

  async function rawRequest(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    if (options.body !== undefined && options.body !== null) {
      headers.set("Content-Type", "application/json");
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      await ensureCsrf();
      headers.set(state.csrf.headerName, state.csrf.requestToken);
    }
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
      headers,
      body: options.body === undefined || options.body === null
        ? undefined
        : JSON.stringify(options.body)
    });
    const contentType = response.headers.get("content-type") || "";
    let data = null;
    if (response.status !== 204) {
      data = contentType.includes("application/json")
        ? await response.json()
        : await response.text();
    }
    if (!response.ok) {
      const message = data && typeof data === "object"
        ? data.error || data.title || data.code
        : String(data || `HTTP ${response.status}`);
      const error = new Error(message || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function publicRequest(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      const error = new Error(data?.error || data?.title || data?.code || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return { status: response.status, data };
  }

  async function ensureCsrf(force = false) {
    if (state.csrf && !force) return state.csrf;
    const response = await fetch("/api/v1/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) throw new Error("CSRF token could not be issued.");
    state.csrf = await response.json();
    return state.csrf;
  }

  function setStatus(id, message, type = "") {
    const element = $(id);
    if (!element) return;
    element.textContent = message || "";
    element.className = `status ${type}`.trim();
  }

  function showLogin() {
    $("loginPage").hidden = false;
    $("workspace").hidden = true;
    state.session = null;
    state.csrf = null;
  }

  function showWorkspace(session) {
    state.session = session;
    $("loginPage").hidden = true;
    $("workspace").hidden = false;
    $("identity").textContent = `${session.userName || session.userId} · ${(session.roles || []).join(", ")} · ${session.authenticationMethod || "session"}`;
    $("sessionOutput").textContent = pretty(session);
  }

  async function initialize() {
    applyLanguage(state.lang);
    renderModuleConsoles();
    wireEvents();
    await refreshEntraPublic();
    try {
      const session = await rawRequest("/api/v1/auth/session");
      showWorkspace(session);
      await Promise.allSettled([loadSystem(), loadPortals(), loadIdentity(), loadEntra()]);
    } catch (error) {
      if (error.status !== 401) setStatus("loginStatus", error.message, "error");
      showLogin();
    }
  }

  async function refreshEntraPublic() {
    try {
      const result = await publicRequest("/api/v1/auth/entra/status");
      $("entraPublicOutput").textContent = pretty(result.data);
      $("entraLogin").disabled = !result.data?.enabled || !result.data?.configured;
    } catch (error) {
      $("entraPublicOutput").textContent = pretty({ error: error.message });
      $("entraLogin").disabled = true;
    }
  }

  async function loginLocal(event) {
    event.preventDefault();
    setStatus("loginStatus", "Logowanie...", "");
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
    const accessCode = fragment.get("access") || "";
    const endpoint = accessCode
      ? `/api/v1/break-glass/${encodeURIComponent(accessCode)}/login`
      : "/api/v1/auth/local/login";
    try {
      const result = await publicRequest(
        endpoint,
        {
          method: "POST",
          body: {
            userName: $("loginUser").value,
            password: $("loginPassword").value
          }
        });
      if (accessCode && (result.status === 202 || result.data?.mfaRequired)) {
        state.mfa = result.data;
        showMfa(result.data);
        return;
      }
      if (accessCode) {
        location.hash = "";
        history.replaceState(null, "", location.pathname + location.search);
      }
      state.csrf = null;
      const session = await rawRequest("/api/v1/auth/session");
      showWorkspace(session);
      await Promise.allSettled([loadSystem(), loadPortals(), loadIdentity(), loadEntra()]);
    } catch (error) {
      setStatus("loginStatus", error.message, "error");
    }
  }

  function showMfa(value) {
    $("mfaPanel").hidden = false;
    const methods = Array.isArray(value.methods) ? value.methods : [];
    $("mfaInfo").textContent = `Transaction: ${value.transactionToken || ""} · ${methods.join(", ")}`;
    $("passkeyComplete").hidden = !methods.includes("passkey");
    $("recoveryComplete").hidden = !methods.includes("recovery-code");
    $("recoveryCodeLabel").hidden = !methods.includes("recovery-code");
    setStatus("loginStatus", "Hasło poprawne. Wymagane MFA.", "warning");
  }

  async function completeRecoveryCode() {
    if (!state.mfa?.transactionToken) return;
    setStatus("loginStatus", "Weryfikacja kodu...", "");
    try {
      await publicRequest("/api/v1/break-glass/mfa/recovery-code/complete", {
        method: "POST",
        body: {
          transactionToken: state.mfa.transactionToken,
          recoveryCode: $("recoveryCode").value
        }
      });
      state.mfa = null;
      $("mfaPanel").hidden = true;
      state.csrf = null;
      const session = await rawRequest("/api/v1/auth/session");
      showWorkspace(session);
      await Promise.allSettled([loadSystem(), loadPortals(), loadIdentity(), loadEntra()]);
    } catch (error) {
      setStatus("loginStatus", error.message, "error");
    }
  }

  async function completePasskey() {
    setStatus("loginStatus", "Passkey flow wymaga WebAuthn ceremony endpoint.", "warning");
  }

  async function logout() {
    try {
      await rawRequest("/api/v1/auth/logout", { method: "POST", body: {} });
    } finally {
      showLogin();
      await refreshEntraPublic();
    }
  }

  async function loadSystem() {
    const value = await rawRequest("/api/v1/system/version");
    $("systemOutput").textContent = pretty(value);
    return value;
  }

  async function loadPortals() {
    const value = await rawRequest("/api/portals");
    state.portals = value?.portals || [];
    renderPortals();
    return value;
  }

  function renderPortals() {
    const select = $("portalSelect");
    const selected = select.value;
    select.replaceChildren(...state.portals.map((portal) => {
      const option = document.createElement("option");
      option.value = portal.id;
      option.textContent = `${portal.name} (${portal.connectionState || portal.status || (portal.connected ? "online" : "offline")})`;
      return option;
    }));
    if (state.portals.some((portal) => portal.id === selected)) select.value = selected;

    const table = document.createElement("table");
    const head = document.createElement("thead");
    head.innerHTML = "<tr><th>Status</th><th>ID</th><th>Nazwa</th><th>Version</th><th>Agents</th><th>Heartbeat</th></tr>";
    table.append(head);
    const body = document.createElement("tbody");
    for (const portal of state.portals) {
      const status = portal.connectionState || portal.status || (portal.connected ? "online" : "offline");
      const row = document.createElement("tr");
      const cells = [status, portal.id, portal.name, portal.heartbeat?.portalVersion || "", portal.heartbeat?.agentCount ?? "", portal.heartbeat?.receivedAtUtc || ""];
      cells.forEach((value, index) => {
        const cell = document.createElement("td");
        if (index === 0) {
          const badge = document.createElement("span");
          badge.className = `badge ${status}`;
          badge.textContent = status;
          cell.append(badge);
        } else {
          cell.textContent = String(value);
        }
        row.append(cell);
      });
      body.append(row);
    }
    table.append(body);
    $("portalTable").replaceChildren(table);
  }

  async function createPortal(event) {
    event.preventDefault();
    const value = await rawRequest("/api/v1/admin/portals/", {
      method: "POST",
      body: { id: $("portalId").value.trim(), name: $("portalName").value.trim() }
    });
    $("portalCredential").textContent = pretty(value?.credential || value);
    event.target.reset();
    await loadPortals();
  }

  function selectedPortalId() {
    const id = $("portalSelect").value;
    if (!id) throw new Error("Wybierz Portal.");
    return id;
  }

  async function connectPortal() {
    const id = selectedPortalId();
    const value = await rawRequest(`/api/v1/portals/${encodeURIComponent(id)}/connect`, { method: "POST", body: {} });
    if (!value?.url) throw new Error("Portal tunnel URL is missing.");
    location.assign(value.url);
  }

  async function rotatePortal() {
    const id = selectedPortalId();
    const value = await rawRequest(`/api/v1/admin/portals/${encodeURIComponent(id)}/rotate-token`, { method: "POST", body: {} });
    $("portalCredential").textContent = pretty(value?.credential || value);
    await loadPortals();
  }

  async function deletePortal() {
    const id = selectedPortalId();
    if (!confirm(`Usunąć Portal ${id}?`)) return;
    await rawRequest(`/api/v1/admin/portals/${encodeURIComponent(id)}`, { method: "DELETE", body: {} });
    await loadPortals();
  }

  async function loadIdentity() {
    const value = await rawRequest("/api/v2/identity-access");
    $("identityOutput").textContent = pretty(value);
    return value;
  }

  async function mutateIdentity() {
    const value = await rawRequest("/api/v2/identity-access/mutation", {
      method: "POST",
      body: {
        action: $("identityAction").value,
        payload: parseJson($("identityPayload").value)
      }
    });
    $("identityMutationOutput").textContent = pretty(value);
    await loadIdentity();
  }

  async function loadEntra() {
    try {
      const value = await rawRequest("/api/v1/security/entra");
      $("entraConfig").value = pretty(value);
      $("entraOutput").textContent = pretty(value);
      return value;
    } catch (error) {
      $("entraOutput").textContent = pretty({ error: error.message, status: error.status });
      throw error;
    }
  }

  async function saveEntra() {
    const source = parseJson($("entraConfig").value);
    const payload = source.provider || source;
    const value = await rawRequest("/api/v1/security/entra", { method: "PUT", body: payload });
    $("entraOutput").textContent = pretty(value);
    await refreshEntraPublic();
  }

  async function testEntra() {
    const value = await rawRequest("/api/v1/security/entra/test", { method: "POST", body: {} });
    $("entraOutput").textContent = pretty(value);
  }

  function renderModuleConsoles() {
    for (const container of document.querySelectorAll(".module-console")) {
      const key = container.dataset.module;
      const presets = modulePresets[key] || [];
      const selector = document.createElement("select");
      presets.forEach((preset, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `${preset[0]} ${preset[1]}`;
        selector.append(option);
      });
      const path = document.createElement("input");
      path.setAttribute("aria-label", "API path");
      const method = document.createElement("select");
      ["GET", "POST", "PUT", "PATCH", "DELETE"].forEach((name) => {
        const option = document.createElement("option");
        option.textContent = name;
        method.append(option);
      });
      const body = document.createElement("textarea");
      const run = document.createElement("button");
      run.type = "button";
      run.className = "primary";
      run.textContent = "Wykonaj";
      const output = document.createElement("pre");
      output.className = "output";
      const row = document.createElement("div");
      row.className = "row";
      row.append(selector, method, path, run);
      container.append(row, body, output);

      const applyPreset = () => {
        const preset = presets[Number(selector.value)] || ["GET", "", {}];
        method.value = preset[0];
        path.value = preset[1];
        body.value = pretty(preset[2]);
      };
      selector.addEventListener("change", applyPreset);
      run.addEventListener("click", async () => {
        try {
          const verb = method.value;
          const value = await rawRequest(path.value.trim(), {
            method: verb,
            body: ["GET", "HEAD"].includes(verb) ? undefined : parseJson(body.value)
          });
          output.textContent = pretty(value);
        } catch (error) {
          output.textContent = pretty({ error: error.message, status: error.status, data: error.data });
        }
      });
      applyPreset();
    }
  }

  async function runApiConsole() {
    try {
      const method = $("apiMethod").value;
      const value = await rawRequest($("apiPath").value.trim(), {
        method,
        body: ["GET", "HEAD"].includes(method) ? undefined : parseJson($("apiBody").value)
      });
      $("apiOutput").textContent = pretty(value);
    } catch (error) {
      $("apiOutput").textContent = pretty({ error: error.message, status: error.status, data: error.data });
    }
  }

  function setView(name) {
    for (const panel of document.querySelectorAll("[data-view-panel]")) {
      panel.hidden = panel.dataset.viewPanel !== name;
    }
    for (const button of document.querySelectorAll("[data-view]")) {
      button.classList.toggle("active", button.dataset.view === name);
    }
  }

  function applyLanguage(lang) {
    state.lang = lang === "en" ? "en" : "pl";
    localStorage.setItem("sirk.lang", state.lang);
    document.documentElement.lang = state.lang;
    for (const button of document.querySelectorAll("[data-lang]")) {
      button.disabled = button.dataset.lang === state.lang;
    }
  }

  function guard(action, outputId = "apiOutput") {
    return async (...args) => {
      try {
        await action(...args);
      } catch (error) {
        const output = $(outputId);
        if (output) output.textContent = pretty({ error: error.message, status: error.status, data: error.data });
        else setStatus("loginStatus", error.message, "error");
      }
    };
  }

  function wireEvents() {
    document.querySelectorAll("[data-lang]").forEach((button) =>
      button.addEventListener("click", () => applyLanguage(button.dataset.lang)));
    document.querySelectorAll("[data-view]").forEach((button) =>
      button.addEventListener("click", () => setView(button.dataset.view)));
    $("localLogin").addEventListener("submit", loginLocal);
    $("entraLogin").addEventListener("click", () => location.assign("/api/v1/auth/entra/login?returnUrl=%2Fworkspace.html"));
    $("logout").addEventListener("click", guard(logout));
    $("recoveryComplete").addEventListener("click", completeRecoveryCode);
    $("passkeyComplete").addEventListener("click", completePasskey);
    $("portalsRefresh").addEventListener("click", guard(loadPortals, "portalCredential"));
    $("portalCreate").addEventListener("submit", guard(createPortal, "portalCredential"));
    $("portalConnect").addEventListener("click", guard(connectPortal, "portalCredential"));
    $("portalRotate").addEventListener("click", guard(rotatePortal, "portalCredential"));
    $("portalDelete").addEventListener("click", guard(deletePortal, "portalCredential"));
    $("identityRefresh").addEventListener("click", guard(loadIdentity, "identityOutput"));
    $("identityMutate").addEventListener("click", guard(mutateIdentity, "identityMutationOutput"));
    $("entraRefresh").addEventListener("click", guard(loadEntra, "entraOutput"));
    $("entraSave").addEventListener("click", guard(saveEntra, "entraOutput"));
    $("entraTest").addEventListener("click", guard(testEntra, "entraOutput"));
    $("apiRun").addEventListener("click", runApiConsole);
    document.querySelectorAll("[data-load]").forEach((button) => {
      const actions = { system: loadSystem, session: async () => $("sessionOutput").textContent = pretty(await rawRequest("/api/v1/auth/session")), "entra-status": refreshEntraPublic };
      button.addEventListener("click", guard(actions[button.dataset.load]));
    });
  }

  initialize().catch((error) => setStatus("loginStatus", error.message, "error"));
})();
