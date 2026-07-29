"use strict";

const readline = require("node:readline");
const { hashSecret } = require("../src/security");

const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
terminal.question("Admin password (input will be visible): ", (password) => {
    try {
        process.stdout.write(hashSecret(password) + "\n");
    } finally {
        terminal.close();
    }
});

