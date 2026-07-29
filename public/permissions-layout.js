"use strict";

(function () {
  const accessButton = document.getElementById("accessButton");
  const settingsButton = document.getElementById("settingsButton");
  const accessView = document.getElementById("accessView");
  const settingsView = document.getElementById("settingsView");
  const settingsPanels = settingsView.querySelector(".settings-panels");
  const accessPanels = accessView.querySelector(".settings-panels");
  const oldSettingsNav = settingsView.querySelector(".settings-tabs");
  const oldAccessNav = accessView.querySelector(".settings-tabs");
  const permissionsSummary = settingsView.querySelector(".permissions-summary");

  const labels = {
    pl: {
      permissions: "Uprawnienia",
      my: "Twoje uprawnienia",
      users: "Użytkownicy",
      add: "Dodaj konto",
      roles: "Zakres ról",
      teams: "Zespoły",
      policy: "Polityka Portalu",
      simulate: "Symulacja dostępu"
    },
    en: {
      permissions: "Permissions",
      my: "Your permissions",
      users: "Users",
      add: "Add account",
      roles: "Role scope",
      teams: "Teams",
      policy: "Portal policy",
      simulate: "Access simulation"
    }
  };

  function currentLanguage() {
    return document.documentElement.lang === "en" ? "en" : "pl";
  }

  const panels = {
    my: permissionsSummary,
    users: document.getElementById("settingsTabUsers"),
    add: document.getElementById("settingsTabAddUser"),
    roles: document.getElementById("settingsTabRoles"),
    teams: document.getElementById("accessTabTeams"),
    policy: document.getElementById("accessTabPortalPolicy"),
    simulate: document.getElementById("accessTabSimulate")
  };

  const navigation = document.createElement("nav");
  navigation.className = "settings-tabs permissions-tabs";
  navigation.setAttribute("aria-label", "Permissions sections");

  let activeTab = "users";

  function showTab(name) {
    activeTab = panels[name] ? name : "users";
    for (const [key, panel] of Object.entries(panels)) {
      if (panel) panel.hidden = key !== activeTab;
    }
    for (const button of navigation.querySelectorAll("button")) {
      button.classList.toggle("active", button.dataset.permissionsTab === activeTab);
    }
  }

  function updateLabels() {
    const lang = currentLanguage();
    accessButton.textContent = labels[lang].permissions;
    for (const button of navigation.querySelectorAll("button")) {
      button.textContent = labels[lang][button.dataset.labelKey];
    }
  }

  for (const item of [
    ["my", "my"],
    ["users", "users"],
    ["add", "add"],
    ["roles", "roles"],
    ["teams", "teams"],
    ["policy", "policy"],
    ["simulate", "simulate"]
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-tab";
    button.dataset.permissionsTab = item[0];
    button.dataset.labelKey = item[1];
    button.addEventListener("click", () => showTab(item[0]));
    navigation.append(button);
  }

  accessButton.removeAttribute("data-i18n");
  oldAccessNav.replaceWith(navigation);
  oldSettingsNav.remove();

  accessPanels.prepend(permissionsSummary);
  for (const id of ["settingsTabUsers", "settingsTabAddUser", "settingsTabRoles"]) {
    accessPanels.insertBefore(document.getElementById(id), document.getElementById("accessTabTeams"));
  }

  settingsPanels.querySelector("#settingsTabEntra").hidden = false;
  showTab("users");
  updateLabels();

  accessButton.addEventListener("click", async () => {
    try {
      if (typeof window.loadSettings === "function") await window.loadSettings();
    } finally {
      settingsView.hidden = true;
      accessView.hidden = false;
      showTab(activeTab);
      document.getElementById("pageTitle").textContent = labels[currentLanguage()].permissions;
      updateLabels();
    }
  });

  settingsButton.addEventListener("click", () => {
    window.setTimeout(() => {
      const entra = document.getElementById("settingsTabEntra");
      entra.hidden = false;
      document.getElementById("pageTitle").textContent = currentLanguage() === "en" ? "Settings" : "Ustawienia";
    }, 0);
  });

  for (const button of document.querySelectorAll("[data-lang]")) {
    button.addEventListener("click", () => window.setTimeout(updateLabels, 0));
  }

  const observer = new MutationObserver(updateLabels);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
})();
