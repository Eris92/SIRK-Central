"use strict";

(() => {
  const roleOrder = Object.freeze([
    "Auditor",
    "OperatorL1",
    "SupportL2",
    "EngineerL3",
    "Admin",
    "SecAdmin"
  ]);
  let roleCatalogLoading = false;

  async function csrf() {
    const response = await fetch("/api/v1/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error("Nie można pobrać tokenu CSRF.");
    const value = await response.json();
    if (!value.requestToken) throw new Error("Central nie zwrócił tokenu CSRF.");
    return value;
  }

  async function readJson(path) {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || body.title || `HTTP ${response.status}`);
    }
    return body;
  }

  function rolesForSession(session) {
    const claimed = new Set([
      ...(Array.isArray(session?.roles) ? session.roles : []),
      session?.role
    ].filter(Boolean));

    if (claimed.has("BreakGlass")) return [...roleOrder];
    if (claimed.has("SecAdmin")) return ["SecAdmin"];
    if (claimed.has("Admin")) return roleOrder.filter(role => role !== "SecAdmin");
    return [];
  }

  function populateRoleSelect(select, roles) {
    const current = String(select.value || "");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = document.documentElement.lang === "en"
      ? "Choose role"
      : "Wybierz rolę";
    placeholder.disabled = true;
    placeholder.selected = !roles.includes(current);

    const options = roles.map(role => {
      const option = document.createElement("option");
      option.value = role;
      option.textContent = role;
      option.selected = role === current;
      return option;
    });

    select.replaceChildren(placeholder, ...options);
    select.disabled = roles.length === 0;
    select.dataset.roleCatalogLoaded = roles.length ? "true" : "false";
  }

  async function mountRoleCatalog(force = false) {
    const select = document.getElementById("newRole");
    if (!select || roleCatalogLoading) return;
    if (!force && select.dataset.roleCatalogLoaded === "true" && select.options.length > 1) return;

    roleCatalogLoading = true;
    const error = document.getElementById("userError");
    try {
      let roles = [];
      try {
        const catalog = await readJson("/api/settings/roles");
        roles = Array.isArray(catalog.roles)
          ? catalog.roles.filter(role => roleOrder.includes(role))
          : [];
      } catch (_) {
        const session = await readJson("/api/session");
        roles = rolesForSession(session);
      }

      populateRoleSelect(select, roles);
      if (error) {
        error.textContent = roles.length
          ? ""
          : "Brak ról możliwych do przypisania dla bieżącego konta.";
      }
    } catch (exception) {
      populateRoleSelect(select, []);
      if (error) {
        error.textContent = exception?.message || "Nie udało się pobrać katalogu ról.";
      }
    } finally {
      roleCatalogLoading = false;
    }
  }

  function selectedPortalId() {
    const select = document.getElementById("portalSelect");
    const value = String(select && select.value || "").trim();
    if (!value) throw new Error("Wybierz Portal.");
    return value;
  }

  function nameFromDisposition(response, fallback) {
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = /filename\*?=(?:UTF-8''|\")?([^\";]+)/i.exec(disposition);
    return match ? decodeURIComponent(match[1].replace(/^\"|\"$/g, "")) : fallback;
  }

  function connectedInstallerCommand() {
    return "$f=Get-ChildItem \"$env:USERPROFILE\\Downloads\\SIRK-Portal-*-connection.json\" -File|Sort-Object LastWriteTimeUtc -Descending|Select-Object -First 1;if(!$f){throw 'Najpierw skopiuj plik polaczenia do Downloads'};$p=\"$env:TEMP\\install-connected-dotnet10.ps1\";iwr -UseBasicParsing https://raw.githubusercontent.com/Eris92/SIRK-Portal/main/install-connected-dotnet10.ps1 -OutFile $p;Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$p,'-ConnectionFile',$f.FullName)";
  }

  async function downloadConnection() {
    const portalId = selectedPortalId();
    if (!window.confirm(
      "Pobranie pliku połączenia zrotuje token Portalu i natychmiast unieważni poprzedni. Kontynuować?")) {
      return;
    }

    const button = document.getElementById("portalConnectionFile");
    const output = document.getElementById("portalCredential");
    button.disabled = true;
    output.textContent = "Generowanie chronionego pliku połączenia…";
    try {
      const token = await csrf();
      const response = await fetch(
        `/api/v1/admin/portals/${encodeURIComponent(portalId)}/connection-file`,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            [token.headerName || "X-SIRK-CSRF"]: token.requestToken
          }
        });
      if (!response.ok) {
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch (_) {}
        throw new Error(payload.error || payload.title || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      if (blob.size < 128) throw new Error("Plik połączenia jest niekompletny.");
      const fileName = nameFromDisposition(
        response,
        `SIRK-Portal-${portalId}-connection.json`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      output.textContent =
        `Pobrano ${fileName}. Token został zrotowany i jest zapisany wyłącznie w tym pliku. ` +
        "Skopiuj plik do katalogu Downloads na docelowym Windows Server, a następnie uruchom:\n\n" +
        connectedInstallerCommand();
      document.getElementById("portalsRefresh")?.click();
    } catch (error) {
      output.textContent = JSON.stringify({ error: error.message }, null, 2);
    } finally {
      button.disabled = false;
    }
  }

  function setBreakGlassVisibility(visible) {
    const form = document.getElementById("localLogin");
    const separator = form?.previousElementSibling;
    if (form) form.hidden = !visible;
    if (separator && separator.classList.contains("login-separator")) separator.hidden = !visible;
  }

  async function validateWorkspaceAccess() {
    setBreakGlassVisibility(false);
    const fragment = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
    const accessCode = fragment.get("access") || "";
    if (!accessCode) return;

    try {
      const response = await fetch("/api/access", {
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessCode}`
        }
      });
      if (!response.ok) return;
      const value = await response.json();
      if (value?.localLoginEnabled === true) {
        setBreakGlassVisibility(true);
        return;
      }
    } catch (_) {
      // Fail closed.
    }

    const status = document.getElementById("loginStatus");
    if (status) {
      status.textContent = "Nieprawidłowy Access URL Break-Glass.";
      status.className = "status error";
    }
  }

  function updateReturnLabel(button) {
    button.textContent = document.documentElement.lang === "en"
      ? "Back to Portals"
      : "Powrót do Portali";
  }

  function mountPortalReturn() {
    const topbar = document.querySelector("#workspace .topbar");
    const logout = document.getElementById("logout");
    if (!topbar || !logout || document.getElementById("portalHomeButton")) return;

    const button = document.createElement("button");
    button.id = "portalHomeButton";
    button.type = "button";
    updateReturnLabel(button);
    button.addEventListener("click", () => window.location.assign("/"));
    topbar.insertBefore(button, logout);

    new MutationObserver(() => updateReturnLabel(button)).observe(
      document.documentElement,
      { attributes: true, attributeFilter: ["lang"] });
  }

  function mount() {
    validateWorkspaceAccess();
    mountPortalReturn();
    mountRoleCatalog();

    document.addEventListener("click", event => {
      const target = event.target instanceof Element ? event.target.closest("button") : null;
      if (!target) return;
      if (target.dataset.permissionsTab === "add" ||
          target.dataset.settingsTab === "add-user" ||
          target.id === "addUserTabButton") {
        window.setTimeout(() => mountRoleCatalog(true), 0);
      }
    }, { capture: true });

    const rotate = document.getElementById("portalRotate");
    if (!rotate || document.getElementById("portalConnectionFile")) return;
    const button = document.createElement("button");
    button.id = "portalConnectionFile";
    button.type = "button";
    button.textContent = "Pobierz plik połączenia";
    button.addEventListener("click", downloadConnection);
    rotate.insertAdjacentElement("afterend", button);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
