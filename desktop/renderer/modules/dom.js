import { appState } from "./state.js";

const { escapeHtml, attrArg, matchesQuery } = window.projectUtils;

function renderTabBar(tabs, activeValue, onClickName, options = {}) {
  const {
    extraClass = "",
    label = (tab) => tab.replace(/_/g, " "),
    skip = () => false,
  } = options;
  return tabs
    .map((tab) => {
      if (skip(tab)) return "";
      const activeClass = tab === activeValue ? "workspace-tab workspace-tab-active" : "workspace-tab";
      return `<button onclick="window.${onClickName}('${tab}')" class="${activeClass}${extraClass}">${label(tab)}</button>`;
    })
    .join("");
}

function iconSvg(iconName) {
  const paths = {
    add_box: '<path d="M12 5v14M5 12h14" />',
    history: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/><path d="M12 8v5l3 2"/>',
    auto_stories: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H20v14H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M8 8h8M8 12h8"/>',
    style: '<path d="M7 7h10v10H7z"/><path d="M9.5 9.5h5v5h-5z"/>',
    add_circle: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>',
    description: '<path d="M8 4h6l4 4v12H8z"/><path d="M14 4v4h4"/><path d="M10 13h6M10 17h6"/>',
    info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8h.01"/>',
    delete_sweep: '<path d="M5 7h14M9 7V5h6v2M9 10v7M15 10v7M7 7l1 12h8l1-12"/>',
    delete: '<path d="M5 7h14M9 7V5h6v2M9 10v7M15 10v7M7 7l1 12h8l1-12"/>',
    folder_open: '<path d="M4 8h6l2 2h8v8H4z"/><path d="M4 8V6h6l2 2"/>',
    play_circle: '<circle cx="12" cy="12" r="8"/><path d="m11 9 5 3-5 3z"/>',
    check_circle: '<circle cx="12" cy="12" r="8"/><path d="m8.5 12.5 2.2 2.2 4.8-5.2"/>',
    sync_problem: '<path d="M5 12a7 7 0 0 1 12-4"/><path d="M17 8V4h-4"/><path d="M19 12a7 7 0 0 1-12 4"/><path d="M7 16v4h4"/>',
    search: '<circle cx="11" cy="11" r="5"/><path d="m16 16 4 4"/>',
    slideshow: '<rect x="4" y="6" width="16" height="10" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
    quiz: '<circle cx="12" cy="12" r="8"/><path d="M9.5 9.5a2.5 2.5 0 1 1 4.1 1.9c-.9.8-1.6 1.3-1.6 2.6"/><path d="M12 17h.01"/>',
    podcasts: '<path d="M8 10a4 4 0 0 1 8 0"/><path d="M6 11a6 6 0 0 1 12 0"/><path d="M9 15v2a3 3 0 0 0 6 0v-2"/><path d="M10 18h4"/>',
    settings: '<circle cx="12" cy="12" r="2.5"/><path d="M12 4v2.2M12 17.8V20M4 12h2.2M17.8 12H20M6.3 6.3l1.6 1.6M16.1 16.1l1.6 1.6M17.7 6.3l-1.6 1.6M7.9 16.1l-1.6 1.6"/>',
    rocket_launch: '<path d="M6 14c1.7-.2 3-.7 4.2-1.8l3.6-3.6c1.7-1.7 4.1-2.6 6.5-2.6-.1 2.4-.9 4.8-2.6 6.5l-3.6 3.6c-1.1 1.1-1.6 2.5-1.8 4.2-.9-.1-1.9-.6-2.6-1.3-.7-.7-1.2-1.7-1.3-2.6Z"/><path d="m8.5 15.5-2 2"/><path d="M6.5 17.5 4 20l.5-2.5L7 15"/>',
    manage_accounts: '<circle cx="9" cy="8" r="2.5"/><path d="M4.5 16c.8-2 2.4-3 4.5-3s3.7 1 4.5 3"/><circle cx="17" cy="9" r="1.8"/><path d="M14.8 16.2c.5-1.4 1.7-2.3 3.4-2.3 1.1 0 2 .3 2.8 1"/><path d="M17 4v2M17 12v2M14 9h6"/>',
    logout: '<path d="M10 5H6v14h4"/><path d="M14 8l4 4-4 4"/><path d="M18 12H9"/>',
    refresh: '<path d="M20 11a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
    checklist: '<path d="M9 7h8M9 12h8M9 17h8"/><path d="m4.5 7 1.2 1.2L7.8 6"/><path d="m4.5 12 1.2 1.2L7.8 11"/><path d="m4.5 17 1.2 1.2L7.8 16"/>',
    open_in_new: '<path d="M14 5h5v5"/><path d="M10 14 19 5"/><path d="M19 13v6H5V5h6"/>',
    cloud_upload: '<path d="M7 17a4 4 0 1 1 .6-7.9A5 5 0 0 1 17.6 10H18a3 3 0 0 1 0 6Z"/><path d="M12 11v7"/><path d="m9.5 13.5 2.5-2.5 2.5 2.5"/>',
    auto_awesome: '<path d="m12 4 1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/><path d="m18 12 .6 1.9L20.5 14l-1.9.6L18 16.5l-.6-1.9L15.5 14l1.9-.6z"/><path d="m6 13 .7 2.1L9 16l-2.3.9L6 19l-.7-2.1L3 16l2.3-.9z"/>',
    done_all: '<path d="m1.5 12.5 5 5L18 6"/><path d="m7 12.5 5 5L23.5 6"/>',
    save: '<path d="M5 4h11l4 4v12H5z"/><path d="M15 4v5H9V4"/><path d="M8 14h8v6H8z"/>',
    tune: '<path d="M3 8h4M11 8h10M3 16h10M17 16h4"/><circle cx="9" cy="8" r="2"/><circle cx="15" cy="16" r="2"/>',
    calculate: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h2M14 8h2M8 12h8M8 16h2M14 16h2"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    dark_mode: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    light_mode: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  };
  const path = paths[iconName];
  if (!path) return null;
  return `<svg viewBox="0 0 24 24" class="icon-svg" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function applyOfflineIcons(root = document) {
  root.querySelectorAll(".material-symbols-outlined").forEach((node) => {
    const iconName = (node.dataset.iconName || node.textContent || "").trim();
    const svg = iconSvg(iconName);
    if (!svg) return;
    node.dataset.iconName = iconName;
    node.innerHTML = svg;
    node.title = iconName.replace(/_/g, " ");
    node.setAttribute("aria-label", iconName.replace(/_/g, " "));
  });
}

const THEME_STORAGE_KEY = "nblm-desktop-theme-v1";

function getPreferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch (e) {
    /* localStorage unavailable */
  }
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function updateThemeToggleIcon(theme) {
  const btn = document.getElementById("theme-toggle-btn");
  if (!btn) return;
  const iconEl = btn.querySelector(".material-symbols-outlined");
  if (!iconEl) return;
  // Show the icon of the mode you'd switch INTO: moon while light, sun while dark.
  const iconName = theme === "dark" ? "light_mode" : "dark_mode";
  iconEl.dataset.iconName = iconName;
  iconEl.textContent = iconName;
  applyOfflineIcons(btn);
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
}

function applyTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  const root = document.documentElement;
  root.setAttribute("data-theme", normalized);
  root.classList.remove("light", "dark");
  root.classList.add(normalized);
  updateThemeToggleIcon(normalized);
}

function initTheme() {
  applyTheme(getPreferredTheme());
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch (e) {
    /* localStorage unavailable */
  }
  applyTheme(next);
}

function showToast(message) {
  const toast = document.getElementById("app-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.classList.add("is-visible");
  if (appState.toastTimer) {
    clearTimeout(appState.toastTimer);
  }
  appState.toastTimer = setTimeout(() => {
    toast.classList.remove("is-visible");
    toast.classList.add("hidden");
  }, 2200);
}

function progressLog(message) {
  const logEl = document.getElementById("loading-log");
  if (!logEl) return;
  logEl.textContent = String(message || "")
    .replace(/^\d{2}:\d{2}:\d{2}\s+\[nblm\]\s+/, "")
    .split("\n")
    .pop();
}

function showLoading(message) {
  appState.isRunning = true;
  const overlay = document.getElementById("loading-overlay");
  if (overlay) overlay.style.display = "flex";
  const messageEl = document.getElementById("loading-msg");
  if (messageEl) messageEl.textContent = message || "Processing...";
  progressLog("");
  updateLoginPromptUI();
}

function hideLoading() {
  appState.isRunning = false;
  const overlay = document.getElementById("loading-overlay");
  if (overlay) overlay.style.display = "none";
  updateLoginPromptUI();
}

function updateLoginPromptUI() {
  const confirmButton = document.getElementById("confirm-login-btn");
  const loginButton = document.getElementById("login-btn");
  const hint = document.getElementById("auth-enter-hint");
  const loadingEnterButton = document.getElementById("loading-enter-btn");
  const shouldShowEnter = appState.loginProcessActive && appState.loginAwaitingEnter;
  if (confirmButton) confirmButton.classList.toggle("hidden", !shouldShowEnter);
  if (loginButton) loginButton.disabled = appState.loginProcessActive;
  if (hint) hint.classList.toggle("hidden", !shouldShowEnter);
  if (loadingEnterButton) loadingEnterButton.classList.toggle("hidden", !shouldShowEnter);
}

export {
  escapeHtml,
  attrArg,
  matchesQuery,
  renderTabBar,
  iconSvg,
  applyOfflineIcons,
  showToast,
  progressLog,
  showLoading,
  hideLoading,
  updateLoginPromptUI,
  applyTheme,
  toggleTheme,
  initTheme,
  getPreferredTheme,
};

// Sync the toggle icon/label with the theme the inline <head> script already
// applied, and wire the onclick="window.toggleTheme()" handler used in index.html.
// This module is a deferred ES module, so the DOM is parsed by the time it runs.
window.toggleTheme = toggleTheme;
initTheme();
