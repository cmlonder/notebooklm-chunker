import {
  appState,
  desktopAppReady,
  setupNeedsFullscreen,
  hasPreparedChunks,
  hasSyncedLineage,
} from "./state.js";
import { hideLoading } from "./dom.js";
import { renderSetupView } from "./setup.js";
import { fetchLocalProjects } from "./history.js";
import { prepareNotebooksView } from "./dashboard.js";
import { renderPromptsView } from "./prompts.js";
import {
  prepareSourcesView,
  populateChunkList,
  prepareSourceView,
  prepareStructureView,
} from "./chunks.js";
import { prepareSyncView } from "./sync.js";
import { renderNblmSettingsTabs, renderNblmSettingsBody } from "./settings.js";

function closeUserMenu() {
  appState.userMenuOpen = false;
  const menu = document.getElementById("user-menu-panel");
  if (menu) menu.classList.add("hidden");
}

function toggleUserMenu() {
  appState.userMenuOpen = !appState.userMenuOpen;
  const menu = document.getElementById("user-menu-panel");
  if (!menu) return;
  menu.classList.toggle("hidden", !appState.userMenuOpen);
}

function navigationGuard(targetView) {
  if (targetView === "setup" || targetView === "auth" || targetView === "history" || targetView === "notebooks" || targetView === "prompts" || targetView === "source" || targetView === "nblm-settings") {
    if (targetView === "notebooks" && !appState.isAuthenticated) {
      return { allowed: false, message: "Sign in to inspect live NotebookLM notebooks and Studios." };
    }
    return { allowed: true };
  }
  if (!appState.selectedPDF) {
    return { allowed: false, message: "First choose a document in the Document step." };
  }
  if (targetView === "structure") {
    return { allowed: true };
  }
  if ((targetView === "sources" || targetView === "sync") && !hasPreparedChunks()) {
    return { allowed: false, message: "Process the document in Structure before opening this step." };
  }
  if (targetView === "sync" && !appState.isAuthenticated) {
    return { allowed: false, message: "Sign in before syncing chunks to NotebookLM." };
  }
  if (targetView === "studio" && !hasSyncedLineage()) {
    return { allowed: false, message: "Sync at least one chunk to NotebookLM before opening Studio." };
  }
  return { allowed: true };
}

function updateNavigationLocks() {
  document.querySelectorAll("[data-nav]").forEach((item) => {
    const { allowed } = navigationGuard(item.dataset.nav);
    item.dataset.locked = allowed ? "false" : "true";
    item.classList.toggle("opacity-40", !allowed);
    item.classList.toggle("cursor-not-allowed", !allowed);
  });
}

function applyNavigationState(targetView) {
  const sidebar = document.getElementById("main-sidebar");
  const header = document.getElementById("wizard-header");
  appState.currentView = targetView;
  const fullscreenSetup = setupNeedsFullscreen();
  if (sidebar) sidebar.style.display = desktopAppReady() && !fullscreenSetup ? "flex" : "none";
  if (header) {
    header.style.display = ["source", "structure", "sources", "sync"].includes(targetView)
      ? "flex"
      : "none";
  }
  if (header && fullscreenSetup) {
    header.style.display = "none";
  }

  document.querySelectorAll(".view").forEach((view) => {
    view.classList.remove("active");
    view.style.display = "none";
  });

  const viewEl = document.getElementById(`${targetView}-view`);
  if (viewEl) {
    viewEl.classList.add("active");
    viewEl.style.display = ["auth", "source", "structure", "sources", "sync"].includes(targetView)
      ? "flex"
      : "block";
  }

  document.querySelectorAll("[data-sidebar]").forEach((item) => {
    item.className = item.dataset.sidebar === targetView
      ? "flex items-center gap-3 px-3 py-2.5 rounded-xl bg-primary/10 text-primary font-bold transition-all cursor-pointer"
      : "flex items-center gap-3 px-3 py-2.5 rounded-xl text-slate-500 hover:bg-slate-100 transition-all cursor-pointer";
  });

  document.querySelectorAll("[data-nav]").forEach((item) => {
    if (item.dataset.nav === targetView) {
      item.className = "px-4 py-1.5 rounded-lg bg-white shadow-sm text-xs font-bold text-primary transition-all cursor-pointer";
    } else {
      item.className = "px-4 py-1.5 rounded-lg text-xs font-bold text-slate-500 hover:text-slate-900 transition-colors cursor-pointer";
    }
  });

  closeUserMenu();
  updateNavigationLocks();
}

function switchView(viewName) {
  if (!desktopAppReady() && viewName !== "auth" && viewName !== "setup") {
    return;
  }
  if (!appState.isAuthenticated && viewName !== "auth" && viewName !== "setup") {
    if (viewName === "setup") {
      applyNavigationState("setup");
      renderSetupView();
      return;
    }
  }
  const guard = navigationGuard(viewName);
  if (!guard.allowed) {
    alert(guard.message);
    return;
  }
  applyNavigationState(viewName);
  if (viewName === "history" || viewName === "auth") {
    hideLoading();
  }
  if (viewName === "setup") {
    renderSetupView();
  }
  if (viewName === "history") {
    void fetchLocalProjects();
  }
  if (viewName === "notebooks") {
    void prepareNotebooksView();
  }
  if (viewName === "prompts") {
    renderPromptsView();
  }
  if (viewName === "sources") {
    prepareSourcesView();
    populateChunkList();
  }
  if (viewName === "source") {
    prepareSourceView();
  }
  if (viewName === "structure") {
    prepareStructureView();
  }
  if (viewName === "sync") {
    prepareSyncView();
  }
  if (viewName === "nblm-settings") {
    renderNblmSettingsTabs();
    renderNblmSettingsBody();
  }
}

export {
  closeUserMenu,
  toggleUserMenu,
  navigationGuard,
  updateNavigationLocks,
  applyNavigationState,
  switchView,
};
