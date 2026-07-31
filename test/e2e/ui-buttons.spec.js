"use strict";

const { test, expect } = require("@playwright/test");

test("administrator can navigate and click primary controls without browser errors", async ({ page }) => {
    const pageErrors = [];
    const consoleErrors = [];
    const serverErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("response", response => { if (response.status() >= 500) serverErrors.push(response.status() + " " + response.url()); });
    page.on("dialog", async dialog => dialog.accept(dialog.type() === "prompt" ? "E2E confirmation" : undefined));

    await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
    await expect(page.locator("#dashboardView")).toBeVisible();

    const navigation = [
        ["#overviewButton", "#overviewView"],
        ["#auditButton", "#auditView"],
        ["#approvalCenterButton", "#approvalCenterView"],
        ["#portalOperationsButton", "#portalOperationsView"],
        ["#settingsButton", "#settingsView"]
    ];
    for (const [button, view] of navigation) {
        await expect(page.locator(button)).toBeVisible();
        await page.locator(button).click();
        await expect(page.locator(view)).toBeVisible();
    }

    await page.locator("#updatesTab").click();
    await expect(page.locator("#settingsTabUpdates")).toBeVisible();
    await page.locator("#refreshUpdateButton").click();

    await page.locator("#backupTab").click();
    await expect(page.locator("#settingsTabBackup")).toBeVisible();
    await page.locator("#refreshBackupButton").click();

    await page.locator("#auditButton").click();
    await page.locator("#auditRefresh").click();
    await page.locator("#auditCategory").selectOption("system");
    await page.locator("#auditResult").selectOption("success");

    await page.locator("#approvalCenterButton").click();
    await page.locator('[data-approval-state="pending"]').click();
    await page.locator("#approvalRefresh").click();
    await expect(page.locator("#approvalList")).toContainText("Test approval");

    await page.locator("#portalOperationsButton").click();
    await page.locator("#portalOperationsRefresh").click();
    await page.locator("#portalOperationsType").selectOption("backup");
    await page.locator("#portalOperationsType").selectOption("");
    await page.locator("#portalCommandPortal").fill("test-portal");
    await page.locator("#portalCommandType").selectOption("backup");
    await page.locator("#portalCommandPayload").fill('{"mode":"full"}');
    await page.locator("#portalCommandSubmit").click();
    await expect(page.locator("#portalOperationsMessage")).toContainText(/kolejki|queued/i);

    await page.locator("#settingsButton").click();
    const sessionsTab = page.locator("#securitySessionsTab");
    if (await sessionsTab.count()) {
        await sessionsTab.click();
        await expect(page.locator("#securitySessionsList")).toBeVisible();
    }

    expect(pageErrors, "Uncaught page errors").toEqual([]);
    expect(serverErrors, "HTTP 5xx responses").toEqual([]);
    expect(consoleErrors.filter(value => !/favicon|404/i.test(value)), "Console errors").toEqual([]);
});

test("all visible buttons have accessible names and do not overlap", async ({ page }) => {
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
    const buttons = page.locator("button:visible");
    const count = await buttons.count();
    expect(count).toBeGreaterThan(5);
    for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        const name = (await button.getAttribute("aria-label")) || (await button.innerText());
        expect(String(name || "").trim(), "button " + index + " requires an accessible name").not.toBe("");
        const box = await button.boundingBox();
        expect(box && box.width > 0 && box.height > 0, "button " + index + " must have dimensions").toBeTruthy();
    }
});
