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
  function number(id) { return Number.parseInt(value(id), 10); }
  function setChecked(id, value) { document.getElementById(id).checked = Boolean(value); }
  function setValue(id, value) { document.getElementById(id).value = value ?? ""; }

  function mount() {
    const tabs = document.querySelector("#settingsView .settings-tabs");
    const panels = document.querySelector("#settingsView .settings-panels");
    if (!tabs || !panels || document.getElementById("publicSiteTab")) return;

    const tab = el("button", { id: "publicSiteTab", type: "button", className: "settings-tab" }, "Website / Demo");
    const panel = el("section", { id: "settingsTabPublicSite", className: "settings-tab-panel" });
    panel.hidden = true;

    const publicCard = el("article", { className: "settings-card" });
    publicCard.append(
      el("h2", null, "Public site — sirkportal.com"),
      el("p", { className: "muted" }, "Publikowany jest wyłącznie sanitizowany snapshot read-only. Zmiany nie wymagają redeploy strony."),
      checkbox("publicDemoEnabled", "Public Demo CTA enabled"),
      checkbox("publicDemoAvailable", "Public Demo CTA available"),
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
    const publicActions = el("div", { className: "form-actions" });
    const publicRefresh = el("button", { type: "button", className: "secondary" }, "Odśwież");
    const publicSave = el("button", { type: "button" }, "Zapisz i opublikuj");
    const publicStatus = el("p", { id: "publicSiteStatus", className: "muted", role: "status" });
    publicActions.append(publicRefresh, publicSave);
    publicCard.append(publicActions, publicStatus);

    const demoCard = el("article", { className: "settings-card" });
    demoCard.append(
      el("h2", null, "Ephemeral Portal Demo"),
      el("p", { className: "muted" }, "Isolated per-visitor Portal containers. Docker socket remains only in the dedicated orchestrator."),
      checkbox("demoEnabled", "Demo enabled"),
      field("demoVersion", "Portal Demo version (0.1.1.X)", "text"),
      field("demoMaxSessions", "Max sessions", "number"),
      field("demoIdleTtl", "Idle TTL (minutes)", "number"),
      field("demoAbsoluteTtl", "Absolute TTL (minutes)", "number"),
      checkbox("demoMaintenance", "Maintenance / drain new sessions")
    );
    const demoActions = el("div", { className: "form-actions" });
    const demoRefresh = el("button", { type: "button", className: "secondary" }, "Odśwież status");
    const demoDrain = el("button", { type: "button", className: "secondary" }, "Drain");
    const demoSave = el("button", { type: "button" }, "Zastosuj Demo");
    const demoStatus = el("p", { id: "demoRuntimeStatus", className: "muted", role: "status" });
    demoActions.append(demoRefresh, demoDrain, demoSave);
    demoCard.append(demoActions, demoStatus);

    panel.append(publicCard, demoCard);
    tabs.append(tab);
    panels.append(panel);

    tabs.addEventListener("click", event => {
      const clicked = event.target.closest("[data-settings-tab],#publicSiteTab");
      if (clicked && clicked !== tab) panel.hidden = true;
    }, true);

    tab.addEventListener("click", async () => {
      for (const button of tabs.querySelectorAll(".settings-tab")) button.classList.toggle("active", button === tab);
      for (const item of panels.querySelectorAll(":scope > .settings-tab-panel")) item.hidden = item !== panel;
      await Promise.all([loadPublic(), loadDemo()]);
    });
    publicRefresh.addEventListener("click", loadPublic);
    publicSave.addEventListener("click", savePublic);
    demoRefresh.addEventListener("click", loadDemo);
    demoSave.addEventListener("click", saveDemo);
    demoDrain.addEventListener("click", drainDemo);
  }

  async function loadPublic() {
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

  async function savePublic() {
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

  async function loadDemo() {
    const status = document.getElementById("demoRuntimeStatus");
    try {
      const result = await api("/api/v1/demo/settings");
      const settings = result.settings;
      setChecked("demoEnabled", settings.enabled);
      setValue("demoVersion", settings.desiredVersion);
      setValue("demoMaxSessions", settings.maxSessions);
      setValue("demoIdleTtl", settings.idleTtlMinutes);
      setValue("demoAbsoluteTtl", settings.absoluteTtlMinutes);
      setChecked("demoMaintenance", settings.maintenance);
      const runtime = result.runtime;
      const active = runtime && Number.isInteger(runtime.activeSessions) ? runtime.activeSessions : "?";
      const capacity = runtime && runtime.capacityAvailable === true ? "available" : "unavailable";
      status.className = result.runtimeError ? "error" : "muted";
      status.textContent = result.runtimeError ? result.runtimeError : `active sessions ${active} · capacity ${capacity}`;
    } catch (error) {
      status.className = "error";
      status.textContent = error.message;
    }
  }

  async function saveDemo() {
    const status = document.getElementById("demoRuntimeStatus");
    status.className = "muted";
    status.textContent = "Applying...";
    try {
      const result = await api("/api/v1/demo/settings", {
        method: "PUT",
        body: JSON.stringify({
          enabled: checked("demoEnabled"),
          desiredVersion: value("demoVersion"),
          maxSessions: number("demoMaxSessions"),
          idleTtlMinutes: number("demoIdleTtl"),
          absoluteTtlMinutes: number("demoAbsoluteTtl"),
          maintenance: checked("demoMaintenance")
        })
      });
      status.className = "success";
      status.textContent = `Demo ${result.settings.enabled ? "enabled" : "disabled"} · ${result.settings.desiredVersion}`;
      await loadPublic();
    } catch (error) {
      status.className = "error";
      status.textContent = error.message;
    }
  }

  async function drainDemo() {
    const status = document.getElementById("demoRuntimeStatus");
    status.className = "muted";
    status.textContent = "Draining...";
    try {
      await api("/api/v1/demo/drain", { method: "POST", body: "{}" });
      setChecked("demoMaintenance", true);
      status.className = "success";
      status.textContent = "Drain enabled; no new Demo sessions will be admitted.";
      await loadPublic();
    } catch (error) {
      status.className = "error";
      status.textContent = error.message;
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}());
