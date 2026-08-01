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

function integerSetting(name, fallback, minimum, maximum) {
    const value = Number(environment(name, String(fallback)));
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(name + " must be an integer from " + minimum + " to " + maximum + ".");
    }
    return value;
}

function fileValue(content, name) {
    const match = String(content).match(new RegExp("^" + name + "=(.*)$", "m"));
    if (!match) return "";
    const value = match[1].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) return value.slice(1, -1);
    return value;
}

function writeAtomic(targetPath, content, mode = 0o600) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    const temporaryPath = targetPath + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(temporaryPath, content, { mode, flag: "wx" });
    fs.renameSync(temporaryPath, targetPath);
}

function readHidden(prompt) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return reject(new Error("An interactive TTY is required."));
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
            if (error) reject(error); else resolve(value);
        }
        function onData(chunk) {
            for (const character of chunk) {
                if (character === "\u0003") return finish(new Error("Configuration cancelled."));
                if (character === "\r" || character === "\n") return finish();
                if (character === "\u007f" || character === "\b") { value = value.slice(0, -1); continue; }
                if (character >= " ") value += character;
            }
        }
        process.stdin.on("data", onData);
    });
}

function readPasswordFile() {
    const configured = String(process.env.SIRK_ADMIN_PASSWORD_FILE || "").trim();
    if (!configured) return "";
    const passwordPath = path.resolve(configured);
    const stat = fs.statSync(passwordPath);
    if (!stat.isFile()) throw new Error("Break-Glass password source is not a regular file.");
    if ((stat.mode & 0o077) !== 0) throw new Error("Break-Glass password source permissions must be 0600 or stricter.");
    const value = fs.readFileSync(passwordPath, "utf8").replace(/[\r\n]+$/, "");
    if (value.includes("\n") || value.includes("\r")) throw new Error("Break-Glass password source must contain one line.");
    return value;
}

function emitInstallResult(result) {
    const resultPath = String(process.env.SIRK_INSTALL_RESULT_FILE || "").trim();
    if (resultPath) {
        writeAtomic(path.resolve(resultPath), JSON.stringify(result, null, 2) + "\n");
        return;
    }
    process.stdout.write("\nConfiguration saved. Store this URL now; the key is shown only once:\n\n");
    process.stdout.write(result.accessUrl + "\n\n");
    process.stdout.write("Break-glass username: " + result.username + "\n");
}

async function acquirePassword() {
    const fromFile = readPasswordFile();
    if (fromFile) return fromFile;
    const password = await readHidden("New Central break-glass password: ");
    const confirmation = await readHidden("Repeat break-glass password: ");
    if (password !== confirmation) throw new Error("Passwords do not match.");
    return password;
}

async function main() {
    const targetDirectory = path.resolve(process.env.SIRK_CONFIG_TARGET || "/config");
    const targetPath = path.join(targetDirectory, ".env");
    const resetAdminPassword = process.argv.includes("--reset-admin-password");
    const rotateAccessKey = process.argv.includes("--rotate-access-key");

    if (resetAdminPassword && rotateAccessKey) throw new Error("Choose only one credential operation.");
    if (fs.existsSync(targetPath) && !resetAdminPassword && !rotateAccessKey) throw new Error("Configuration already exists. Refusing to overwrite " + targetPath + ".");
    if (!fs.existsSync(targetPath) && (resetAdminPassword || rotateAccessKey)) throw new Error("Configuration does not exist: " + targetPath + ".");

    if (rotateAccessKey) {
        const current = fs.readFileSync(targetPath, "utf8");
        const accessKey = crypto.randomBytes(32).toString("base64url");
        const replacement = "SIRK_ACCESS_KEY_HASH='" + hashAccessKey(accessKey) + "'";
        if (!/^SIRK_ACCESS_KEY_HASH=.*$/m.test(current)) throw new Error("Access key hash entry is missing.");
        writeAtomic(targetPath, current.replace(/^SIRK_ACCESS_KEY_HASH=.*$/m, replacement));
        const origin = fileValue(current, "SIRK_PUBLIC_ORIGIN") || "https://central.sirkportal.com";
        emitInstallResult({ accessUrl: origin.replace(/\/+$/, "") + "/#access=" + accessKey, username: fileValue(current, "SIRK_ADMIN_USERNAME") || "admin" });
        return;
    }

    const password = await acquirePassword();
    if (password.length < 14) throw new Error("Password must contain at least 14 characters.");

    if (resetAdminPassword) {
        const current = fs.readFileSync(targetPath, "utf8");
        const replacement = "SIRK_ADMIN_PASSWORD_HASH='" + hashSecret(password) + "'";
        if (!/^SIRK_ADMIN_PASSWORD_HASH=.*$/m.test(current)) throw new Error("Admin password hash entry is missing.");
        writeAtomic(targetPath, current.replace(/^SIRK_ADMIN_PASSWORD_HASH=.*$/m, replacement));
        process.stdout.write("\nBreak-glass password updated. Restart Central and invalidate existing sessions.\n");
        return;
    }

    const websiteDomain = validateDomain("SIRK_WEBSITE_DOMAIN", environment("SIRK_WEBSITE_DOMAIN", "sirkportal.com"));
    const centralDomain = validateDomain("SIRK_CENTRAL_DOMAIN", environment("SIRK_CENTRAL_DOMAIN", "central." + websiteDomain));
    const authDomain = validateDomain("SIRK_AUTH_DOMAIN", environment("SIRK_AUTH_DOMAIN", "auth." + websiteDomain));
    const acmeEmail = environment("SIRK_ACME_EMAIL", "admin@" + websiteDomain);
    const adminUsername = environment("SIRK_ADMIN_USERNAME", "admin");
    const idleMinutes = integerSetting("SIRK_SESSION_IDLE_MINUTES", 30, 5, 1440);
    const absoluteHours = integerSetting("SIRK_SESSION_ABSOLUTE_HOURS", 8, 1, 168);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acmeEmail)) throw new Error("SIRK_ACME_EMAIL is invalid.");
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(adminUsername)) throw new Error("SIRK_ADMIN_USERNAME is invalid.");

    const centralOrigin = "https://" + centralDomain;
    const authOrigin = "https://" + authDomain;
    const accessKey = crypto.randomBytes(32).toString("base64url");
    const updaterToken = crypto.randomBytes(48).toString("base64url");
    const ssoSharedSecret = crypto.randomBytes(48).toString("base64url");
    const auditIntegrityKey = crypto.randomBytes(48).toString("base64url");
    const lines = [
        "NODE_ENV=production",
        "SIRK_BIND_HOST=0.0.0.0",
        "SIRK_PORT=8080",
        "SIRK_PUBLIC_ORIGIN=" + centralOrigin,
        "SIRK_AUTH_ORIGIN=" + authOrigin,
        "SIRK_AUTH_DOMAIN=" + authDomain,
        "SIRK_SSO_SHARED_SECRET='" + ssoSharedSecret + "'",
        "SIRK_ADMIN_USERNAME=" + adminUsername,
        "SIRK_ADMIN_PASSWORD_HASH='" + hashSecret(password) + "'",
        "SIRK_ACCESS_KEY_HASH='" + hashAccessKey(accessKey) + "'",
        "SIRK_AUDIT_INTEGRITY_KEY='" + auditIntegrityKey + "'",
        "SIRK_DATA_DIR=/var/lib/sirk-central",
        "SIRK_SESSION_IDLE_MINUTES=" + idleMinutes,
        "SIRK_SESSION_ABSOLUTE_HOURS=" + absoluteHours,
        "SIRK_TRUST_PROXY=true",
        "SIRK_UPDATER_TOKEN='" + updaterToken + "'",
        "SIRK_WEBSITE_DOMAIN=" + websiteDomain,
        "SIRK_CENTRAL_DOMAIN=" + centralDomain,
        "SIRK_ACME_EMAIL=" + acmeEmail,
        ""
    ];
    writeAtomic(targetPath, lines.join("\n"));
    emitInstallResult({ accessUrl: centralOrigin + "/#access=" + accessKey, username: adminUsername });
}

main().catch(error => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
});
