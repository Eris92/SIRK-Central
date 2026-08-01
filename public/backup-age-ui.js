"use strict";

(function () {
  const COPY = {
    pl: {
      title: "Szyfrowanie backupu age",
      help: "Wygeneruj parę kluczy dla zaszyfrowanych backupów. Central zapisze wyłącznie publiczny recipient.",
      warning: "Prywatny klucz zostanie pobrany tylko raz. Zachowaj go poza serwerem. Rotacja nie odszyfruje starych backupów bez poprzedniego klucza.",
      currentPassword: "Aktualne hasło Break-Glass",
      confirm: "Rozumiem, że bez prywatnego klucza backupów nie będzie można odzyskać.",
      generate: "Wygeneruj i pobierz klucz",
      rotate: "Wygeneruj i pobierz nowy klucz",
      notConfigured: "Recipient age nie jest skonfigurowany.",
      configured: "Skonfigurowany recipient",
      source: "Źródło",
      generating: "Generowanie i przygotowanie pobrania...",
      downloaded: "Klucz prywatny został pobrany. Central zachował tylko publiczny recipient.",
      passwordInvalid: "Aktualne hasło Break-Glass jest nieprawidłowe.",
      rotateConfirm: "Zostanie utworzony nowy recipient. Zachowaj dotychczasowy klucz do odszyfrowania starszych backupów. Kontynuować?",
      requestFailed: "Nie udało się wygenerować klucza age."
    },
    en: {
      title: "age backup encryption",
      help: "Generate a key pair for encrypted backups. Central stores only the public recipient.",
      warning: "The private identity is downloaded once. Store it off-server. Rotation does not make old backups decryptable without the previous key.",
      currentPassword: "Current Break-Glass password",
      confirm: "I understand backups cannot be recovered without the private identity.",
      generate: "Generate and download key",
      rotate: "Generate and download new key",
      notConfigured: "The age recipient is not configured.",
      configured: "Configured recipient",
      source: "Source",
      generating: "Generating and preparing download...",
      downloaded: "The private identity was downloaded. Central retained only the public recipient.",
      passwordInvalid: "The current Break-Glass password is invalid.",
      rotateConfirm: "A new recipient will be created. Keep the current key to decrypt older backups. Continue?",
      requestFailed: "Unable to generate the age key."
    }
  };

  let currentStatus = null;
  let elements = null;

  function lang() {
    return document.documentElement.lang === "en" ? "en" : "pl";
  }

  function text(key) {
    return COPY[lang()][key];
  }

  function setMessage(value, className) {
    elements.message.textContent = value;
    elements.message.className = className || "muted";
  }

  function updateButtonState() {
    elements.button.disabled = !elements.password.value || !elements.confirm.checked;
  }

  function renderCopy() {
    if (!elements) return;
    elements.title.textContent = text("title");
    elements.help.textContent = text("help");
    elements.warning.textContent = text("warning");
    elements.passwordLabel.textContent = text("currentPassword");
    elements.confirmText.textContent = text("confirm");
    renderStatus();
  }

  function renderStatus() {
    if (!elements) return;
    if (!currentStatus || !currentStatus.configured) {
      elements.status.textContent = text("notConfigured");
      elements.recipient.hidden = true;
      elements.button.textContent = text("generate");
      return;
    }
    elements.status.textContent = text("configured") + " · " + text("source") + ": " + currentStatus.source;
    elements.recipient.textContent = currentStatus.recipient;
    elements.recipient.hidden = false;
    elements.button.textContent = text("rotate");
  }

  async function loadStatus() {
    try {
      const response = await fetch("/api/break-glass/backup-age/status", { credentials: "same-origin" });
      if (!response.ok) return;
      currentStatus = await response.json();
      renderStatus();
    } catch (_) {
      /* The Break-Glass panel remains usable even if status refresh fails. */
    }
  }

  async function parseError(response) {
    try {
      const body = await response.json();
      return body.error || text("requestFailed");
    } catch (_) {
      return text("requestFailed");
    }
  }

  async function generate(event) {
    event.preventDefault();
    if (currentStatus && currentStatus.configured && !window.confirm(text("rotateConfirm"))) return;

    elements.button.disabled = true;
    setMessage(text("generating"), "muted");
    try {
      const response = await fetch("/api/break-glass/backup-age/identity", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: elements.password.value,
          confirm: "GENERATE AGE BACKUP KEY"
        })
      });
      if (!response.ok) {
        const message = await parseError(response);
        throw Object.assign(new Error(message), { status: response.status });
      }

      const recipient = response.headers.get("x-sirk-age-recipient") || "";
      let identityBlob = await response.blob();
      const objectUrl = URL.createObjectURL(identityBlob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = "sirk-central-backup.agekey";
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      identityBlob = null;

      elements.password.value = "";
      elements.confirm.checked = false;
      currentStatus = {
        ok: true,
        configured: true,
        source: "break-glass-ui",
        recipient
      };
      renderStatus();
      setMessage(text("downloaded"), "success");
    } catch (error) {
      setMessage(error.status === 401 ? text("passwordInvalid") : error.message || text("requestFailed"), "error");
    } finally {
      updateButtonState();
    }
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
      '  <button id="backupAgeGenerateButton" type="submit" disabled></button>',
      '  <p id="backupAgeMessage" class="muted" role="status"></p>',
      '</form>'
    ].join("");
    grid.append(card);

    elements = {
      title: document.getElementById("backupAgeKeyTitle"),
      help: document.getElementById("backupAgeKeyHelp"),
      warning: document.getElementById("backupAgeKeyWarning"),
      status: document.getElementById("backupAgeKeyStatus"),
      recipient: document.getElementById("backupAgeRecipient"),
      form: document.getElementById("backupAgeKeyForm"),
      passwordLabel: document.getElementById("backupAgePasswordLabel"),
      password: document.getElementById("backupAgePassword"),
      confirm: document.getElementById("backupAgeConfirm"),
      confirmText: document.getElementById("backupAgeConfirmText"),
      button: document.getElementById("backupAgeGenerateButton"),
      message: document.getElementById("backupAgeMessage")
    };

    elements.password.addEventListener("input", updateButtonState);
    elements.confirm.addEventListener("change", updateButtonState);
    elements.form.addEventListener("submit", generate);
    document.getElementById("breakGlassButton")?.addEventListener("click", loadStatus);
    new MutationObserver(renderCopy).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    renderCopy();
  }

  install();
}());
