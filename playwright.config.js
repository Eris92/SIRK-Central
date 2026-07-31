"use strict";

const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
    testDir: "./test/e2e",
    timeout: 45_000,
    expect: { timeout: 8_000 },
    fullyParallel: false,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: [["line"], ["html", { open: "never" }]],
    use: {
        baseURL: "http://127.0.0.1:4173",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure"
    },
    projects: [{ name: "chromium", use: Object.assign({}, devices["Desktop Chrome"]) }]
});
