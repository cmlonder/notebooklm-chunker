import {
  appState,
  clearLocalSessionState,
  loadActiveProfile,
  persistActiveProfile,
} from "./state.js";
import { showLoading, hideLoading, updateLoginPromptUI, showToast, escapeHtml } from "./dom.js";
import { switchView, closeUserMenu } from "./navigation.js";

function doctorShowsReadyAuth(output) {
  return /OK\s+auth\s+/i.test(String(output || ""));
}

function parseDoctorStatus(output, label) {
  const match = String(output || "").match(
    new RegExp(`^(OK|WARN|FAIL)\\s+${label}\\s+(.+)$`, "im")
  );
  if (!match) {
    return { ok: false, detail: "Not checked" };
  }
  return {
    ok: match[1].toUpperCase() === "OK",
    detail: match[2].trim(),
  };
}

function summarizeSetupStatus(cliCheck, doctorResult) {
  const doctorOutput = String(doctorResult?.output || "");
  const cliReady = Boolean(cliCheck?.success);
  const notebooklmCli = parseDoctorStatus(doctorOutput, "notebooklm-cli");
  const playwright = parseDoctorStatus(doctorOutput, "playwright");
  const auth = parseDoctorStatus(doctorOutput, "auth");
  const pdfParser = parseDoctorStatus(doctorOutput, "pdf-parser");
  return {
    cliReady,
    cliVersion: cliReady ? String(cliCheck.output || "").trim() : "",
    cliDetail: cliReady
      ? (notebooklmCli.detail || String(cliCheck.output || "").trim())
      : String(cliCheck?.error || "The engine did not start."),
    playwrightReady: playwright.ok,
    playwrightDetail: playwright.detail,
    authReady: auth.ok,
    authDetail: auth.detail,
    pdfParserReady: pdfParser.ok,
    pdfParserDetail: pdfParser.detail,
    // Sign-in picks its own browser (installed Chrome/Edge, else it downloads
    // Chromium), so only the engine itself gates the app.
    readyForApp: cliReady,
    readyForLiveRun: cliReady && auth.ok,
    doctorOutput,
  };
}

function activeAccountLabel() {
  const profiles = appState.profiles || [];
  const active = profiles.find((p) => p.name === appState.activeProfile) || profiles.find((p) => p.active);
  if (!active) return "";
  return active.email || active.name;
}

function setCheck(key, ok, detail) {
  const badge = document.getElementById(`setup-${key}-badge`);
  const text = document.getElementById(`setup-${key}-detail`);
  if (badge) {
    badge.className = `setup-status-pill ${ok ? "setup-status-ok" : "setup-status-warn"}`;
    badge.textContent = ok ? "Ready" : "Needs attention";
  }
  if (text) text.textContent = detail;
}

function renderSetupView() {
  const status = appState.setupStatus || {};
  const summary = document.getElementById("setup-doctor-summary");
  const signInButton = document.getElementById("setup-login-btn");
  const account = activeAccountLabel();

  setCheck("cli", Boolean(status.cliReady), status.cliReady
    ? (status.cliVersion || "Ready")
    : (status.cliDetail || "The engine did not start. Reinstall the app."));
  setCheck("playwright", Boolean(status.playwrightReady), status.playwrightDetail || "Not checked");
  setCheck("auth", Boolean(status.authReady), status.authDetail || "Not signed in");
  setCheck("pdf", Boolean(status.pdfParserReady), status.pdfParserDetail || "Not checked");

  if (summary) {
    summary.textContent = !status.cliReady
      ? "The app's engine did not start. Reinstall the app, then open Details."
      : appState.isAuthenticated
      ? `Signed in${account ? ` as ${account}` : ""}.`
      : "Sign in once with your Google account. A browser window opens for it.";
  }
  if (signInButton) {
    signInButton.classList.toggle("hidden", appState.isAuthenticated);
    signInButton.disabled = !status.cliReady || appState.loginProcessActive;
  }
  const sidebarAccount = document.getElementById("sidebar-account");
  if (sidebarAccount) {
    sidebarAccount.textContent = account;
    sidebarAccount.title = account;
  }
  renderProfileSelector();
}

async function refreshSetupStatus({ showSpinner = false } = {}) {
  if (showSpinner) {
    showLoading("Starting…");
  }
  try {
    const cliCheck = await window.electronAPI.checkNBLM();
    let doctorResult = { output: "", success: false };
    if (cliCheck.success) {
      doctorResult = await window.electronAPI.runNBLM({ command: "doctor", args: [] });
    }
    appState.setupStatus = summarizeSetupStatus(cliCheck, doctorResult);
    appState.isAuthenticated = Boolean(appState.setupStatus.readyForLiveRun);
    if (cliCheck.success) {
      await loadProfiles();
    }
    renderSetupView();
    return appState.setupStatus;
  } finally {
    if (showSpinner) {
      hideLoading();
    }
  }
}

async function applyActiveProfile(name) {
  appState.activeProfile = name || null;
  persistActiveProfile(appState.activeProfile);
  try {
    await window.electronAPI.setActiveProfile(appState.activeProfile);
  } catch (error) {
    // Non-fatal: the engine falls back to the default profile.
  }
}

async function loadProfiles() {
  try {
    const result = await window.electronAPI.runNBLM({ command: "list-profiles", args: [] });
    if (!result.success) return;
    const profiles = JSON.parse(String(result.output || "[]").trim() || "[]");
    appState.profiles = Array.isArray(profiles) ? profiles : [];
  } catch (error) {
    appState.profiles = [];
    return;
  }

  // Reconcile the persisted selection with what actually exists on disk.
  const stored = appState.activeProfile || loadActiveProfile();
  const names = appState.profiles.map((p) => p.name);
  let chosen = stored && names.includes(stored) ? stored : null;
  if (!chosen) {
    const active = appState.profiles.find((p) => p.active);
    chosen = active ? active.name : names[0] || null;
  }
  if (chosen !== appState.activeProfile) {
    await applyActiveProfile(chosen);
  } else {
    await window.electronAPI.setActiveProfile(chosen);
  }
  renderProfileSelector();
}

function renderProfileSelector() {
  const row = document.getElementById("setup-account-row");
  const select = document.getElementById("setup-profile-select");
  if (!row || !select) return;
  const profiles = appState.profiles || [];
  // Nothing to choose from before the first sign-in.
  if (profiles.length < 1 || !appState.isAuthenticated) {
    row.classList.add("hidden");
    return;
  }
  row.classList.remove("hidden");
  select.innerHTML = profiles
    .map((p) => {
      const label = p.email ? `${p.name} · ${p.email}` : p.name;
      const selected = p.name === appState.activeProfile ? " selected" : "";
      return `<option value="${escapeHtml(p.name)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

async function switchProfile(name) {
  if (!name || name === appState.activeProfile) return;
  showLoading(`Switching to ${name}...`);
  try {
    await applyActiveProfile(name);
    await refreshSetupStatus();
    showToast(`Active account: ${name}`);
  } catch (error) {
    alert(error.message);
  } finally {
    hideLoading();
  }
}

async function addAccount() {
  const name = (window.prompt(
    "Name for the new account (e.g. work):",
  ) || "").trim();
  if (!name) return;
  if ((appState.profiles || []).some((p) => p.name === name)) {
    alert(`A profile named "${name}" already exists. Pick it from the list to use it.`);
    return;
  }
  appState.loginProcessActive = true;
  appState.loginAwaitingEnter = false;
  updateLoginPromptUI();
  showLoading(`Finish signing in to "${name}" in the browser window.`);
  try {
    const result = await window.electronAPI.runNBLM({
      command: "login",
      args: ["--profile", name],
    });
    if (!result.success) {
      throw new Error(result.error || result.output || "NotebookLM login failed.");
    }
    await applyActiveProfile(name);
    appState.loginProcessActive = false;
    appState.loginAwaitingEnter = false;
    updateLoginPromptUI();
    await confirmLogin();
  } catch (error) {
    appState.loginProcessActive = false;
    appState.loginAwaitingEnter = false;
    hideLoading();
    updateLoginPromptUI();
    alert(error.message);
  }
}

async function login() {
  if (appState.loginProcessActive) return;
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
  appState.loginProcessActive = true;
  appState.loginAwaitingEnter = false;
  updateLoginPromptUI();
  showLoading("Finish signing in in the browser window.");
  try {
    const result = await window.electronAPI.runNBLM({ command: "login", args: [] });
    if (!result.success) {
      throw new Error(result.error || result.output || "NotebookLM login failed.");
    }
    appState.loginProcessActive = false;
    appState.loginAwaitingEnter = false;
    updateLoginPromptUI();
    await confirmLogin();
  } catch (error) {
    appState.loginProcessActive = false;
    appState.loginAwaitingEnter = false;
    hideLoading();
    updateLoginPromptUI();
    alert(error.message);
  }
}

async function confirmLogin() {
  showLoading("Checking NotebookLM session...");
  try {
    const result = await window.electronAPI.runNBLM({ command: "doctor", args: [] });
    if (!doctorShowsReadyAuth(result.output)) {
      throw new Error("Sign-in did not complete. Finish it in the browser window and try again.");
    }
    appState.isAuthenticated = true;
    appState.setupStatus = summarizeSetupStatus({ success: true, output: appState.setupStatus?.cliVersion || "nblm" }, result);
    appState.loginProcessActive = false;
    appState.loginAwaitingEnter = false;
    updateLoginPromptUI();
    switchView("history");
  } catch (error) {
    alert(error.message);
  } finally {
    hideLoading();
  }
}

async function sendEnterToProcess() {
  if (!appState.loginProcessActive || !appState.loginAwaitingEnter) return;
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
  await window.electronAPI.sendNBLMInput("\n");
}

async function logout() {
  showLoading("Signing out...");
  try {
    const result = await window.electronAPI.runNBLM({ command: "logout", args: [] });
    if (!result.success) {
      throw new Error(result.error || result.output || "NotebookLM logout failed.");
    }
    clearLocalSessionState();
    await refreshSetupStatus();
    switchView("setup");
    showToast("Signed out.");
  } catch (error) {
    alert(error.message);
  } finally {
    hideLoading();
  }
}

async function switchAccount() {
  showLoading("Switching account...");
  try {
    await window.electronAPI.runNBLM({ command: "logout", args: [] });
    clearLocalSessionState();
    await refreshSetupStatus();
    switchView("setup");
    hideLoading();
    await login();
  } catch (error) {
    hideLoading();
    alert(error.message);
  }
}

function openSetupView() {
  closeUserMenu();
  switchView("setup");
}

async function recheckDesktopSetup() {
  await refreshSetupStatus({ showSpinner: true });
  if (appState.setupStatus?.readyForLiveRun) {
    switchView("history");
    return;
  }
  switchView("setup");
}

export {
  doctorShowsReadyAuth,
  parseDoctorStatus,
  summarizeSetupStatus,
  renderSetupView,
  refreshSetupStatus,
  login,
  confirmLogin,
  sendEnterToProcess,
  logout,
  switchAccount,
  openSetupView,
  recheckDesktopSetup,
  switchProfile,
  addAccount,
  loadProfiles,
  applyActiveProfile,
};
