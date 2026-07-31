"use strict";

function errorText(error) {
    return String(error && (error.stack || error.message) || error || "Unknown restore error").slice(0, 8000);
}

function run(options) {
    const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
    const base = {
        backup: options.backupName,
        safetyBackup: options.safetyBackupName,
        startedAtUtc: now()
    };
    let servicesStopped = false;
    let destructivePhase = false;

    options.writeStatus(Object.assign({}, base, { state: "stopping", running: true }));
    try {
        options.stopServices();
        servicesStopped = true;
        destructivePhase = true;
        options.writeStatus(Object.assign({}, base, { state: "restoring", running: true }));
        options.replaceData(options.targetArchive);
        options.writeStatus(Object.assign({}, base, { state: "starting", running: true }));
        options.startServices();
        servicesStopped = false;
        options.waitHealthy();
        const completed = Object.assign({}, base, { state: "completed", running: false, finishedAtUtc: now() });
        options.writeStatus(completed);
        return completed;
    } catch (error) {
        const originalError = errorText(error);
        if (destructivePhase) {
            try {
                options.writeStatus(Object.assign({}, base, { state: "rollback", running: true, error: originalError }));
                if (!servicesStopped) {
                    options.stopServices();
                    servicesStopped = true;
                }
                options.replaceData(options.safetyArchive);
                options.startServices();
                servicesStopped = false;
                options.waitHealthy();
                const rolledBack = Object.assign({}, base, {
                    state: "rolled_back",
                    running: false,
                    finishedAtUtc: now(),
                    error: originalError,
                    rollback: "safety-backup-restored"
                });
                options.writeStatus(rolledBack);
                return rolledBack;
            } catch (rollbackError) {
                const rollbackFailed = Object.assign({}, base, {
                    state: "rollback_failed",
                    running: false,
                    finishedAtUtc: now(),
                    error: originalError,
                    rollbackError: errorText(rollbackError)
                });
                options.writeStatus(rollbackFailed);
                return rollbackFailed;
            }
        }

        if (servicesStopped) {
            try {
                options.startServices();
                options.waitHealthy();
            } catch (startError) {
                const failedStart = Object.assign({}, base, {
                    state: "failed",
                    running: false,
                    finishedAtUtc: now(),
                    error: originalError,
                    recoveryError: errorText(startError)
                });
                options.writeStatus(failedStart);
                return failedStart;
            }
        }
        const failed = Object.assign({}, base, { state: "failed", running: false, finishedAtUtc: now(), error: originalError });
        options.writeStatus(failed);
        return failed;
    }
}

module.exports = { run, errorText };
