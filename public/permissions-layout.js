"use strict";

(function () {
  const loginLink = document.querySelector("a.login-provider");
  if (loginLink) {
    loginLink.target = "_self";
    loginLink.rel = "noopener";
    loginLink.addEventListener("click", function (event) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      window.location.assign(loginLink.href);
    }, { capture: true });
  }

  const accessButton = document.getElementById("accessButton");
  const settingsButton = document.getElementById("settingsButton");
  const backButton = document.getElementById("backButton");
  const accessView = document.getElementById("accessView");
  const settingsView = document.getElementById("settingsView");
  const portalsView = document.getElementById("portalsView");
  const breakGlassView = document.getElementById("breakGlassView");
  const pageTitle = document.getElementById("pageTitle");
  if (!accessButton || !settingsButton || !accessView || !settingsView) return;

  const labels = {
    pl: {permissions:"Uprawnienia",settings:"Ustawienia",my:"Twoje uprawnienia",users:"Użytkownicy",add:"Dodaj konto",roles:"Zakres ról",teams:"Zespoły",policy:"Polityka Portalu",simulate:"Symulacja dostępu",entraError:"Nie udało się wczytać konfiguracji Microsoft Entra."},
    en: {permissions:"Permissions",settings:"Settings",my:"Your permissions",users:"Users",add:"Add account",roles:"Role scope",teams:"Teams",policy:"Portal policy",simulate:"Access simulation",entraError:"Microsoft Entra configuration could not be loaded."}
  };
  function lang(){return document.documentElement.lang === "en" ? "en" : "pl";}
  function selectedLabels(){return labels[lang()];}

  accessButton.removeAttribute("data-i18n");
  const settingsPanels = settingsView.querySelector(".settings-panels");
  const accessPanels = accessView.querySelector(".settings-panels");
  const oldSettingsNav = settingsView.querySelector(".settings-tabs");
  const oldAccessNav = accessView.querySelector(".settings-tabs");
  const entraPanel = document.getElementById("settingsTabEntra");
  const panels = {
    my: settingsView.querySelector(".permissions-summary"),
    users: document.getElementById("settingsTabUsers"),
    add: document.getElementById("settingsTabAddUser"),
    roles: document.getElementById("settingsTabRoles"),
    teams: document.getElementById("accessTabTeams"),
    policy: document.getElementById("accessTabPortalPolicy"),
    simulate: document.getElementById("accessTabSimulate")
  };

  if (oldSettingsNav) {
    for (const button of oldSettingsNav.querySelectorAll("button")) {
      const isEntra = button.dataset.settingsTab === "entra";
      button.hidden = !isEntra;
      button.classList.toggle("active", isEntra);
    }
  }
  if (panels.my && panels.my.parentElement !== accessPanels) accessPanels.prepend(panels.my);
  for (const key of ["users","add","roles"]) {
    const panel = panels[key];
    if (panel && panel.parentElement !== accessPanels) accessPanels.insertBefore(panel, panels.teams || null);
  }

  const navigation = document.createElement("nav");
  navigation.className = "settings-tabs permissions-tabs";
  navigation.setAttribute("aria-label", "Permissions sections");
  let activeTab = "users";
  let openingPermissions = false;

  function showOnlyView(name) {
    if (portalsView) portalsView.hidden = name !== "portals";
    settingsView.hidden = name !== "settings";
    accessView.hidden = name !== "access";
    if (breakGlassView) breakGlassView.hidden = name !== "breakglass";
    if (backButton) backButton.hidden = name === "portals";
    if (pageTitle) pageTitle.textContent = name === "access" ? selectedLabels().permissions : selectedLabels().settings;
  }

  function showTab(name) {
    activeTab = panels[name] ? name : "users";
    for (const [key,panel] of Object.entries(panels)) if (panel) panel.hidden = key !== activeTab;
    if (entraPanel) entraPanel.hidden = true;
    for (const button of navigation.querySelectorAll("button")) button.classList.toggle("active", button.dataset.permissionsTab === activeTab);
  }

  for (const key of ["my","users","add","roles","teams","policy","simulate"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-tab";
    button.dataset.permissionsTab = key;
    button.addEventListener("click", function(){showTab(key);});
    navigation.append(button);
  }
  if (oldAccessNav) oldAccessNav.replaceWith(navigation); else accessView.prepend(navigation);

  function updateLabels() {
    const selected = selectedLabels();
    accessButton.textContent = selected.permissions;
    for (const button of navigation.querySelectorAll("button")) button.textContent = selected[button.dataset.permissionsTab];
    if (!accessView.hidden && pageTitle) pageTitle.textContent = selected.permissions;
    if (!settingsView.hidden && pageTitle) pageTitle.textContent = selected.settings;
  }

  function requestHeaders() {
    const headers = {"Content-Type":"application/json"};
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const access = params.get("access");
    if (access) headers.Authorization = "Bearer " + access;
    return headers;
  }

  async function loadEntraDirect() {
    const message = document.getElementById("entraMessage");
    try {
      const response = await fetch("/api/settings/identity-provider", {credentials:"same-origin", headers:requestHeaders(), cache:"no-store"});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || selectedLabels().entraError);
      const provider = result.provider || {};
      document.getElementById("entraEnabled").checked = Boolean(provider.enabled);
      document.getElementById("entraTenant").value = provider.tenant || "organizations";
      document.getElementById("entraClientId").value = provider.clientId || "";
      document.getElementById("entraClientSecret").value = "";
      document.getElementById("entraAllowedIdentities").value = (provider.allowedIdentities || []).join("\n");
      document.getElementById("entraRedirectUri").value = provider.redirectUri || "";
      document.getElementById("entraLogoutUrl").value = provider.logoutUrl || "";
      const status = document.getElementById("entraStatus");
      status.textContent = (provider.enabled ? "Aktywne" : "Wyłączone") + " · Client Secret: " + (provider.clientSecretConfigured ? "skonfigurowany" : "brak") + (provider.updatedAtUtc ? " · " + new Date(provider.updatedAtUtc).toLocaleString(lang()) : "");
      for (const id of ["entraEnabled","entraTenant","entraClientId","testEntraButton","saveEntraButton"]) document.getElementById(id).disabled = !result.editable;
      for (const id of ["entraClientSecret","entraAllowedIdentities"]) document.getElementById(id).disabled = !result.securityEditable;
      if (message && message.classList.contains("error")) message.textContent = "";
    } catch (error) {
      if (message) {
        message.textContent = error.message || selectedLabels().entraError;
        message.className = "error";
      }
      console.error("Unable to load Microsoft Entra settings", error);
    }
  }

  accessButton.addEventListener("click", async function (event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (openingPermissions) return;
    openingPermissions = true;
    accessButton.disabled = true;

    showOnlyView("access");
    showTab(activeTab);
    updateLabels();

    try {
      const tasks = [];
      if (typeof window.loadSettings === "function") tasks.push(window.loadSettings());
      if (typeof window.loadAccess === "function") tasks.push(window.loadAccess());
      await Promise.allSettled(tasks);
      showOnlyView("access");
      showTab(activeTab);
      updateLabels();
    } finally {
      accessButton.disabled = false;
      openingPermissions = false;
    }
  }, { capture: true });

  settingsButton.addEventListener("click", async function (event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    showOnlyView("settings");
    for (const panel of Object.values(panels)) if (panel) panel.hidden = true;
    if (entraPanel) entraPanel.hidden = false;
    if (oldSettingsNav) oldSettingsNav.hidden = false;
    updateLabels();
    await loadEntraDirect();
  }, { capture: true });

  for (const button of document.querySelectorAll("[data-lang]")) button.addEventListener("click", function(){window.setTimeout(updateLabels,0);});
  new MutationObserver(updateLabels).observe(document.documentElement,{attributes:true,attributeFilter:["lang"]});
  showTab("users");
  updateLabels();
})();
