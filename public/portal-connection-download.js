"use strict";

(() => {
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
