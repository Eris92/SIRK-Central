"use strict";

const path = require("node:path");
const portalStoreFactory = require("../src/portal-store");

function argument(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

const dataDir = path.resolve(process.env.SIRK_DATA_DIR || "/var/lib/sirk-central");
const id = argument("--id");
const name = argument("--name");
const created = portalStoreFactory.create({ dataDir }).createPortal({ id, name });
process.stdout.write(JSON.stringify(created));
