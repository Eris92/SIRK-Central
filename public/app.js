"use strict";

const loginView = document.getElementById("loginView");
const dashboardView = document.getElementById("dashboardView");
const portalsView = document.getElementById("portalsView");
const settingsView = document.getElementById("settingsView");
const breakGlassView = document.getElementById("breakGlassView");
const portalList = document.getElementById("portalList");
const breakGlassPanel = document.getElementById("breakGlassPanel");
const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
const accessKey = fragment.get("access") || "";
let currentIdentity = null;
let refreshTimer = null;
let roleCatalog = [];

async function api(path, options) {
    const headers = { "Content-Type": "application/json" };
    if (accessKey) headers.Authorization = "Bearer " + accessKey;
    const response = await fetch(path, Object.assign({ credentials: "same-origin", headers }, options || {}));
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || "Błąd żądania."), { status: response.status });
    return data;
}
function can(permission) { return currentIdentity && (currentIdentity.permissions.includes("*") || currentIdentity.permissions.includes(permission)); }
function showLogin(localEnabled) { loginView.hidden = false; dashboardView.hidden = true; breakGlassPanel.hidden = !localEnabled; if (refreshTimer) clearInterval(refreshTimer); }
function setView(name) {
    portalsView.hidden = name !== "portals"; settingsView.hidden = name !== "settings"; breakGlassView.hidden = name !== "breakglass";
    document.getElementById("backButton").hidden = name === "portals";
    document.getElementById("pageTitle").textContent = name === "portals" ? "Połączone Portale" : name === "settings" ? "Ustawienia" : "Break-Glass";
}
async function loadPortals() {
    const result = await api("/api/portals");
    document.getElementById("onlineCount").textContent = String(result.portals.filter(x => x.status === "online").length);
    portalList.replaceChildren(...result.portals.map(portal => {
        const card = document.createElement("article"); card.className = "portal-card";
        const status = document.createElement("span"); status.className = "status " + portal.status; status.textContent = portal.status === "online" ? "Online" : "Offline";
        const title = document.createElement("h2"); title.textContent = portal.name;
        const id = document.createElement("code"); id.textContent = portal.id;
        const button = document.createElement("button"); button.className = portal.status === "online" && can("portals.connect") ? "button" : "button disabled"; button.textContent = "Połącz"; button.disabled = portal.status !== "online" || !can("portals.connect");
        button.addEventListener("click", async () => { const connected = await api("/api/portals/" + encodeURIComponent(portal.id) + "/connect", { method: "POST", body: "{}" }); location.assign(connected.url); });
        card.append(status, title, id, button); return card;
    }));
}
async function showDashboard(identity) {
    currentIdentity = identity; loginView.hidden = true; dashboardView.hidden = false; setView("portals");
    document.getElementById("identityLabel").textContent = (identity.displayName || identity.username || "") + " · " + identity.role + (identity.source === "entra" ? " · Microsoft Entra" : " · lokalne");
    document.getElementById("breakGlassButton").hidden = !identity.builtIn;
    document.getElementById("showCreateButton").hidden = !can("portals.manage");
    await loadPortals(); if (refreshTimer) clearInterval(refreshTimer); refreshTimer = setInterval(loadPortals, 5000);
}
async function loadSettings() {
    const catalog = await api("/api/settings/roles"); roleCatalog = catalog.roles;
    document.getElementById("roleSummary").textContent = currentIdentity.role;
    document.getElementById("permissionsList").textContent = currentIdentity.permissions.join("\n");
    const usersCard = document.getElementById("usersCard"); usersCard.hidden = !can("users.manage");
    if (!usersCard.hidden) {
        const select = document.getElementById("newRole"); select.replaceChildren(...roleCatalog.map(role => Object.assign(document.createElement("option"), { value: role, textContent: role })));
        await loadUsers();
    }
}
async function loadUsers() {
    const result = await api("/api/settings/users");
    const list = document.getElementById("usersList");
    list.replaceChildren(...result.users.map(user => {
        const row = document.createElement("div"); row.className = "user-row";
        const label = document.createElement("div"); label.innerHTML = "<strong></strong><small></small>"; label.querySelector("strong").textContent = user.displayName || user.username; label.querySelector("small").textContent = user.source + " · " + (user.identityKey || user.username);
        const select = document.createElement("select");
        for (const role of roleCatalog) { const option = document.createElement("option"); option.value = role; option.textContent = role; option.selected = role === user.role; select.append(option); }
        select.addEventListener("change", async () => {
            try { const key = user.source === "entra" ? user.identityKey : user.username; await api("/api/settings/users/" + user.source + "/" + encodeURIComponent(key) + "/role", { method: "PATCH", body: JSON.stringify({ role: select.value }) }); await loadUsers(); }
            catch (error) { alert(error.message); select.value = user.role; }
        });
        row.append(label, select); return row;
    }));
}

document.getElementById("loginForm").addEventListener("submit", async event => {
    event.preventDefault(); const error = document.getElementById("loginError"); error.textContent = "";
    try { const result = await api("/api/login", { method: "POST", body: JSON.stringify({ username: document.getElementById("username").value, password: document.getElementById("password").value }) }); document.getElementById("password").value = ""; await showDashboard(result); }
    catch (e) { error.textContent = e.message; }
});
document.getElementById("logoutButton").addEventListener("click", async () => { const result = await api("/api/logout", { method: "POST", body: "{}" }); if (result.logoutUrl) location.assign(result.logoutUrl); else showLogin(Boolean(accessKey)); });
document.getElementById("settingsButton").addEventListener("click", async () => { if (refreshTimer) clearInterval(refreshTimer); setView("settings"); await loadSettings(); });
document.getElementById("breakGlassButton").addEventListener("click", () => { if (refreshTimer) clearInterval(refreshTimer); setView("breakglass"); });
document.getElementById("backButton").addEventListener("click", async () => { setView("portals"); await loadPortals(); refreshTimer = setInterval(loadPortals, 5000); });
document.getElementById("showCreateButton").addEventListener("click", () => { document.getElementById("createForm").hidden = false; document.getElementById("portalId").focus(); });
document.getElementById("createForm").addEventListener("submit", async event => { event.preventDefault(); const result = await api("/api/portals", { method: "POST", body: JSON.stringify({ id: document.getElementById("portalId").value, name: document.getElementById("portalName").value }) }); document.getElementById("portalToken").textContent = result.portal.token; document.getElementById("tokenPanel").hidden = false; event.target.reset(); event.target.hidden = true; await loadPortals(); });
document.getElementById("createUserForm").addEventListener("submit", async event => { event.preventDefault(); const error = document.getElementById("userError"); error.textContent = ""; try { await api("/api/settings/users", { method: "POST", body: JSON.stringify({ username: document.getElementById("newUsername").value, displayName: document.getElementById("newDisplayName").value, password: document.getElementById("newPassword").value, role: document.getElementById("newRole").value }) }); event.target.reset(); await loadUsers(); } catch (e) { error.textContent = e.message; } });
document.getElementById("breakGlassPasswordForm").addEventListener("submit", async event => { event.preventDefault(); await api("/api/break-glass/password", { method: "POST", body: JSON.stringify({ currentPassword: document.getElementById("currentBreakGlassPassword").value, newPassword: document.getElementById("newBreakGlassPassword").value }) }); event.target.reset(); alert("Hasło Break-Glass zostało zmienione."); });
document.getElementById("rotateAccessButton").addEventListener("click", async () => { if (!confirm("Poprzedni access URL przestanie działać. Kontynuować?")) return; const result = await api("/api/break-glass/access", { method: "POST", body: "{}" }); const output = document.getElementById("newAccessUrl"); output.textContent = result.accessUrl; output.hidden = false; });

api("/api/session").then(showDashboard).catch(async () => { if (!accessKey) return showLogin(false); try { await api("/api/access"); showLogin(true); } catch (_) { showLogin(false); } });
