"use strict";

const { test, expect } = require("@playwright/test");

function captureFailures(page) {
    const pageErrors = [];
    const consoleErrors = [];
    const httpErrors = [];
    page.on("pageerror", error => pageErrors.push(error.stack || error.message));
    page.on("console", message => {
        if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("response", response => {
        const status = response.status();
        const url = new URL(response.url());
        if (status >= 400 && url.pathname !== "/favicon.ico") {
            httpErrors.push(status + " " + response.request().method() + " " + url.pathname + url.search);
        }
    });
    return {
        assertClean() {
            expect(pageErrors, "Uncaught page errors").toEqual([]);
            expect(consoleErrors, "Browser console errors").toEqual([]);
            expect(httpErrors, "Unexpected HTTP 4xx/5xx responses").toEqual([]);
        }
    };
}

async function open(page, button, view) {
    await expect(page.locator(button), "navigation button " + button).toBeVisible();
    await page.locator(button).click();
    await expect(page.locator(view), "view " + view).toBeVisible();
}

async function clickWhenVisible(locator) {
    if (await locator.count() && await locator.first().isVisible() && await locator.first().isEnabled()) {
        await locator.first().click();
        return true;
    }
    return false;
}

async function assertButtonsAccessibleAndSeparated(page, root = "body") {
    const buttons = page.locator(root + " button:visible");
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    const boxes = [];
    for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        const name = (await button.getAttribute("aria-label")) || (await button.innerText());
        expect(String(name || "").trim(), "button " + index + " requires an accessible name").not.toBe("");
        const box = await button.boundingBox();
        expect(box && box.width >= 24 && box.height >= 24, "button " + index + " must have usable dimensions").toBeTruthy();
        boxes.push({ index, box, name: String(name).trim() });
    }
    for (let left = 0; left < boxes.length; left += 1) {
        for (let right = left + 1; right < boxes.length; right += 1) {
            const a = boxes[left].box;
            const b = boxes[right].box;
            const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
            const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
            expect(overlapWidth > 2 && overlapHeight > 2, "buttons overlap: " + boxes[left].name + " / " + boxes[right].name).toBeFalsy();
        }
    }
}

test.beforeEach(async ({ page }) => {
    page.on("dialog", async dialog => {
        if (dialog.type() === "prompt") await dialog.accept("E2E confirmation");
        else await dialog.accept();
    });
});

test("administrator can navigate every module and exercise safe controls without errors", async ({ page }) => {
    const failures = captureFailures(page);
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
    await expect(page.locator("#dashboardView")).toBeVisible();

    await open(page, "#overviewButton", "#overviewView");
    await page.locator("#overviewRefresh").click();
    for (const target of ["portals", "audit", "updates", "backup"]) {
        await open(page, "#overviewButton", "#overviewView");
        await page.locator('[data-overview-target="' + target + '"]').click();
        await page.waitForTimeout(200);
    }

    await open(page, "#auditButton", "#auditView");
    await page.locator("#auditRefresh").click();
    await page.locator("#auditCategory").selectOption("system");
    await page.locator("#auditResult").selectOption("success");
    await page.locator("#auditSearch").fill("test");
    await page.locator("#auditSearch").press("Enter");

    await open(page, "#approvalCenterButton", "#approvalCenterView");
    for (const state of ["pending", "approved", "rejected", "cancelled", "expired"]) {
        await page.locator('[data-approval-state="' + state + '"]').click();
    }
    await page.locator('[data-approval-state="pending"]').click();
    await page.locator("#approvalRefresh").click();
    await expect(page.locator("#approvalList")).toContainText("Test approval");
    await clickWhenVisible(page.locator("#approvalList button", { hasText: /Zatwierdź|Approve/i }));

    await page.locator("#approvalType").selectOption("tenant.activation");
    await page.locator("#approvalTitleInput").fill("E2E activation");
    await page.locator("#approvalReasonInput").fill("Full button audit");
    await page.locator("#approvalCountInput").selectOption("1");
    await page.locator("#approvalTtlInput").fill("60");
    await page.locator("#approvalSubmitButton").click();
    await expect(page.locator("#approvalMessage")).toContainText(/utworzony|created/i);
    await clickWhenVisible(page.locator("#approvalList button", { hasText: /Anuluj|Cancel/i }));

    await open(page, "#portalOperationsButton", "#portalOperationsView");
    await page.locator("#portalOperationsRefresh").click();
    for (const type of ["backup", "update", "restart", "reconnect", "sync", "diagnostics", ""]) {
        await page.locator("#portalOperationsType").selectOption(type);
    }
    for (const state of ["queued", "delivered", "running", "completed", "failed", "cancelled", "expired", ""]) {
        await page.locator("#portalOperationsState").selectOption(state);
    }
    await page.locator("#portalCommandPortal").fill("test-portal");
    await page.locator("#portalCommandType").selectOption("backup");
    await page.locator("#portalCommandPayload").fill('{"mode":"full","token":"must-redact"}');
    await page.locator("#portalCommandSubmit").click();
    await expect(page.locator("#portalOperationsMessage")).toContainText(/kolejki|queued/i);
    await clickWhenVisible(page.locator("#portalOperationsList button", { hasText: /Anuluj|Cancel/i }));

    await expect(page.locator("#ticketsNavButton")).toBeVisible();
    await page.locator("#ticketsNavButton").click();
    await expect(page.locator("#ticketsWorkspace")).toBeVisible();
    await page.locator("#ticketsRefresh").click();
    await page.locator("#ticketSearch").fill("E2E-100");
    await page.waitForTimeout(350);
    await page.locator("#ticketStatus").selectOption("new");
    await page.locator("#ticketPriority").selectOption("high");
    await page.locator("#ticketSla").check();
    await page.locator("#ticketSla").uncheck();
    await page.locator("#ticketStatus").selectOption("");
    await page.locator("#ticketPriority").selectOption("");
    await page.locator("#ticketSearch").fill("");
    await page.waitForTimeout(350);
    await expect(page.locator("#ticketList")).toContainText("Test ticket");
    for (const action of ["details", "progress", "resolve"]) {
        await clickWhenVisible(page.locator('#ticketList button[data-action="' + action + '"]'));
        await page.waitForTimeout(150);
    }

    await open(page, "#settingsButton", "#settingsView");
    const settingsTabs = ["#entraTab", "#updatesTab", "#backupTab", "#systemTab", "#securitySessionsTab"];
    for (const selector of settingsTabs) {
        const tab = page.locator(selector);
        if (await clickWhenVisible(tab)) await page.waitForTimeout(150);
    }
    await clickWhenVisible(page.locator("#refreshUpdateButton"));
    await clickWhenVisible(page.locator("#refreshBackupButton"));
    await clickWhenVisible(page.locator("#systemInfoRefresh"));
    await clickWhenVisible(page.locator("#securitySessionsRefresh"));

    for (const [button, view] of [["#backButton", "#portalsView"], ["#accessButton", "#accessView"], ["#breakGlassButton", "#breakGlassView"]]) {
        if (await page.locator(button).count() && await page.locator(button).isVisible()) {
            await page.locator(button).click();
            await expect(page.locator(view)).toBeVisible();
        }
    }

    failures.assertClean();
});

test("all visible buttons have accessible names usable sizes and no overlap in each view", async ({ page }) => {
    const failures = captureFailures(page);
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });

    const views = [
        ["#overviewButton", "#overviewView"],
        ["#auditButton", "#auditView"],
        ["#approvalCenterButton", "#approvalCenterView"],
        ["#portalOperationsButton", "#portalOperationsView"],
        ["#settingsButton", "#settingsView"],
        ["#ticketsNavButton", "#ticketsWorkspace"]
    ];
    for (const [button, view] of views) {
        await open(page, button, view);
        await page.waitForTimeout(100);
        await assertButtonsAccessibleAndSeparated(page, view);
    }

    failures.assertClean();
});

test("mutating UI requests carry CSRF and never emit secret values in DOM", async ({ page }) => {
    const failures = captureFailures(page);
    const mutations = [];
    page.on("request", request => {
        if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/")) {
            mutations.push({ url: request.url(), method: request.method(), csrf: request.headers()["x-sirk-csrf"] || "" });
        }
    });
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
    await open(page, "#portalOperationsButton", "#portalOperationsView");
    await page.locator("#portalCommandPortal").fill("test-portal");
    await page.locator("#portalCommandType").selectOption("backup");
    await page.locator("#portalCommandPayload").fill('{"token":"top-secret-value"}');
    await page.locator("#portalCommandSubmit").click();
    await expect.poll(() => mutations.length).toBeGreaterThan(0);
    for (const mutation of mutations) expect(mutation.csrf, mutation.method + " " + mutation.url + " requires CSRF").toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    await expect(page.locator("body")).not.toContainText("top-secret-value");
    failures.assertClean();
});
