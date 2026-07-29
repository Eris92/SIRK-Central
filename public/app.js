"use strict";

const loginView = document.getElementById("loginView");
const dashboardView = document.getElementById("dashboardView");
const portalList = document.getElementById("portalList");
const breakGlassPanel = document.getElementById("breakGlassPanel");
let refreshTimer = null;
const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
const accessKey = fragment.get("access") || "";

async function api(path, options) {
    const headers = { "Content-Type": "application/json" };
    if (accessKey) headers.Authorization = "Bearer " + accessKey;
    const response = await fetch(path, Object.assign({ credentials: "same-origin", headers }, options || {}));
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || "Błąd żądania."), { status: response.status });
    return data;
}

function showLogin(enableBreakGlass) {
    loginView.hidden = false;
    dashboardView.hidden = true;
    breakGlassPanel.hidden = !enableBreakGlass;
    if (refreshTimer) clearInterval(refreshTimer);
}

async function loadPortals() {
    try {
        const result = await api("/api/portals");
        document.getElementById("onlineCount").textContent = String(result.portals.filter((item) => item.status === "online").length);
        portalList.replaceChildren(...result.portals.map((portal) => {
            const card = document.createElement("article");
            card.className = "portal-card";
            const status = document.createElement("span");
            status.className = "status " + portal.status;
            status.textContent = portal.status === "online" ? "Online" : "Offline";
            const title = document.createElement("h2");
            title.textContent = portal.name;
            const id = document.createElement("code");
            id.textContent = portal.id;
            const button = document.createElement("button");
            button.className = portal.status === "online" ? "button" : "button disabled";
            button.textContent = "Połącz";
            button.disabled = portal.status !== "online";
            button.addEventListener("click", async () => {
                const connected = await api("/api/portals/" + encodeURIComponent(portal.id) + "/connect", { method: "POST", body: "{}" });
                location.assign(connected.url);
            });
            card.append(status, title, id, button);
            return card;
        }));
    } catch (error) {
        if (error.status === 401) showLogin(Boolean(accessKey));
    }
}

async function showDashboard(identity) {
    loginView.hidden = true;
    dashboardView.hidden = false;
    document.getElementById("identityLabel").textContent = identity
        ? (identity.displayName || identity.username || "") + (identity.source === "entra" ? " · Microsoft Entra" : " · break-glass")
        : "";
    await loadPortals();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(loadPortals, 5000);
}

document.getElementById("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.getElementById("loginError");
    error.textContent = "";
    try {
        const result = await api("/api/login", {
            method: "POST",
            body: JSON.stringify({
                username: document.getElementById("username").value,
                password: document.getElementById("password").value
            })
        });
        document.getElementById("password").value = "";
        await showDashboard(result);
    } catch (requestError) {
        error.textContent = requestError.message;
    }
});

document.getElementById("logoutButton").addEventListener("click", async () => {
    const result = await api("/api/logout", { method: "POST", body: "{}" });
    if (result.logoutUrl) location.assign(result.logoutUrl);
    else showLogin(Boolean(accessKey));
});

document.getElementById("showCreateButton").addEventListener("click", () => {
    document.getElementById("createForm").hidden = false;
    document.getElementById("portalId").focus();
});

document.getElementById("createForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api("/api/portals", {
        method: "POST",
        body: JSON.stringify({
            id: document.getElementById("portalId").value,
            name: document.getElementById("portalName").value
        })
    });
    document.getElementById("portalToken").textContent = result.portal.token;
    document.getElementById("tokenPanel").hidden = false;
    event.target.reset();
    event.target.hidden = true;
    await loadPortals();
});

api("/api/session")
    .then(showDashboard)
    .catch(async () => {
        if (!accessKey) return showLogin(false);
        try {
            await api("/api/access");
            showLogin(true);
        } catch (_) {
            showLogin(false);
        }
    });
