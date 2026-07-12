import { appState, clearLocalSessionState } from "./state.js";
import { showLoading, hideLoading, updateLoginPromptUI, showToast } from "./dom.js";
import { switchView, closeUserMenu } from "./navigation.js";

function doctorShowsReadyAuth(output) {
  return /OK\s+auth\s+/i.test(String(output || ""));
}

function parseDoctorStatus(output, label) {
  const match = String(output || "").match(new RegExp(`^(OK|FAIL)\\s+${label}\\s+(.+)$`, "im"));
  if (!match) {
    return { ok: false, detail: "Not checked" };
  }
  return {
    ok: match[1] === "OK",
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
      : String(cliCheck?.error || "nblm was not found on PATH."),
    playwrightReady: playwright.ok,
    playwrightDetail: playwright.detail,
    authReady: auth.ok,
    authDetail: auth.detail,
    pdfParserReady: pdfParser.ok,
    pdfParserDetail: pdfParser.detail,
    readyForApp: cliReady && playwright.ok,
    readyForLiveRun: cliReady && playwright.ok && auth.ok,
    doctorOutput,
  };
}

function renderSetupView() {
  const status = appState.setupStatus || {};
  const cliBadge = document.getElementById("setup-cli-badge");
  const cliDetail = document.getElementById("setup-cli-detail");
  const playwrightBadge = document.getElementById("setup-playwright-badge");
  const playwrightDetail = document.getElementById("setup-playwright-detail");
  const authBadge = document.getElementById("setup-auth-badge");
  const authDetail = document.getElementById("setup-auth-detail");
  const pdfBadge = document.getElementById("setup-pdf-badge");
  const pdfDetail = document.getElementById("setup-pdf-detail");
  const doctorSummary = document.getElementById("setup-doctor-summary");
  const signInButton = document.getElementById("setup-login-btn");
  const actionRow = document.getElementById("setup-action-row");
  const loginActions = document.getElementById("setup-login-actions");
  const loggedInNotice = document.getElementById("setup-logged-in-note");
  const showLoginActions = !appState.isAuthenticated;
  const statusClass = (ok) => ok ? "setup-status-ok" : "setup-status-warn";
  const statusText = (ok) => ok ? "Ready" : "Action needed";

  if (cliBadge) {
    cliBadge.className = `setup-status-pill ${statusClass(Boolean(status.cliReady))}`;
    cliBadge.textContent = statusText(Boolean(status.cliReady));
  }
  if (cliDetail) {
    cliDetail.textContent = status.cliReady
      ? (status.cliVersion || status.cliDetail || "nblm is available.")
      : (status.cliDetail || "Install notebooklm-chunker first so the desktop app can call nblm.");
  }
  if (playwrightBadge) {
    playwrightBadge.className = `setup-status-pill ${statusClass(Boolean(status.playwrightReady))}`;
    playwrightBadge.textContent = statusText(Boolean(status.playwrightReady));
  }
  if (playwrightDetail) {
    playwrightDetail.textContent = status.playwrightReady
      ? (status.playwrightDetail || "Chromium is ready.")
      : (status.playwrightDetail || "Run `python -m playwright install chromium`.");
  }
  if (authBadge) {
    authBadge.className = `setup-status-pill ${statusClass(Boolean(status.authReady))}`;
    authBadge.textContent = statusText(Boolean(status.authReady));
  }
  if (authDetail) {
    authDetail.textContent = status.authReady
      ? (status.authDetail || "NotebookLM login is ready.")
      : (status.authDetail || "Sign in once to unlock sync and Studio generation.");
  }
  if (pdfBadge) {
    pdfBadge.className = `setup-status-pill ${statusClass(Boolean(status.pdfParserReady))}`;
    pdfBadge.textContent = statusText(Boolean(status.pdfParserReady));
  }
  if (pdfDetail) {
    pdfDetail.textContent = status.pdfParserReady
      ? (status.pdfParserDetail || "PyMuPDF is available.")
      : (status.pdfParserDetail || "Install the PDF parser dependency.");
  }
  if (doctorSummary) {
    doctorSummary.textContent = status.readyForLiveRun
      ? "This machine is ready for chunking, sync, and Studio generation."
      : status.readyForApp
      ? "Desktop is ready. Sign in once to unlock live NotebookLM sync and Studio generation."
      : "Finish the setup items below before using the desktop app.";
  }
  if (actionRow) {
    actionRow.classList.toggle("setup-action-row-compact", appState.isAuthenticated);
  }
  if (loginActions) {
    loginActions.classList.toggle("hidden", !showLoginActions);
    loginActions.style.display = showLoginActions ? "flex" : "none";
  }
  if (loggedInNotice) {
    loggedInNotice.classList.toggle("hidden", !appState.isAuthenticated);
    if (appState.isAuthenticated) {
      loggedInNotice.textContent = "You are already signed in. Use this screen only to recheck the local CLI and browser prerequisites.";
    }
  }
  if (signInButton) {
    signInButton.disabled = !status.readyForApp;
  }
}

async function refreshSetupStatus({ showSpinner = false } = {}) {
  if (showSpinner) {
    showLoading("Checking desktop setup...");
  }
  try {
    const cliCheck = await window.electronAPI.checkNBLM();
    let doctorResult = { output: "", success: false };
    if (cliCheck.success) {
      doctorResult = await window.electronAPI.runNBLM({ command: "doctor", args: [] });
    }
    appState.setupStatus = summarizeSetupStatus(cliCheck, doctorResult);
    appState.isAuthenticated = Boolean(appState.setupStatus.readyForLiveRun);
    renderSetupView();
    return appState.setupStatus;
  } finally {
    if (showSpinner) {
      hideLoading();
    }
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
  showLoading("Complete the NotebookLM login in your browser.");
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
      throw new Error("NotebookLM login is not ready yet. Finish login in the browser and try again.");
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
};
