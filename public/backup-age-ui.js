"use strict";

(function () {
  const COPY = {
    pl: {
      title: "Klucz szyfrowania backupów",
      help: "Prywatny klucz age pozostaje w Central zaszyfrowany hasłem Break-Glass. Restore wymaga tylko znajomości tego hasła.",
      warning: "Eksport zawiera wyłącznie zaszyfrowany klucz. Przechowuj go poza serwerem jako kopię awaryjną.",
      currentPassword: "Aktualne hasło Break-Glass",
      confirm: "Rozumiem, że rotacja utworzy nowy klucz dla kolejnych backupów.",
      generate: "Wygeneruj klucz",
      rotate: "Rotuj klucz",
      export: "Eksportuj zaszyfrowany klucz",
      notConfigured: "Klucz age nie jest skonfigurowany.",
      configured: "Klucz zapisany lokalnie i zaszyfrowany",
      migration: "Wymagana rotacja: zapisany jest tylko publiczny recipient starego mechanizmu.",
      source: "Źródło",
      rotation: "Rotacja",
      processing: "Przetwarzanie klucza...",
      downloaded: "Zaszyfrowany eksport klucza został pobrany. Klucz pozostaje bezpiecznie zapisany w Central.",
      passwordInvalid: "Aktualne hasło Break-Glass jest nieprawidłowe.",
      rotateConfirm: "Nowe backupy będą szyfrowane nowym kluczem. Starsze backupy wymagają eksportu poprzedniego klucza. Kontynuować?",
      requestFailed: "Operacja klucza age nie powiodła się."
    },
    en: {
      title: "Backup encryption key",
      help: "The private age identity remains in Central encrypted with the Break-Glass password. Restore requires only that password.",
      warning: "The export contains only the encrypted key. Store it off-server as a recovery copy.",
      currentPassword: "Current Break-Glass password",
      confirm: "I understand rotation creates a new key for subsequent backups.",
      generate: "Generate key",
      rotate: "Rotate key",
      export: "Export encrypted key",
      notConfigured: "The age key is not configured.",
      configured: "Key persisted locally and encrypted",
      migration: "Rotation required: only a public recipient from the old mechanism is stored.",
      source: "Source",
      rotation: "Rotation",
      processing: "Processing key...",
      downloaded: "The encrypted key export was downloaded. The key remains securely stored in Central.",
      passwordInvalid: "The current Break-Glass password is invalid.",
      rotateConfirm: "New backups will use a new key. Older backups require the previous key export. Continue?",
      requestFailed: "The age key operation failed."
    }
  };

  let currentStatus = null;
  let elements = null;

  function lang() { return document.documentElement.lang === "en" ? "en" : "pl"; }
  function text(key) { return COPY[lang()][key]; }
  function setMessage(value, className) {
    elements.message.textContent = value;
    elements.message.className = className || "muted";
  }
  function updateButtonState() {
    const passwordPresent = Boolean(elements.password.value);
    elements.button.disabled = !passwordPresent || !elements.confirm.checked;
    elements.exportButton.disabled = !passwordPresent || !currentStatus || !currentStatus.keyPersisted;
  }
  function renderCopy() {
    if (!elements) return;
    elements.title.textContent = text("title");
    elements.help.textContent = text("help");
    elements.warning.textContent = text("warning");
    elements.passwordLabel.textContent = text("currentPassword");
    elements.confirmText.textContent = text("confirm");
    elements.exportButton.textContent = text("export");
    renderStatus();
  }
  function renderStatus() {
    if (!elements) return;
    if (!currentStatus || !currentStatus.configured) {
      elements.status.textContent = text("notConfigured");
      elements.recipient.hidden = true;
      elements.button.textContent = text("generate");
      updateButtonState();
      return;
    }
    const suffix = currentStatus.rotation ? " · " + text("rotation") + ": " + currentStatus.rotation : "";
    elements.status.textContent = (currentStatus.migrationRequired ? text("migration") : text("configured")) +
      " · " + text("source") + ": " + currentStatus.source + suffix;
    elements.recipient.textContent = currentStatus.recipient;
    elements.recipient.hidden = false;
    elements.button.textContent = text("rotate");
    updateButtonState();
  }
  async function loadStatus() {
    try {
      const response = await fetch("/api/break-glass/backup-age/status", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
      currentStatus = await response.json();
      renderStatus();
    } catch (_) { /* keep panel usable */ }
  }
  async function parseError(response) {
    try {
      const body = await response.json();
      return body.error || text("requestFailed");
    } catch (_) { return text("requestFailed"); }
  }
  async function downloadResponse(response) {
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "sirk-central-backup-key.sirkkey";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
  async function requestKey(route, body) {
    const response = await fetch(route, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw Object.assign(new Error(await parseError(response)), { status: response.status });
    await downloadResponse(response);
    return response;
  }
  async function generate(event) {
    event.preventDefault();
    if (currentStatus && currentStatus.configured && !window.confirm(text("rotateConfirm"))) return;
    elements.button.disabled = true;
    elements.exportButton.disabled = true;
    setMessage(text("processing"), "muted");
    try {
      const response = await requestKey("/api/break-glass/backup-age/identity", {
        currentPassword: elements.password.value,
        confirm: "GENERATE AGE BACKUP KEY"
      });
      currentStatus = {
        ok: true,
        configured: true,
        source: "break-glass-ui",
        recipient: response.headers.get("x-sirk-age-recipient") || "",
        keyPersisted: true,
        migrationRequired: false,
        rotation: Number(response.headers.get("x-sirk-age-key-rotation") || 1)
      };
      elements.password.value = "";
      elements.confirm.checked = false;
      renderStatus();
      setMessage(text("downloaded"), "success");
    } catch (error) {
      setMessage(error.status === 401 ? text("passwordInvalid") : error.message || text("requestFailed"), "error");
    } finally { updateButtonState(); }
  }
  async function exportKey() {
    elements.button.disabled = true;
    elements.exportButton.disabled = true;
    setMessage(text("processing"), "muted");
    try {
      await requestKey("/api/break-glass/backup-age/export", { currentPassword: elements.password.value });
      elements.password.value = "";
      setMessage(text("downloaded"), "success");
    } catch (error) {
      setMessage(error.status === 401 ? text("passwordInvalid") : error.message || text("requestFailed"), "error");
    } finally { updateButtonState(); }
  }
  function install() {
    const view = document.getElementById("breakGlassView");
    const grid = view && view.querySelector(".settings-grid");
    if (!grid || document.getElementById("backupAgeKeyCard")) return;
    const card = document.createElement("article");
    card.id = "backupAgeKeyCard";
    card.className = "settings-card danger-card";
    card.innerHTML = [
      '<h2 id="backupAgeKeyTitle"></h2>',
      '<p id="backupAgeKeyHelp" class="muted"></p>',
      '<p id="backupAgeKeyWarning" class="error"></p>',
      '<p id="backupAgeKeyStatus" class="muted"></p>',
      '<code id="backupAgeRecipient" class="secret-output" hidden></code>',
      '<form id="backupAgeKeyForm" class="stack-form">',
      '  <label><span id="backupAgePasswordLabel"></span><input id="backupAgePassword" type="password" autocomplete="current-password" required></label>',
      '  <label class="checkbox-row"><input id="backupAgeConfirm" type="checkbox"><span id="backupAgeConfirmText"></span></label>',
      '  <div class="button-row"><button id="backupAgeGenerateButton" type="submit" disabled></button><button id="backupAgeExportButton" type="button" class="secondary" disabled></button></div>',
      '  <p id="backupAgeMessage" class="muted" role="status"></p>',
      '</form>'
    ].join("");
    grid.append(card);
    elements = {
      title: document.getElementById("backupAgeKeyTitle"), help: document.getElementById("backupAgeKeyHelp"),
      warning: document.getElementById("backupAgeKeyWarning"), status: document.getElementById("backupAgeKeyStatus"),
      recipient: document.getElementById("backupAgeRecipient"), form: document.getElementById("backupAgeKeyForm"),
      passwordLabel: document.getElementById("backupAgePasswordLabel"), password: document.getElementById("backupAgePassword"),
      confirm: document.getElementById("backupAgeConfirm"), confirmText: document.getElementById("backupAgeConfirmText"),
      button: document.getElementById("backupAgeGenerateButton"), exportButton: document.getElementById("backupAgeExportButton"),
      message: document.getElementById("backupAgeMessage")
    };
    elements.password.addEventListener("input", updateButtonState);
    elements.confirm.addEventListener("change", updateButtonState);
    elements.form.addEventListener("submit", generate);
    elements.exportButton.addEventListener("click", exportKey);
    document.getElementById("breakGlassButton")?.addEventListener("click", loadStatus);
    new MutationObserver(renderCopy).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    renderCopy();
    loadStatus();
  }
  install();
}());
