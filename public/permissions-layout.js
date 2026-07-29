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
  const accessView = document.getElementById("accessView");
  const settingsView = document.getElementById("settingsView");
  const pageTitle = document.getElementById("pageTitle");
  if (!accessButton || !settingsButton || !accessView || !settingsView) return;

  const labels = {
    pl: {permissions:"Uprawnienia",settings:"Ustawienia",my:"Twoje uprawnienia",users:"Użytkownicy",add:"Dodaj konto",roles:"Zakres ról",teams:"Zespoły",policy:"Polityka Portalu",simulate:"Symulacja dostępu"},
    en: {permissions:"Permissions",settings:"Settings",my:"Your permissions",users:"Users",add:"Add account",roles:"Role scope",teams:"Teams",policy:"Portal policy",simulate:"Access simulation"}
  };
  function lang(){return document.documentElement.lang === "en" ? "en" : "pl";}

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

  if (oldSettingsNav) oldSettingsNav.remove();
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
    const selected = labels[lang()];
    accessButton.textContent = selected.permissions;
    for (const button of navigation.querySelectorAll("button")) button.textContent = selected[button.dataset.permissionsTab];
    if (!accessView.hidden && pageTitle) pageTitle.textContent = selected.permissions;
    if (!settingsView.hidden && pageTitle) pageTitle.textContent = selected.settings;
  }

  accessButton.addEventListener("click", async function (event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (openingPermissions) return;
    openingPermissions = true;
    accessButton.disabled = true;

    try {
      if (typeof window.loadSettings === "function") await window.loadSettings();
      if (typeof window.loadAccess === "function") await window.loadAccess();
      settingsView.hidden = true;
      accessView.hidden = false;
      showTab(activeTab);
      updateLabels();
    } catch (error) {
      console.error("Unable to open permissions view", error);
    } finally {
      accessButton.disabled = false;
      openingPermissions = false;
    }
  }, { capture: true });

  settingsButton.addEventListener("click", function () {
    window.setTimeout(function () {
      for (const panel of Object.values(panels)) if (panel) panel.hidden = true;
      if (entraPanel) entraPanel.hidden = false;
      settingsView.hidden = false;
      accessView.hidden = true;
      updateLabels();
    }, 0);
  });

  for (const button of document.querySelectorAll("[data-lang]")) button.addEventListener("click", function(){window.setTimeout(updateLabels,0);});
  new MutationObserver(updateLabels).observe(document.documentElement,{attributes:true,attributeFilter:["lang"]});
  showTab("users");
  updateLabels();
})();
