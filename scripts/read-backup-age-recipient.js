"use strict";

const path = require("node:path");
const storeFactory = require("../src/backup-age-key-store");

const dataDir = path.resolve(process.argv[2] || "/var/lib/sirk-central");
try {
    const record = storeFactory.create({ dataDir }).read();
    if (record) process.stdout.write(record.recipient);
} catch (error) {
    process.stderr.write("ERROR: " + String(error.message || error) + "\n");
    process.exitCode = 1;
}
