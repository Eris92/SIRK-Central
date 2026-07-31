"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const organizationStore = require("../src/organization-store");
const assignmentStore = require("../src/portal-assignment-store");

test("Portal assignment validates organization hierarchy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-assignment-"));
    let counter = 0;
    const organizations = organizationStore.create({ dataDir: dir, randomId: prefix => prefix + "-" + (++counter) });
    const tenant = organizations.createTenant({ code: "tenant-a", name: "Tenant A" }, { username: "admin" });
    const customer = organizations.createCustomer({ tenantId: tenant.id, code: "customer-a", name: "Customer A" }, { username: "admin" });
    const site = organizations.createSite({ customerId: customer.id, code: "site-a", name: "Site A" }, { username: "admin" });
    const portals = { list: () => [{ id: "portal-a" }] };
    const store = assignmentStore.create({ dataDir: dir });
    const assignment = store.assign("portal-a", { tenantId: tenant.id, customerId: customer.id, siteId: site.id }, { identityKey: "entra:admin" }, organizations, portals);
    assert.equal(assignment.portalId, "portal-a");
    assert.equal(store.list().length, 1);
    assert.equal(assignmentStore.create({ dataDir: dir }).get("portal-a").siteId, site.id);
});

test("Portal assignment rejects invalid or disabled hierarchy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-assignment-invalid-"));
    let counter = 0;
    const organizations = organizationStore.create({ dataDir: dir, randomId: prefix => prefix + "-" + (++counter) });
    const tenant1 = organizations.createTenant({ code: "tenant-one", name: "Tenant One" }, { username: "admin" });
    const tenant2 = organizations.createTenant({ code: "tenant-two", name: "Tenant Two" }, { username: "admin" });
    const customer = organizations.createCustomer({ tenantId: tenant1.id, code: "customer-one", name: "Customer One" }, { username: "admin" });
    const site = organizations.createSite({ customerId: customer.id, code: "site-one", name: "Site One" }, { username: "admin" });
    const store = assignmentStore.create({ dataDir: dir });
    const portals = { list: () => [{ id: "portal-one" }] };
    assert.throws(() => store.assign("portal-one", { tenantId: tenant2.id, customerId: customer.id, siteId: site.id }, { username: "admin" }, organizations, portals), /does not belong/);
    organizations.setStatus("site", site.id, "disabled", { username: "admin" });
    assert.throws(() => store.assign("portal-one", { tenantId: tenant1.id, customerId: customer.id, siteId: site.id }, { username: "admin" }, organizations, portals), /must be active/);
});
