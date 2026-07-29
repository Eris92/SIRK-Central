"use strict";

const { randomToken, hashAccessKey } = require("../src/security");

const key = randomToken(32);
process.stdout.write("URL access key (show once): " + key + "\n");
process.stdout.write("SIRK_ACCESS_KEY_HASH=" + hashAccessKey(key) + "\n");

