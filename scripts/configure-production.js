"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { hashSecret, hashAccessKey } = require("../src/security");

const WEBSITE_DOMAIN = "sirkportal.com";
const CENTRAL_DOMAIN = "central.sirkportal.com";
const CENTRAL_ORIGIN = "https://" + CENTRAL_DOMAIN;

function readHidden(prompt) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
            reject(new Error("An interactive TTY is required."));
            return;
        }
        process.stdout.write(prompt);
        let value = "";
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");
        function finish(error) {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener("data", onData);
            process.stdout.write("\n");
            if (error) reject(error);
            else resolve(value);
        }
        function onData(chunk) {
            for (const character of chunk) {
                if (character === "\u0003") return finish(new Error("Configuration cancelled."));
                if (character === "\r" || character === "\n") return finish();
                if (character === "\u007f" || character === "\b") {
                    value = value.slice(0, -1);
                    continue;
                }
                if (character >= " ") value += character;
            }
        }
        process.stdin.on("data", onData);
    });
}

async function main() {
    const targetDirectory = path.resolve(process.env.SIRK_CONFIG_TARGET || "/config");
    const targetPath = path.join(targetDirectory, ".env");
    const resetAdminPassword = process.argv.includes("--reset-admin-password");
    const rotateAccessKey = process.argv.includes("--rotate-access-key");
    if (resetAdminPassword && rotateAccessKey) {
        throw new Error("Choose only one credential operation.");
    }
    if (fs.existsSync(targetPath) && !resetAdminPassword) {
        if (!rotateAccessKey) {
            throw new Error("Configuration already exists. Refusing to overwrite " + targetPath + ".");
        }
    }
    if (!fs.existsSync(targetPath) && (resetAdminPassword || rotateAccessKey)) {
        throw new Error("Configuration does not exist: " + targetPath + ".");
    }
    if (rotateAccessKey) {
        const current = fs.readFileSync(targetPath, "utf8");
        const accessKey = crypto.randomBytes(32).toString("base64url");
        const replacement = "SIRK_ACCESS_KEY_HASH='" + hashAccessKey(accessKey) + "'";
        if (!/^SIRK_ACCESS_KEY_HASH=.*$/m.test(current)) {
            throw new Error("Access key hash entry is missing.");
        }
        const temporaryRotation = targetPath + ".tmp-" + process.pid;
        fs.writeFileSync(temporaryRotation,
            current.replace(/^SIRK_ACCESS_KEY_HASH=.*$/m, replacement),
            { mode: 0o600, flag: "wx" });
        fs.renameSync(temporaryRotation, targetPath);
        process.stdout.write("\nURL access key rotated. Store this URL now; it is shown only once:\n\n");
        process.stdout.write(CENTRAL_ORIGIN + "/#access=" + accessKey + "\n\n");
        return;
    }
    const password = await readHidden("New Central admin password: ");
    const confirmation = await readHidden("Repeat admin password: ");
    if (password !== confirmation) throw new Error("Passwords do not match.");
    if (password.length < 14) throw new Error("Password must contain at least 14 characters.");

    if (resetAdminPassword) {
        const current = fs.readFileSync(targetPath, "utf8");
        const replacement = "SIRK_ADMIN_PASSWORD_HASH='" + hashSecret(password) + "'";
        if (!/^SIRK_ADMIN_PASSWORD_HASH=.*$/m.test(current)) {
            throw new Error("Admin password hash entry is missing.");
        }
        const temporaryReset = targetPath + ".tmp-" + process.pid;
        fs.writeFileSync(temporaryReset,
            current.replace(/^SIRK_ADMIN_PASSWORD_HASH=.*$/m, replacement),
            { mode: 0o600, flag: "wx" });
        fs.renameSync(temporaryReset, targetPath);
        process.stdout.write("\nAdmin password updated. The URL access key was not changed.\n");
        return;
    }

    const accessKey = crypto.randomBytes(32).toString("base64url");
    const lines = [
        "SIRK_BIND_HOST=127.0.0.1",
        "SIRK_PORT=8080",
        "SIRK_PUBLIC_ORIGIN=" + CENTRAL_ORIGIN,
        "SIRK_ADMIN_USERNAME=admin",
        "SIRK_ADMIN_PASSWORD_HASH='" + hashSecret(password) + "'",
        "SIRK_ACCESS_KEY_HASH='" + hashAccessKey(accessKey) + "'",
        "SIRK_DATA_DIR=/var/lib/sirk-central",
        "SIRK_SESSION_HOURS=8",
        "SIRK_WEBSITE_DOMAIN=" + WEBSITE_DOMAIN,
        "SIRK_CENTRAL_DOMAIN=" + CENTRAL_DOMAIN,
        "SIRK_ACME_EMAIL=admin@sir-k.pl",
        ""
    ];
    const temporary = targetPath + ".tmp-" + process.pid;
    fs.writeFileSync(temporary, lines.join("\n"), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, targetPath);

    process.stdout.write("\nConfiguration saved. Store this URL now; the key is shown only once:\n\n");
    process.stdout.write(CENTRAL_ORIGIN + "/#access=" + accessKey + "\n\n");
    process.stdout.write("Username: admin\n");
    process.stdout.write("Password: the value you just entered\n");
}

main().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
});
