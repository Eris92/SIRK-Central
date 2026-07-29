"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const accessStoreFactory = require("../src/access-store");

function tempStore() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-access-"));
    return { dataDir, store: accessStoreFactory.create({ dataDir }) };
}

test("users without a team have no portal access", () => {
    const { store } = tempStore();
    const result = store.effective({ source:"local", username:"user.one", role:"SupportL2", builtIn:false }, "portal-a");
    assert.equal(result.allowed, false);
    assert.equal(result.capabilities["portal.connect"], "deny");
});

test("team scope grants only assigned portals and inherits role capabilities", () => {
    const { store } = tempStore();
    store.saveTeam({
        id:"team-abc",
        name:"ABC support",
        members:["local:user.one"],
        portalIds:["portal-a","portal-c"],
        profile:{}
    });
    const identity = { source:"local", username:"user.one", role:"SupportL2", builtIn:false };
    assert.equal(store.effective(identity,"portal-a").allowed,true);
    assert.equal(store.effective(identity,"portal-a").capabilities["device.terminal.execute"],"allow");
    assert.equal(store.effective(identity,"portal-b").allowed,false);
});

test("team and portal policy can only restrict role capabilities", () => {
    const { store } = tempStore();
    store.saveTeam({
        id:"restricted",
        name:"Restricted support",
        members:["local:user.one"],
        portalIds:["portal-a"],
        profile:{ "device.terminal.execute":"deny", "device.services.manage":"approval" }
    });
    store.savePortalPolicy("portal-a", { "device.files.read":"deny", "portal.connect":"approval" });
    const effective = store.effective({ source:"local", username:"user.one", role:"EngineerL3", builtIn:false }, "portal-a");
    assert.equal(effective.capabilities["device.terminal.execute"],"deny");
    assert.equal(effective.capabilities["device.files.read"],"deny");
    assert.equal(effective.capabilities["device.services.manage"],"approval");
    assert.equal(effective.capabilities["portal.connect"],"approval");
});

test("multiple teams use the most restrictive result", () => {
    const { store } = tempStore();
    store.saveTeam({ id:"team-one", name:"Team one", members:["local:user.one"], portalIds:["portal-a"], profile:{"device.terminal.execute":"allow"} });
    store.saveTeam({ id:"team-two", name:"Team two", members:["local:user.one"], portalIds:["portal-a"], profile:{"device.terminal.execute":"deny"} });
    const effective = store.effective({ source:"local", username:"user.one", role:"EngineerL3", builtIn:false }, "portal-a");
    assert.equal(effective.capabilities["device.terminal.execute"],"deny");
    assert.deepEqual(effective.teams.sort(),["team-one","team-two"]);
});

test("Break-Glass always has global access", () => {
    const { store } = tempStore();
    const effective = store.effective({ source:"local", username:"admin", role:"BreakGlass", builtIn:true }, "any-portal");
    assert.equal(effective.allowed,true);
    assert.equal(effective.capabilities["portal.connect"],"allow");
});
