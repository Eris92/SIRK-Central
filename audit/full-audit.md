# Full product audit

Repository: `Eris92/SIRK-Central`
Commit: `9455dacec4bc60bdef827f9bf6500de09e1104d2`

## Summary

```json
{
  "files": 281,
  "textFiles": 270,
  "lines": 29424,
  "extensions": {
    ".conf": 1,
    ".css": 10,
    ".example": 1,
    ".gateway": 1,
    ".html": 4,
    ".js": 211,
    ".json": 2,
    ".manager": 1,
    ".md": 13,
    ".py": 2,
    ".sh": 20,
    ".svg": 1,
    ".yml": 7,
    "<none>": 7
  },
  "projects": 0,
  "nodeArtifacts": 2,
  "legacyPaths": 0,
  "findingsBySeverity": {
    "critical": 0,
    "high": 10,
    "medium": 128,
    "low": 0,
    "info": 5
  }
}
```

## Highest severity findings

- **HIGH** `hardcoded-secret-like-value` — `deploy/appliance-install.sh:33` — PASSWORD="$(read_secret 'Break-Glass password: ')"
- **HIGH** `hardcoded-secret-like-value` — `public/app.js:10` — change_breakglass_password:"Zmień hasło Break-Glass", current_password:"Aktualne hasło", new_password:"Nowe hasło", confirm_new_password:"Powtórz nowe hasło", change_password:"Zmień hasło", access_rotation:"Rotacja access code", old_link_stops:"Poprzedni link przestanie działać natychmiast.", genera
- **HIGH** `hardcoded-secret-like-value` — `public/app.js:11` — connect:"Połącz", pending:"Pending", local:"lokalne", choose_role:"Wybierz rolę", active:"Aktywne", disabled:"Wyłączone", configured:"skonfigurowany", missing:"brak", updated:"aktualizacja", security_full:"Możesz zmieniać Client Secret i listę dozwolonych kont.", security_admin:"Jako Admin możesz zm
- **HIGH** `hardcoded-secret-like-value` — `public/app.js:15` — login_intro:"Sign in with your Microsoft Entra organisational account.", login_microsoft:"Sign in with Microsoft", local_login:"local sign-in", username:"Username", password:"Password", login_local:"Sign in locally",
- **HIGH** `hardcoded-secret-like-value` — `public/app.js:20` — change_breakglass_password:"Change Break-Glass password", current_password:"Current password", new_password:"New password", confirm_new_password:"Confirm new password", change_password:"Change password", access_rotation:"Access code rotation", old_link_stops:"The previous link will stop working imme
- **HIGH** `hardcoded-secret-like-value` — `public/app.js:21` — connect:"Connect", pending:"Pending", local:"local", choose_role:"Choose role", active:"Active", disabled:"Disabled", configured:"configured", missing:"missing", updated:"updated", security_full:"You can change the Client Secret and allowed-account list.", security_admin:"As Admin, you can change Te
- **HIGH** `hardcoded-secret-like-value` — `public/backup-age-ui.js:9` — currentPassword: "Aktualne hasło Break-Glass",
- **HIGH** `hardcoded-secret-like-value` — `public/backup-age-ui.js:29` — currentPassword: "Current Break-Glass password",
- **HIGH** `hardcoded-secret-like-value` — `public/portal-enrollment.js:9` — newToken: "Nowy token enrollment", label: "Opis", ttl: "Ważność (minuty)", generate: "Generuj token",
- **HIGH** `hardcoded-secret-like-value` — `public/portal-enrollment.js:20` — newToken: "New enrollment token", label: "Label", ttl: "Validity (minutes)", generate: "Generate token",
- **MEDIUM** `plaintext-http-url` — `.github/workflows/ci.yml:86` — 'SIRK_UPDATER_ORIGIN: http://updater-gateway:8092',
- **MEDIUM** `plaintext-http-url` — `.github/workflows/ci.yml:91` — 'SIRK_CENTRAL_INTERNAL_ORIGIN: http://central:8080'
- **MEDIUM** `plaintext-http-url` — `.github/workflows/ci.yml:148` — if (compose.services.central.environment.SIRK_UPDATER_ORIGIN !== 'http://updater-gateway:8092') throw new Error('Central bypasses gateway.');
- **MEDIUM** `plaintext-http-url` — `.github/workflows/ci.yml:149` — if (compose.services['updater-gateway'].environment.SIRK_UPDATER_WORKER_ORIGIN !== 'http://updater:8090') throw new Error('Gateway worker origin is invalid.');
- **MEDIUM** `plaintext-http-url` — `.github/workflows/security-audit.yml:130` — 'SIRK_UPDATER_ORIGIN: http://updater-gateway:8092',
- **MEDIUM** `plaintext-http-url` — `auth/server.js:251` — const url = new URL(req.url, "http://auth.local");
- **MEDIUM** `plaintext-http-url` — `deploy/acceptance-test.sh:120` — 'SIRK_UPDATER_ORIGIN: http://updater-gateway:8092',
- **MEDIUM** `plaintext-http-url` — `deploy/acceptance-test.sh:147` — if (compose.services.central.environment.SIRK_UPDATER_ORIGIN !== 'http://updater-gateway:8092') throw new Error('Central bypasses updater gateway.');
- **MEDIUM** `plaintext-http-url` — `deploy/acceptance-test.sh:209` — docker exec "$auth_id" node -e "fetch('http://central:8080/auth/sso/frontchannel-logout',{method:'POST'}).then(r=>{if(r.status!==401)throw new Error('Expected 401, got '+r.status)}).catch(e=>{console.error(e);process.exit(1)})"
- **MEDIUM** `plaintext-http-url` — `docker-compose.yml:11` — SIRK_UPDATER_ORIGIN: http://updater-gateway:8092
- **MEDIUM** `plaintext-http-url` — `docker-compose.yml:13` — SIRK_BACKUP_MANAGER_ORIGIN: http://backup-manager:8091
- **MEDIUM** `plaintext-http-url` — `docker-compose.yml:43` — SIRK_CENTRAL_INTERNAL_ORIGIN: http://central:8080
- **MEDIUM** `plaintext-http-url` — `docker-compose.yml:70` — SIRK_UPDATER_WORKER_ORIGIN: http://updater:8090
- **MEDIUM** `dynamic-innerhtml` — `public/admin-tools-ui.js:39` — card.innerHTML = `
- **MEDIUM** `dynamic-innerhtml` — `public/admin-tools-ui.js:138` — actions.innerHTML = `<a id="auditExportCsv"></a><a id="auditExportJson"></a>`;
- **MEDIUM** `dynamic-innerhtml` — `public/admin-tools-ui.js:161` — card.innerHTML = `<h2 id="systemVersionTitle"></h2><div class="system-version-grid"><div><small id="systemVersionLabel"></small><strong id="systemVersionValue">—</strong></div><div><small>Runtime</small><strong id="systemRuntimeValue">—</strong></div><div><small>Node.js</small><strong id="systemNode
- **MEDIUM** `dynamic-innerhtml` — `public/admin-tools-ui.js:188` — card.innerHTML = `<div class="toolbar"><div><h2 id="alertCenterTitle"></h2><p id="alertCenterHelp" class="muted"></p></div><button id="alertCenterRefresh" type="button" class="secondary"></button></div><div id="alertCenter" class="alert-center"></div>`;
- **MEDIUM** `incomplete-implementation` — `public/app.js:29` — function applyLanguage(lang){currentLang=lang==="en"?"en":"pl";document.documentElement.lang=currentLang;document.cookie=`sirk_lang=${currentLang}; Path=/; Domain=.sirkportal.com; Max-Age=31536000; SameSite=Lax; Secure`;for(const el of document.querySelectorAll("[data-i18n]"))el.textContent=t(el.dat
- **MEDIUM** `dynamic-innerhtml` — `public/app.js:45` — async function loadUsers(){const result=await api("/api/settings/users"),list=document.getElementById("usersList");list.replaceChildren(...result.users.map(user=>{const row=document.createElement("div");row.className="user-row";const label=document.createElement("div");label.innerHTML="<strong></str
- **MEDIUM** `incomplete-implementation` — `public/app.js:45` — async function loadUsers(){const result=await api("/api/settings/users"),list=document.getElementById("usersList");list.replaceChildren(...result.users.map(user=>{const row=document.createElement("div");row.className="user-row";const label=document.createElement("div");label.innerHTML="<strong></str
- **MEDIUM** `dynamic-innerhtml` — `public/app.js:55` — function renderTeamList(){const list=document.getElementById("teamsList");if(!accessData.teams.length){list.textContent=t("no_teams");return;}list.replaceChildren(...accessData.teams.map(team=>{const row=document.createElement("div");row.className="team-row";const info=document.createElement("div");
- **MEDIUM** `dynamic-innerhtml` — `public/appliance-system-ui.js:122` — panel.innerHTML = `
- **MEDIUM** `dynamic-innerhtml` — `public/approval-center-ui.js:51` — view.innerHTML = `
- **MEDIUM** `dynamic-innerhtml` — `public/backup-age-ui.js:173` — card.innerHTML = [
- **MEDIUM** `dynamic-innerhtml` — `public/break-glass-mfa.js:75` — article.innerHTML = [
- **MEDIUM** `dynamic-innerhtml` — `public/central-ux.js:116` — section.innerHTML = '<div class="mark">S</div><p class="eyebrow">SIRK Central</p><h1 data-pending-title></h1><p class="muted" data-pending-description></p><p class="muted" data-pending-account></p><div class="form-actions"><button type="button" data-pending-refresh></button><button type="button" cla
- **MEDIUM** `dynamic-innerhtml` — `public/central-ux.js:156` — updatePanel.innerHTML = '<article class="settings-card"><h2 data-updates-title></h2><p class="muted" data-update-status></p><div class="form-actions"><button type="button" data-update-refresh></button><button type="button" data-update-run></button></div><p class="error" data-update-message></p></art
- **MEDIUM** `dynamic-innerhtml` — `public/central-ux.js:162` — backupPanel.innerHTML = '<article class="settings-card"><h2 data-backup-title></h2><p class="muted" data-backup-help></p><div class="form-actions"><button type="button" data-backup-refresh></button><button type="button" data-backup-run></button></div><div class="users-list" data-backup-list></div><p
- **MEDIUM** `dynamic-innerhtml` — `public/central-ux.js:201` — const info = document.createElement("div"); info.innerHTML = "<strong></strong><small></small>";
- **MEDIUM** `dynamic-innerhtml` — `public/dashboard-ui.js:62` — view.innerHTML = `
- **MEDIUM** `incomplete-implementation` — `public/index.html:7` — <section id="portalsView"><div class="toolbar"><div><strong id="onlineCount">0</strong><span> online</span></div><button id="showCreateButton" hidden data-i18n="add_portal">Dodaj Portal</button></div><form id="createForm" class="create-form" hidden><label><span data-i18n="identifier">Identyfikator</
- **MEDIUM** `incomplete-implementation` — `public/index.html:12` — <section id="settingsTabEntra" class="settings-tab-panel" hidden><article id="entraCard" class="settings-card"><h2>Microsoft Entra</h2><p id="entraStatus" class="muted"></p><form id="entraForm" class="stack-form"><label class="checkbox-row"><input id="entraEnabled" type="checkbox"><span data-i18n="e
- **MEDIUM** `local-storage` — `public/operations-actions.js:94` — const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
- **MEDIUM** `local-storage` — `public/operations-actions.js:110` — localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 10)));
- **MEDIUM** `dynamic-innerhtml` — `public/operations-actions.js:147` — overview.innerHTML = `
- **MEDIUM** `dynamic-innerhtml` — `public/operations-actions.js:169` — card.innerHTML = `<h2 id="updateHistoryTitle"></h2><div id="updateHistory" class="users-list"></div>`;
- **MEDIUM** `dynamic-innerhtml` — `public/operations-bootstrap.js:85` — updatesPanel.innerHTML = '<article class="settings-card"><h2 id="updatesTitle"></h2><p id="updateHelp" class="muted"></p><p id="updateStatus" class="muted"></p><div class="form-actions"><button type="button" class="secondary" id="refreshUpdateButton"></button><button type="button" id="runUpdateButto
- **MEDIUM** `dynamic-innerhtml` — `public/operations-bootstrap.js:95` — backupPanel.innerHTML = '<article class="settings-card"><h2 id="backupTitle"></h2><p id="backupHelp" class="muted"></p><div class="form-actions"><button type="button" class="secondary" id="refreshBackupButton"></button><button type="button" id="runBackupButton"></button></div><p id="restoreStatus" c
- **MEDIUM** `dynamic-innerhtml` — `public/operations-ui.js:41` — updatesPanel.innerHTML = `
- **MEDIUM** `dynamic-innerhtml` — `public/operations-ui.js:57` — backupPanel.innerHTML = `
- **MEDIUM** `dynamic-innerhtml` — `public/operations-ui.js:160` — info.innerHTML = "<strong></strong><small></small>";
- **MEDIUM** `dynamic-innerhtml` — `public/passkey-ui.js:290` — article.innerHTML = '<h2>YubiKey / WebAuthn</h2><p class="muted" data-passkey-status></p><div class="users-list" data-passkey-list></div><div class="form-actions"><button type="button" data-passkey-register></button><button type="button" class="secondary" data-passkey-refresh></button></div><p class
- **MEDIUM** `dynamic-innerhtml` — `public/passkey-ui.js:314` — info.innerHTML = "<strong></strong><small></small>";
- **MEDIUM** `dynamic-innerhtml` — `public/permissions-layout.js:33` — const securityView=document.createElement("section");securityView.id="securityView";securityView.hidden=true;securityView.innerHTML='<nav class="settings-tabs security-tabs"></nav><div class="settings-panels security-panels"></div>';
- **MEDIUM** `dynamic-innerhtml` — `public/permissions-layout.js:52` — function renderApprovals(panel){const list=document.createElement("div");list.className="users-list";const items=securityData.pendingRoles||[];if(!items.length)list.append(emptyMessage(lang()==="pl"?"Brak oczekujących ról uprzywilejowanych.":"No privileged roles are pending."));for(const user of ite
- **MEDIUM** `dynamic-innerhtml` — `public/permissions-layout.js:53` — function renderSessions(panel){const wrap=document.createElement("div"),top=document.createElement("div");top.className="form-actions security-actions";top.append(actionButton(lang()==="pl"?"Unieważnij pozostałe sesje":"Revoke other sessions",async()=>{if(!confirm(lang()==="pl"?"Unieważnić wszystkie
- **MEDIUM** `dynamic-innerhtml` — `public/permissions-layout.js:55` — function renderBreakGlass(panel){const status=securityData.breakGlass||{},grid=document.createElement("div");grid.className="security-facts";for(const[label,value]of[[lang()==="pl"?"Ostatnie użycie":"Last use",date(status.lastUsedAtUtc)],["IP",text(status.lastUsedIp)],[lang()==="pl"?"Ostatnia rotacj
- **MEDIUM** `dynamic-innerhtml` — `public/permissions-layout.js:56` — function renderPolicies(panel){const p=securityData.policies||{},form=document.createElement("form");form.className="stack-form security-policy-form";form.innerHTML='<label>Session hours<input name="sessionHours" type="number" min="1" max="24"></label><label class="checkbox-row"><input name="require
- **MEDIUM** `dynamic-innerhtml` — `public/permissions-layout.js:57` — function renderAudit(panel){const list=document.createElement("div");list.className="audit-list";for(const event of securityData.audit||[]){const row=document.createElement("div");row.className="audit-row";row.innerHTML="<strong></strong><span></span><code></code>";row.querySelector("strong").textCo
- **MEDIUM** `dynamic-innerhtml` — `public/permissions-layout.js:58` — function renderIncidents(panel){const form=document.createElement("form");form.className="stack-form incident-form";form.innerHTML='<label>Title<input name="title" required maxlength="160"></label><label>Severity<select name="severity"><option value="low">Low</option><option value="medium" selected>
- **MEDIUM** `local-storage` — `public/portal-enrollment.js:4` — var language = localStorage.getItem("sirk-language") === "en" ? "en" : "pl";
- **MEDIUM** `local-storage` — `public/portal-enrollment.js:164` — localStorage.setItem("sirk-language", language);
- **MEDIUM** `dynamic-innerhtml` — `public/portal-operations-ui.js:30` — view.innerHTML = `
- **MEDIUM** `incomplete-implementation` — `public/portal-operations-ui.js:46` — <label><span id="portalCommandApprovalLabel"></span><input id="portalCommandApproval" placeholder="apr-..."></label>
- **MEDIUM** `incomplete-implementation` — `public/portal-operations-ui.js:48` — <label><span id="portalCommandPayloadLabel"></span><textarea id="portalCommandPayload" rows="5" placeholder='{"key":"value"}'></textarea></label>
- **MEDIUM** `incomplete-implementation` — `public/portal-update-command-ui.js:8` — function createField(id, labelText, type, placeholder) {
- **MEDIUM** `incomplete-implementation` — `public/portal-update-command-ui.js:17` — input.placeholder = placeholder || "";
- **MEDIUM** `dynamic-innerhtml` — `public/portal-update-command-ui.js:51` — channel.innerHTML = '<option value="dev">Dev / prerelease</option><option value="stable">Stable</option>';
- **MEDIUM** `dynamic-innerhtml` — `public/security-sessions-ui.js:40` — card.innerHTML = `
- **MEDIUM** `dynamic-innerhtml` — `public/tickets-ui.js:15` — view.innerHTML = '<div class="page-header"><div><h1>' + t("Zgłoszenia", "Tickets") + '</h1><p class="muted">' + t("Zagregowane zgłoszenia opublikowane przez Portale.", "Aggregated tickets published by Portals.") + '</p></div><button id="ticketsRefresh" type="button">' + t("Odśwież", "Refresh") + '</
- **MEDIUM** `incomplete-implementation` — `public/tickets-ui.js:17` — '<div class="ticket-filters"><input id="ticketSearch" type="search" placeholder="' + t("Szukaj...", "Search...") + '"><select id="ticketStatus"><option value="">' + t("Wszystkie statusy", "All statuses") + '</option></select><select id="ticketPriority"><option value="">' + t("Wszystkie priorytety", 
- **MEDIUM** `dynamic-innerhtml` — `public/tickets-ui.js:30` — target.innerHTML = cards.map(item => '<article><strong>' + item[1] + '</strong><span>' + item[0] + '</span></article>').join("");
- **MEDIUM** `dynamic-innerhtml` — `public/tickets-ui.js:35` — if (!items.length) { list.innerHTML = '<div class="empty">' + t("Brak zgłoszeń spełniających filtry.", "No tickets match the filters.") + '</div>'; return; }
- **MEDIUM** `dynamic-innerhtml` — `public/tickets-ui.js:36` — list.innerHTML = items.map(item => '<article class="ticket-card" data-portal="' + escapeHtml(item.portalId) + '" data-ticket="' + escapeHtml(item.ticketId) + '"><div class="ticket-card-head"><div><code>' + escapeHtml(item.ticketId) + '</code><h3>' + escapeHtml(item.title) + '</h3></div><div>' + badg
- **MEDIUM** `plaintext-http-url` — `src/application.js:204` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/application.js:394` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/administration.js:20` — const value = String(config.env.SIRK_BACKUP_MANAGER_ORIGIN || "http://backup-manager:8091").replace(/\/+$/, "");
- **MEDIUM** `plaintext-http-url` — `src/modules/administration.js:68` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/appliance-management.js:110` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/approvals.js:92` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/auth-hardening.js:88` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/backup-age-key-management.js:133` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/break-glass-ui.js:26` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/canonical-login-route.js:25` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/continuity.js:42` — const value = String(config.env.SIRK_UPDATER_ORIGIN || "http://updater:8090").replace(/\/+$/, "");
- **MEDIUM** `plaintext-http-url` — `src/modules/continuity.js:119` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/maintenance.js:13` — const origin = String(config.env.SIRK_UPDATER_ORIGIN || "http://updater:8090").replace(/\/+$/, "");
- **MEDIUM** `plaintext-http-url` — `src/modules/maintenance.js:29` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/passkey-management.js:18` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/portal-bootstrap.js:57` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/portal-commands.js:130` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/portal-connection-admin.js:83` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/portal-enrollment-ui.js:38` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/portal-enrollment.js:77` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/portal-release-catalog.js:104` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/portal-telemetry.js:15` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/portal-tunnel.js:125` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/security-api.js:55` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/tickets.js:169` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/ui-assets.js:23` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/webauthn-attestation.js:36` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/webauthn-authentication.js:71` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/modules/workspace-authorization.js:54` — const url = new URL(req.url, "http://central.local");
- **MEDIUM** `plaintext-http-url` — `src/portal-upgrade-guard.js:51` — try { url = new URL(req.url, "http://central.local"); }
- **MEDIUM** `plaintext-http-url` — `test/appliance-diagnostics-contract.test.js:32` — SIRK_UPDATER_ORIGIN: "http://updater-gateway:8092",
- **MEDIUM** `plaintext-http-url` — `test/appliance-diagnostics-contract.test.js:34` — } }), "http://updater-gateway:8092");
- **MEDIUM** `plaintext-http-url` — `test/appliance-diagnostics-contract.test.js:36` — SIRK_UPDATER_ORIGIN: "http://169.254.169.254/latest",
- **MEDIUM** `plaintext-http-url` — `test/auth-broker.test.js:31` — env.SIRK_AUTH_ORIGIN = "http://auth.local";
- **MEDIUM** `plaintext-http-url` — `test/portal-bootstrap.test.js:8` — () => publicOrigin({ publicOrigin: "http://central.example", env: {} }),
- **MEDIUM** `plaintext-http-url` — `test/portal-connection-self-service.test.js:43` — const handled = await handleSelfService(app, config, req, res, new URL(url, "http://central.local"));
- **MEDIUM** `plaintext-http-url` — `test/portal-telemetry-store.test.js:70` — memoryTotalBytes: 100, memoryUsedBytes: 200, publicUrl: "http://user:pass@internal.example/",
- **MEDIUM** `plaintext-http-url` — `test/protocol-concurrency.test.js:25` — SIRK_UPDATER_ORIGIN: "http://updater:8090",
- **MEDIUM** `plaintext-http-url` — `test/protocol-http.test.js:29` — SIRK_UPDATER_ORIGIN: "http://updater:8090",
- **MEDIUM** `plaintext-http-url` — `test/sso-frontchannel-logout.test.js:35` — SIRK_CENTRAL_INTERNAL_ORIGIN: "http://central:8080"
- **MEDIUM** `plaintext-http-url` — `test/sso-frontchannel-logout.test.js:62` — assert.equal(auth.internalCentralOrigin(config("/tmp/test")), "http://central:8080");
- **MEDIUM** `plaintext-http-url` — `test/sso-frontchannel-logout.test.js:64` — assert.throws(() => auth.internalCentralOrigin({ centralOrigin: CENTRAL_ORIGIN, env: { SIRK_CENTRAL_INTERNAL_ORIGIN: "http://user:pass@central:8080" } }), /must be an HTTP/i);
- **MEDIUM** `plaintext-http-url` — `test/sso-frontchannel-logout.test.js:78` — assert.equal(captured.url, "http://central:8080/auth/sso/frontchannel-logout");
- **MEDIUM** `plaintext-http-url` — `test/ticket-event-http-semantics.test.js:21` — SIRK_UPDATER_ORIGIN: "http://updater:8090",
- **MEDIUM** `plaintext-http-url` — `test/updater-client-security.test.js:43` — SIRK_UPDATER_ORIGIN: "http://updater-gateway:8092",
- **MEDIUM** `plaintext-http-url` — `test/updater-client-security.test.js:45` — } }), "http://updater-gateway:8092");
- **MEDIUM** `plaintext-http-url` — `test/updater-client-security.test.js:47` — SIRK_UPDATER_ORIGIN: "http://updater:8090",
- **MEDIUM** `plaintext-http-url` — `test/updater-client-security.test.js:51` — SIRK_UPDATER_ORIGIN: "http://169.254.169.254/latest",
- **MEDIUM** `plaintext-http-url` — `test/updater-client-security.test.js:55` — SIRK_UPDATER_ORIGIN: "http://user:pass@updater-gateway:8092",
- **MEDIUM** `plaintext-http-url` — `test/updater-client-security.test.js:59` — SIRK_UPDATER_ORIGIN: "http://evil.example:8092",
- **MEDIUM** `plaintext-http-url` — `test/updater-gateway.test.js:14` — workerOrigin: "http://updater:8090",
- **MEDIUM** `plaintext-http-url` — `test/updater-gateway.test.js:30` — assert.equal(pathAllowed("/status?target=http://evil"), false);
- **MEDIUM** `plaintext-http-url` — `test/updater-gateway.test.js:31` — assert.equal(workerOrigin("http://updater:8090", "updater"), "http://updater:8090");
- **MEDIUM** `plaintext-http-url` — `test/updater-gateway.test.js:32` — assert.throws(() => workerOrigin("http://evil:8090", "updater"), /not allowed/i);
- **MEDIUM** `plaintext-http-url` — `test/updater-gateway.test.js:79` — assert.equal(calls[0].url, "http://updater:8090/run");
- **MEDIUM** `plaintext-http-url` — `updater/appliance-download-server.js:49` — const url = new URL(req.url, "http://updater.local");
- **MEDIUM** `plaintext-http-url` — `updater/appliance-restore-server.js:164` — const url = new URL(req.url, "http://updater.local");
- **MEDIUM** `plaintext-http-url` — `updater/appliance-server.js:236` — const url = new URL(req.url, "http://updater.local");
- **MEDIUM** `plaintext-http-url` — `updater/gateway-server.js:29` — try { origin = new URL(String(value || "http://updater:8090")); }
- **MEDIUM** `plaintext-http-url` — `updater/gateway-server.js:91` — const origin = workerOrigin(options.workerOrigin || "http://updater:8090", options.allowedWorkerHosts || "updater");
- **MEDIUM** `plaintext-http-url` — `updater/gateway-server.js:102` — const url = new URL(req.url, "http://updater-gateway.local");
- **MEDIUM** `plaintext-http-url` — `updater/gateway-server.js:156` — workerOrigin: process.env.SIRK_UPDATER_WORKER_ORIGIN || "http://updater:8090",
- **MEDIUM** `plaintext-http-url` — `updater/management-server.js:259` — const url = new URL(req.url, "http://backup-manager.local");
- **MEDIUM** `plaintext-http-url` — `updater/server.js:321` — const url = new URL(req.url, "http://updater.local");
- **INFO** `dynamic-innerhtml` — `public/audit-ui.js:36` — view.innerHTML = `
- **INFO** `incomplete-implementation` — `public/audit-ui.js:179` — if (query) query.placeholder = text("Szukaj użytkownika, akcji lub celu", "Search actor, action or target");
- **INFO** `local-storage` — `test/backup-age-ui-contract.test.js:17` — assert.doesNotMatch(ui, /localStorage|sessionStorage|indexedDB/);
- **INFO** `local-storage` — `test/portal-bootstrap-ui.test.js:17` — assert.doesNotMatch(ui, /localStorage|sessionStorage/);
- **INFO** `incomplete-implementation` — `test/ticket-projection-store.test.js:239` — assert.throws(() => store.upsert("portal-a", sample({ status: "todo" })), /Unsupported/);
