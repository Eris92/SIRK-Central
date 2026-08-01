"use strict";

const { test, expect } = require("@playwright/test");

const bundleComponents = [
    "passkey-attestation-bridge.js",
    "passkey-ui-polish.js",
    "passkey-list-cleanup.js",
    "operations-ui.js",
    "operations-actions.js",
    "central-ux.js",
    "operations-bootstrap.js",
    "update-status-resilience.js",
    "audit-ui.js",
    "dashboard-css-loader.js",
    "dashboard-ui.js",
    "admin-tools-css-loader.js",
    "admin-tools-ui.js",
    "security-sessions-ui.js",
    "approval-center-ui.js",
    "portal-operations-ui.js",
    "portal-monitoring-ui.js",
    "tickets-ui.js"
];

const workspaceBootstrap = `"use strict";
window.__SIRK_WORKSPACE_BOOTSTRAP = Object.freeze({
  authenticated: true,
  workspaces: Object.freeze(["portals", "permissions", "security", "settings", "break-glass"])
});
`;
const csrfBootstrap = `"use strict";
(function(){
  const original=window.fetch.bind(window);
  window.fetch=function(input,init){
    init=Object.assign({},init||{});
    init.credentials=init.credentials||"same-origin";
    return original(input,init);
  };
}());
`;

async function commonRoutes(page) {
    await page.route("**/csrf-bootstrap.js", route => route.fulfill({
        status: 200,
        contentType: "text/javascript; charset=utf-8",
        body: csrfBootstrap
    }));
    await page.route("**/workspace-bootstrap.js", route => route.fulfill({
        status: 200,
        contentType: "text/javascript; charset=utf-8",
        body: workspaceBootstrap
    }));
}

async function componentSource(request, name) {
    const response = await request.get("http://127.0.0.1:4173/" + name);
    expect(response.ok()).toBe(true);
    return response.text();
}

async function serveBundle(page, source) {
    await page.route("**/passkey-ui.js", route => route.fulfill({
        status: 200,
        contentType: "text/javascript; charset=utf-8",
        body: source
    }));
}

async function assertResponsive(page) {
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
    await new Promise(resolve => setTimeout(resolve, 750));
    const state = await page.evaluate(() => ({
        readyState: document.readyState,
        dashboardHidden: document.getElementById("dashboardView")?.hidden,
        title: document.title
    }));
    expect(state.readyState).toMatch(/interactive|complete/);
    expect(state.title).toBe("SIRK Central");
    return state;
}

for (const mode of ["login", "management"]) {
    test("renderer stays responsive with passkey " + mode + " initialization", async ({ page, request }) => {
        test.setTimeout(10_000);
        await commonRoutes(page);
        let source = await componentSource(request, "passkey-ui.js");
        if (mode === "login") source = source.replace("initializeManagement();", "");
        else source = source.replace("initializeLogin();", "");
        await serveBundle(page, source);
        await assertResponsive(page);
    });
}

for (const component of bundleComponents) {
    test("renderer stays responsive with bundle component " + component, async ({ page, request }) => {
        test.setTimeout(8_000);
        await commonRoutes(page);
        await serveBundle(page, await componentSource(request, component));
        await assertResponsive(page);
    });
}

test("renderer stays responsive with the complete script set", async ({ page }) => {
    test.setTimeout(15_000);
    await commonRoutes(page);
    const state = await assertResponsive(page);
    expect(state.dashboardHidden).toBe(false);
});
