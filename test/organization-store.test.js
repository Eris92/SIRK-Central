"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const organizationStore = require("../src/organization-store");

function temporaryDirectory() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-org-store-"));
}

test("organization store builds Tenant Customer Site hierarchy and persists it", () => {
    const dataDir = temporaryDirectory();
    let sequence = 0;
    const options = {
        dataDir,
        now: () => Date.UTC(2026, 6, 30, 16, 0, sequence),
        randomId: prefix => prefix + "-" + (++sequence)
    };
    const actor = { identityKey: "tenant:admin" };
    const store = organizationStore.create(options);
    const tenant = store.createTenant({ code: "sirk", name: "SIRK" }, actor);
    const customer = store.createCustomer({ tenantId: tenant.id, code: "customer-a", name: "Customer A" }, actor);
    const site = store.createSite({ customerId: customer.id, code: "warsaw", name: "Warsaw" }, actor);

    assert.equal(site.tenantId, tenant.id);
    assert.equal(store.tree()[0].customers[0].sites[0].id, site.id);

    const restored = organizationStore.create(options);
    assert.equal(restored.tree()[0].customers[0].sites[0].name, "Warsaw");
});

test("organization store enforces scoped codes and parent deletion safety", () => {
    const store = organizationStore.create({
        dataDir: temporaryDirectory(),
        randomId: (() => { let sequence = 0; return prefix => prefix + "-" + (++sequence); })()
    });
    const tenant = store.createTenant({ code: "tenant-a", name: "Tenant A" }, {});
    const customer = store.createCustomer({ tenantId: tenant.id, code: "main", name: "Main Customer" }, {});
    store.createSite({ customerId: customer.id, code: "hq", name: "Headquarters" }, {});

    assert.throws(() => store.createTenant({ code: "tenant-a", name: "Duplicate" }, {}), /already in use/i);
    assert.throws(() => store.createCustomer({ tenantId: tenant.id, code: "main", name: "Duplicate" }, {}), /already in use/i);
    assert.throws(() => store.remove("customer", customer.id, {}), /still contains sites/i);
    assert.throws(() => store.remove("tenant", tenant.id, {}), /still contains customers/i);
});

test("organization objects can be disabled and safely removed bottom-up", () => {
    const store = organizationStore.create({
        dataDir: temporaryDirectory(),
        randomId: (() => { let sequence = 0; return prefix => prefix + "-" + (++sequence); })()
    });
    const tenant = store.createTenant({ code: "tenant-b", name: "Tenant B" }, {});
    const customer = store.createCustomer({ tenantId: tenant.id, code: "branch", name: "Branch" }, {});
    const site = store.createSite({ customerId: customer.id, code: "site-1", name: "Site 1" }, {});

    assert.equal(store.setStatus("site", site.id, "disabled", {}).status, "disabled");
    store.remove("site", site.id, {});
    store.remove("customer", customer.id, {});
    store.remove("tenant", tenant.id, {});
    assert.deepEqual(store.tree(), []);
});
