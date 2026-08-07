"use strict";

(function () {
  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) for (const [key, value] of Object.entries(attrs)) {
      if (key === "className") node.className = value;
      else if (key === "type") node.type = value;
      else node.setAttribute(key, value);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function checkbox(id, label) {
    const row = el("label", { className: "checkbox-row" });
    const input = el("input", { id, type: "checkbox" });
    row.append(input, el("span", null, label));
    return row;
  }

  function mount() {
    const tabs = document.querySelector("#settingsView .settings-tabs");
    const panels = document.querySelector("#settingsView .settings-panels");
    if (!tabs || !panels || document.getElementById("publicSiteTab")) return;

    const tab = el("button", { id: "publicSiteTab", type: "button", className: "settings-tab" }, "Website");
    const panel = el("section", { id: "settingsTabPublicSite", className: "settings-tab-panel" });
    panel.hidden = true;
    const card = el("article", { className: "settings-card" });
    card.append(
      el("h2", null, "Public site — sirkportal.com"),
      el("p", { className: "muted" }, "Publikowany jest wyłącznie sanitizowany snapshot read-only. Zmiany nie wymagają redeploy strony."),
      checkbox("publicDemoEnabled", "Demo enabled"),
      checkbox("publicDemoAvailable", "Demo available"),
      field("publicDemoCta", "Demo CTA URL", "url"),
      el("h3", null, "Sekcje"),
      checkbox("publicFeatureAgent", "Agent"),
      checkbox("publicFeaturePortal", "Portal"),
      checkbox("publicFeatureCentral", "Central"),
      checkbox("publicFeatureContact", "Contact"),
      checkbox("publicFeatureRegistration", "Registration"),
      el("h3", null, "Maintenance"),
      checkbox("publicMaintenanceEnabled", "Maintenance banner"),
      selectField("publicMaintenanceStatus", "Status", ["operational", "degraded", "maintenance"]),
      field("publicMaintenanceMessage", "Message", "text")
    );
    const actions = el("div", { className: "form-actions" });
    const refresh = el("button", { type: "button", className: "secondary" }, "Odśwież");
    const save = el("button", { type: "button" }, "Zapisz i opublikuj");
    const status = el("p", { id: "publicSiteStatus", className: "muted", role: "status" });
    actions.append(refresh, save);
    card.append(actions, status);
    panel.append(card);
    tabs.append(tab);
    panels.append(panel);

    tabs.addEventListener("click", event => {
      const clicked = event.target.closest("[data-settings-tab],#publicSiteTab");
      if (clicked && clicked !== tab) panel.hidden = true;
    }, true);

    tab.addEventListener("click", async () => {
      for (const button of tabs.querySelectorAll(".settings-tab")) button.classList.toggle("active", button === tab);
      for (const item of panels.querySelectorAll(":scope > .settings-tab-panel")) item.hidden = item !== panel;
      await load();
    });
    refresh.addEventListener("click", load);
    save.addEventListener("click", saveSettings);
  }

  function field(id, label, type) {
    const wrapper = el("label");
    wrapper.append(el("span", null, label), el("input", { id, type }));
    return wrapper;
  }

  function selectField(id, label, values) {
    const wrapper = el("label");
    const select = el("select", { id });
    for (const value of values) select.append(el("option", { value }, value));
    wrapper.append(el("span", null, label), select);
    return wrapper;
  }

  function checked(id) { return document.getElementById(id).checked; }
  function value(id) { return document.getElementById(id).value.trim(); }
  function setChecked(id, value) { document.getElementById(id).checked = Boolean(value); }
  function setValue(id, value) { document.getElementById(id).value = value || ""; }

  async function load() {
    const status = document.getElementById("publicSiteStatus");
    try {
      const result = await api("/api/v1/settings/public-site/");
      const settings = result.settings;
      setChecked("publicDemoEnabled", settings.demo.enabled);
      setChecked("publicDemoAvailable", settings.demo.available);
      setValue("publicDemoCta", settings.demo.ctaUrl);
      for (const key of ["Agent", "Portal", "Central", "Contact", "Registration"])
        setChecked("publicFeature" + key, settings.features[key.toLowerCase()]);
      setChecked("publicMaintenanceEnabled", settings.maintenance.enabled);
      setValue("publicMaintenanceStatus", settings.maintenance.status);
      setValue("publicMaintenanceMessage", settings.maintenance.message);
      status.className = result.lastPublishError ? "error" : "muted";
      status.textContent = `revision ${settings.revision} · snapshot ${result.snapshotPublished ? "published" : "not published"}` +
        (result.lastPublishError ? ` · ${result.lastPublishError}` : "");
    } catch (error) {
      status.className = "error";
      status.textContent = error.message;
    }
  }

  async function saveSettings() {
    const status = document.getElementById("publicSiteStatus");
    status.className = "muted";
    status.textContent = "Publikowanie...";
    try {
      const result = await api("/api/v1/settings/public-site/", {
        method: "PUT",
        body: JSON.stringify({
          demo: { enabled: checked("publicDemoEnabled"), available: checked("publicDemoAvailable"), ctaUrl: value("publicDemoCta") || null },
          features: {
            agent: checked("publicFeatureAgent"), portal: checked("publicFeaturePortal"),
            central: checked("publicFeatureCentral"), contact: checked("publicFeatureContact"),
            registration: checked("publicFeatureRegistration")
          },
          maintenance: {
            enabled: checked("publicMaintenanceEnabled"), status: value("publicMaintenanceStatus"),
            message: value("publicMaintenanceMessage") || null
          }
        })
      });
      status.className = "success";
      status.textContent = `Opublikowano revision ${result.settings.revision}.`;
    } catch (error) {
      status.className = "error";
      status.textContent = error.message;
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}());
