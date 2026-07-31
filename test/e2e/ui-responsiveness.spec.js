"use strict";

const { test, expect } = require("@playwright/test");

const candidates = [
    "passkey-ui.js",
    "permissions-layout.js",
    "break-glass-mfa.js",
    "workspace-routing.js",
    "app.js"
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

for (const candidate of candidates) {
    test("renderer stays responsive without " + candidate, async ({ page }) => {
        test.setTimeout(15_000);
        await commonRoutes(page);
        await page.route("**/" + candidate, route => route.fulfill({
            status: 200,
            contentType: "text/javascript; charset=utf-8",
            body: "\"use strict\";"
        }));
        await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
        await new Promise(resolve => setTimeout(resolve, 1_500));
        const state = await page.evaluate(() => ({
            readyState: document.readyState,
            dashboardHidden: document.getElementById("dashboardView")?.hidden,
            title: document.title
        }));
        expect(state.readyState).toMatch(/interactive|complete/);
        expect(state.title).toBe("SIRK Central");
    });
}

test("renderer stays responsive with the complete script set", async ({ page }) => {
    test.setTimeout(15_000);
    await commonRoutes(page);
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
    await new Promise(resolve => setTimeout(resolve, 1_500));
    const state = await page.evaluate(() => ({
        readyState: document.readyState,
        dashboardHidden: document.getElementById("dashboardView")?.hidden,
        title: document.title
    }));
    expect(state.readyState).toMatch(/interactive|complete/);
    expect(state.dashboardHidden).toBe(false);
});
