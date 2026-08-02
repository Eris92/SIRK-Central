"use strict";

(function () {
  var language = localStorage.getItem("sirk-language") === "en" ? "en" : "pl";
  var dictionary = {
    pl: {
      back: "Powrót", title: "Rejestracja Portali",
      subtitle: "Jednorazowy token, zatwierdzenie administratora i szyfrowany bootstrap RSA-OAEP + AES-GCM.",
      newToken: "Nowy token enrollment", label: "Opis", ttl: "Ważność (minuty)", generate: "Generuj token",
      copyNow: "Skopiuj teraz — token jest zwracany tylko raz.", copy: "Kopiuj",
      requests: "Requesty enrollment", requestsHint: "Zatwierdzenie tworzy Portal i szyfruje credential dla jego klucza RSA.",
      refresh: "Odśwież", portal: "Portal", version: "Wersja / platforma", created: "Utworzono", state: "Status",
      operations: "Operacje", empty: "Brak requestów enrollment.", approve: "Zatwierdź", reject: "Odrzuć",
      copied: "Token skopiowany.", issued: "Token wygenerowany.", approved: "Portal zatwierdzony.", rejected: "Request odrzucony.",
      loading: "Ładowanie...", error: "Błąd"
    },
    en: {
      back: "Back", title: "Portal enrollment",
      subtitle: "One-time token, administrator approval and RSA-OAEP + AES-GCM encrypted bootstrap.",
      newToken: "New enrollment token", label: "Label", ttl: "Validity (minutes)", generate: "Generate token",
      copyNow: "Copy now — the token is returned only once.", copy: "Copy",
      requests: "Enrollment requests", requestsHint: "Approval creates the Portal and encrypts credentials for its RSA key.",
      refresh: "Refresh", portal: "Portal", version: "Version / platform", created: "Created", state: "Status",
      operations: "Operations", empty: "No enrollment requests.", approve: "Approve", reject: "Reject",
      copied: "Token copied.", issued: "Token generated.", approved: "Portal approved.", rejected: "Request rejected.",
      loading: "Loading...", error: "Error"
    }
  };

  function t(key) { return dictionary[language][key] || key; }
  function cookie(name) {
    var parts = String(document.cookie || "").split(";");
    for (var i = 0; i < parts.length; i += 1) {
      var pair = parts[i].trim().split("=");
      if (pair.shift() === name) return decodeURIComponent(pair.join("="));
    }
    return "";
  }
  function setStatus(message, isError) {
    var element = document.getElementById("status");
    element.textContent = message || "";
    element.style.color = isError ? "#ff9090" : "#9ed0ff";
  }
  async function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ "Accept": "application/json" }, options.headers || {});
    if (options.method && options.method !== "GET") {
      options.headers["Content-Type"] = "application/json";
      options.headers["X-SIRK-CSRF"] = cookie("sirk_central_csrf");
    }
    var response = await fetch(path, options);
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.error || "HTTP " + response.status);
    return body;
  }
  function applyLanguage() {
    document.documentElement.lang = language;
    document.getElementById("language").textContent = language === "pl" ? "EN" : "PL";
    document.querySelectorAll("[data-i18n]").forEach(function (element) {
      element.textContent = t(element.getAttribute("data-i18n"));
    });
  }
  function formatDate(value) {
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(language === "pl" ? "pl-PL" : "en-GB");
  }
  function button(label, className, callback) {
    var element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    if (className) element.className = className;
    element.addEventListener("click", callback);
    return element;
  }
  function cell() { return document.createElement("td"); }
  function renderRows(requests) {
    var body = document.getElementById("requests-body");
    var empty = document.getElementById("empty");
    body.textContent = "";
    empty.classList.toggle("hidden", requests.length !== 0);
    requests.forEach(function (request) {
      var row = document.createElement("tr");
      var portal = cell();
      var strong = document.createElement("strong");
      strong.textContent = request.portalName || request.portalId;
      var small = document.createElement("small");
      small.textContent = request.portalId + (request.publicUrl ? " · " + request.publicUrl : "");
      portal.append(strong, small);

      var version = cell();
      version.textContent = request.version || "—";
      var platform = document.createElement("small");
      platform.textContent = request.platform || "—";
      version.appendChild(platform);

      var created = cell();
      created.textContent = formatDate(request.createdAtUtc);
      var expires = document.createElement("small");
      expires.textContent = "Expires: " + formatDate(request.expiresAtUtc);
      created.appendChild(expires);

      var state = cell();
      var badge = document.createElement("span");
      badge.className = "badge " + request.status;
      badge.textContent = request.status;
      state.appendChild(badge);

      var operations = cell();
      var actions = document.createElement("div");
      actions.className = "row-actions";
      if (request.status === "pending") {
        actions.append(
          button(t("approve"), "", function () { approve(request.id); }),
          button(t("reject"), "reject", function () { rejectRequest(request.id); })
        );
      }
      operations.appendChild(actions);
      row.append(portal, version, created, state, operations);
      body.appendChild(row);
    });
  }
  async function loadRequests() {
    setStatus(t("loading"), false);
    try {
      var result = await api("/api/portal-enrollment/requests");
      renderRows(result.requests || []);
      setStatus("", false);
    } catch (error) { setStatus(t("error") + ": " + error.message, true); }
  }
  async function issueToken() {
    setStatus(t("loading"), false);
    try {
      var result = await api("/api/portal-enrollment/tokens", {
        method: "POST",
        body: JSON.stringify({
          label: document.getElementById("token-label").value,
          ttlMinutes: Number(document.getElementById("token-ttl").value || 30)
        })
      });
      var token = result.enrollmentToken;
      document.getElementById("token-value").textContent = token.token;
      document.getElementById("token-expiry").textContent = "Expires: " + formatDate(token.expiresAtUtc);
      document.getElementById("token-result").classList.remove("hidden");
      setStatus(t("issued"), false);
    } catch (error) { setStatus(t("error") + ": " + error.message, true); }
  }
  async function approve(id) {
    try {
      await api("/api/portal-enrollment/requests/" + encodeURIComponent(id) + "/approve", { method: "POST", body: "{}" });
      setStatus(t("approved"), false);
      await loadRequests();
    } catch (error) { setStatus(t("error") + ": " + error.message, true); }
  }
  async function rejectRequest(id) {
    try {
      await api("/api/portal-enrollment/requests/" + encodeURIComponent(id) + "/reject", { method: "POST", body: "{}" });
      setStatus(t("rejected"), false);
      await loadRequests();
    } catch (error) { setStatus(t("error") + ": " + error.message, true); }
  }

  document.getElementById("language").addEventListener("click", function () {
    language = language === "pl" ? "en" : "pl";
    localStorage.setItem("sirk-language", language);
    applyLanguage();
    loadRequests();
  });
  document.getElementById("issue-token").addEventListener("click", issueToken);
  document.getElementById("refresh").addEventListener("click", loadRequests);
  document.getElementById("copy-token").addEventListener("click", async function () {
    await navigator.clipboard.writeText(document.getElementById("token-value").textContent);
    setStatus(t("copied"), false);
  });

  applyLanguage();
  loadRequests();
  setInterval(loadRequests, 10000);
}());
