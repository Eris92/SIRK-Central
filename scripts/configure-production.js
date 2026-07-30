"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { hashSecret, hashAccessKey } = require("../src/security");

function environment(name, fallback) {
    const value = String(process.env[name] || "").trim();
    return value || fallback;
}

function validateDomain(name, value) {
    if (!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)) {
        throw new Error(name + " is not a valid DNS domain.");
    }
    return value.toLowerCase();
}

function fileValue(content, name) {
    const match = String(content).match(new RegExp("^" + name + "=(.*)$", "m"));
    if (!match) return "";
    const value = match[1].trim();
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
        return value.slice(1, -1);
    }
    return value;
}

function writeAtomic(targetPath, content) {
    const temporaryPath = targetPath + ".tmp-" + process.pid;
    fs.writeFileSync(temporaryPath, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, targetPath);
}

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
    if (fs.existsSync(targetPath) && !resetAdminPassword && !rotateAccessKey) {
        throw new Error("Configuration already exists. Refusing to overwrite " + targetPath + ".");
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
        writeAtomic(targetPath, current.replace(/^SIRK_ACCESS_KEY_HASH=.*$/m, replacement));
        const origin = fileValue(current, "SIRK_PUBLIC_ORIGIN") || "https://central.sirkportal.com";
        process.stdout.write("\nURL access key rotated. Store this URL now; it is shown only once:\n\n");
        process.stdout.write(origin.replace(/\/+$/, "") + "/#access=" + accessKey + "\n\n");
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
        writeAtomic(targetPath, current.replace(/^SIRK_ADMIN_PASSWORD_HASH=.*$/m, replacement));
        process.stdout.write("\nAdmin password updated. The URL access key was not changed.\n");
        return;
    }

    const websiteDomain = validateDomain(
        "SIRK_WEBSITE_DOMAIN",
        environment("SIRK_WEBSITE_DOMAIN", "sirkportal.com")
    );
    const centralDomain = validateDomain(
        "SIRK_CENTRAL_DOMAIN",
        environment("SIRK_CENTRAL_DOMAIN", "central." + websiteDomain)
    );
    const acmeEmail = environment("SIRK_ACME_EMAIL", "admin@" + websiteDomain);
    const adminUsername = environment("SIRK_ADMIN_USERNAME", "admin");
    const sessionHours = Number(environment("SIRK_SESSION_HOURS", "8"));

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acmeEmail)) {
        throw new Error("SIRK_ACME_EMAIL is invalid.");
    }
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(adminUsername)) {
        throw new Error("SIRK_ADMIN_USERNAME is invalid.");
    }
    if (!Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 24) {
        throw new Error("SIRK_SESSION_HOURS must be an integer from 1 to 24.");
    }

    const centralOrigin = "https://" + centralDomain;
    const accessKey = crypto.randomBytes(32).toString("base64url");
    const updaterToken = crypto.randomBytes(48).toString("base64url");
    const lines = [
        "SIRK_BIND_HOST=127.0.0.1",
        "SIRK_PORT=8080",
        "SIRK_PUBLIC_ORIGIN=" + centralOrigin,
        "SIRK_ADMIN_USERNAME=" + adminUsername,
        "SIRK_ADMIN_PASSWORD_HASH='" + hashSecret(password) + "'",
        "SIRK_ACCESS_KEY_HASH='" + hashAccessKey(accessKey) + "'",
        "SIRK_DATA_DIR=/var/lib/sirk-central",
        "SIRK_SESSION_HOURS=" + sessionHours,
        "SIRK_UPDATER_TOKEN='" + updaterToken + "'",
        "SIRK_WEBSITE_DOMAIN=" + websiteDomain,
        "SIRK_CENTRAL_DOMAIN=" + centralDomain,
        "SIRK_ACME_EMAIL=" + acmeEmail,
        ""
    ];
    writeAtomic(targetPath, lines.join("\n"));

    process.stdout.write("\nConfiguration saved. Store this URL now; the key is shown only once:\n\n");
    process.stdout.write(centralOrigin + "/#access=" + accessKey + "\n\n");
    process.stdout.write("Username: " + adminUsername + "\n");
    process.stdout.write("Password: the value you just entered\n");
}

main().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
});
