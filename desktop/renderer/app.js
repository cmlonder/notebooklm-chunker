import {
  appState,
  loadPromptLibrary,
  loadStudioSettings,
  loadActiveProfile,
} from "./modules/state.js";
import {
  applyOfflineIcons,
  hideLoading,
  progressLog,
  updateLoginPromptUI,
} from "./modules/dom.js";
import {
  switchView,
  toggleUserMenu,
  closeUserMenu,
  updateNavigationLocks,
} from "./modules/navigation.js";
import {
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
  applyActiveProfile,
} from "./modules/setup.js";
import {
  renderPromptsView,
  refreshPromptDropdowns,
  savePromptPreset,
  deletePromptPreset,
  applyPromptPreset,
  selectPromptStudioTab,
  startPromptDraft,
  selectPromptItem,
  togglePromptSelection,
  deleteSelectedPrompts,
  openPromptEditor,
  closePromptEditor,
} from "./modules/prompts.js";
import {
  openStudioSettings,
  closeStudioSettings,
  saveStudioSettings,
  openNotebookLMSettings,
  saveNotebookLMSettings,
  switchNblmSettingsTab,
  switchNblmSourceTab,
} from "./modules/settings.js";
import {
  renderHistoryList,
  resumeExistingPath,
  deleteProject,
} from "./modules/history.js";
import {
  renderRemoteNotebookList,
  renderDashboardSources,
  switchNotebookWorkspaceTab,
  openNotebookDashboard,
  openDashboardPreview,
  closeDashboardPreview,
  refreshNotebookDashboard,
  selectDashboardNotebook,
  exitNotebookWorkspace,
  selectDashboardLineage,
  selectDashboardSource,
  toggleDashboardSourceSelection,
  toggleAllDashboardSources,
} from "./modules/dashboard.js";
import {
  handleNotebookSelectChange,
  processSyncOutput,
  runSync,
} from "./modules/sync.js";
import {
  prepareStudioView,
  applyStudioQueueUpdate,
  addStudioQueueItem,
  addStudioQueueItemsForSelection,
  removeStudioQueueItem,
  retryStudioJob,
  retryAllFailedStudioJobs,
  removeBackgroundStudioJob,
  clearSubmittedStudioJobs,
  selectStudioQueueTab,
  runStudios,
} from "./modules/studio.js";
import {
  deleteSelectedStudioArtifacts,
  toggleStudioArtifactSelection,
  selectStudioArtifactsTab,
} from "./modules/artifacts.js";
import {
  startNewProject,
  triggerFileSelect,
  startNewVersion,
  forceRefine,
  selectChunk,
  toggleChunk,
  toggleAllChunks,
  deleteChunk,
  deleteSelected,
  handleTitleEdit,
  handleEdit,
  handleStructureSettingChange,
  replaceSelectedPDF,
  populateChunkList,
} from "./modules/chunks.js";

async function init() {
  appState.loginProcessActive = false;
  appState.loginAwaitingEnter = false;
  loadPromptLibrary();
  loadStudioSettings();
  applyOfflineIcons();
  hideLoading();
  appState.paths = await window.electronAPI.getAppPaths();
  // Restore the last-used account before any engine call so every command
  // targets the right profile from the very first request.
  const savedProfile = loadActiveProfile();
  if (savedProfile) {
    await applyActiveProfile(savedProfile);
  }
  await refreshSetupStatus({ showSpinner: true });
  if (appState.setupStatus?.readyForLiveRun) {
    switchView("history");
  } else if (appState.setupStatus?.readyForApp) {
    switchView("setup");
  } else {
    switchView("setup");
  }
  window.electronAPI.onNBLMOutput((payload) => {
    if (!appState.isRunning) return;
    const text = payload.data || "";
    progressLog(text);
    if (appState.currentOperation === "sync") {
      processSyncOutput(text);
    }
    if (text.includes("Press ENTER") || text.includes("[Press ENTER when logged in]")) {
      appState.loginAwaitingEnter = true;
      updateLoginPromptUI();
      const messageEl = document.getElementById("loading-msg");
      if (messageEl) {
        messageEl.textContent = "Browser login is ready. Press Enter here to finish.";
      }
    }
  });
  window.electronAPI.onStudioQueueUpdate((payload) => {
    applyStudioQueueUpdate(payload);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const studioSettingsModal = document.getElementById("studio-settings-modal");
      if (studioSettingsModal && !studioSettingsModal.classList.contains("hidden")) {
        event.preventDefault();
        closeStudioSettings();
        return;
      }
      const promptModal = document.getElementById("prompt-modal");
      if (promptModal && !promptModal.classList.contains("hidden")) {
        event.preventDefault();
        closePromptEditor();
        return;
      }
      const previewModal = document.getElementById("preview-modal");
      if (previewModal && !previewModal.classList.contains("hidden")) {
        event.preventDefault();
        closeDashboardPreview();
        return;
      }
    }
    if (event.key !== "Enter") return;
    if (!appState.loginProcessActive || !appState.loginAwaitingEnter) return;
    event.preventDefault();
    event.stopPropagation();
    void sendEnterToProcess();
  }, true);
  document.addEventListener("click", (event) => {
    const menu = document.getElementById("user-menu-shell");
    if (!menu) return;
    if (!menu.contains(event.target)) {
      closeUserMenu();
    }
  });
  updateLoginPromptUI();
  hideLoading();
  updateNavigationLocks();
  refreshPromptDropdowns();
}

const makeSearchHandler = (field, render) => (value) => {
  appState[field] = String(value || "");
  render();
};

const handlePromptSearch = makeSearchHandler("promptSearchQuery", renderPromptsView);
const handleNotebookSourceSearch = makeSearchHandler("dashboardSourceSearchQuery", renderDashboardSources);
const handleNotebookSearch = makeSearchHandler("dashboardNotebookSearchQuery", renderRemoteNotebookList);
const handleStudioQueueSearch = makeSearchHandler("studioQueueSearchQuery", prepareStudioView);
const handleStudioArtifactsSearch = makeSearchHandler("studioArtifactsSearchQuery", prepareStudioView);
const handleChunkSearch = makeSearchHandler("chunkSearchQuery", populateChunkList);
const handleHistorySearch = makeSearchHandler("historySearchQuery", renderHistoryList);
const handleHistoryStatusFilter = makeSearchHandler("historyStatusFilter", renderHistoryList);

Object.assign(window, {
  login,
  confirmLogin,
  recheckDesktopSetup,
  switchProfile,
  addAccount,
  toggleUserMenu,
  closeUserMenu,
  openSetupView,
  switchView,
  startNewProject,
  triggerFileSelect,
  startNewVersion,
  forceRefine,
  selectChunk,
  toggleChunk,
  toggleAllChunks,
  deleteChunk,
  deleteSelected,
  handleNotebookSelectChange,
  handleTitleEdit,
  handleEdit,
  handleStructureSettingChange,
  handleChunkSearch,
  handleNotebookSearch,
  handleNotebookSourceSearch,
  toggleDashboardSourceSelection,
  toggleAllDashboardSources,
  runSync,
  runStudios,
  switchNotebookWorkspaceTab,
  openNotebookDashboard,
  logout,
  switchAccount,
  openDashboardPreview,
  closeDashboardPreview,
  addStudioQueueItem,
  addStudioQueueItemsForSelection,
  removeStudioQueueItem,
  savePromptPreset,
  deletePromptPreset,
  applyPromptPreset,
  selectPromptStudioTab,
  handlePromptSearch,
  startPromptDraft,
  selectPromptItem,
  togglePromptSelection,
  deleteSelectedPrompts,
  openPromptEditor,
  closePromptEditor,
  deleteSelectedStudioArtifacts,
  toggleStudioArtifactSelection,
  selectStudioArtifactsTab,
  handleStudioArtifactsSearch,
  openStudioSettings,
  closeStudioSettings,
  saveStudioSettings,
  sendEnterToProcess,
  resumeExistingPath,
  replaceSelectedPDF,
  refreshNotebookDashboard,
  selectDashboardNotebook,
  exitNotebookWorkspace,
  selectDashboardLineage,
  selectDashboardSource,
  deleteProject,
  retryStudioJob,
  retryAllFailedStudioJobs,
  removeBackgroundStudioJob,
  clearSubmittedStudioJobs,
  selectStudioQueueTab,
  handleStudioQueueSearch,
  handleHistorySearch,
  handleHistoryStatusFilter,
  openNotebookLMSettings,
  saveNotebookLMSettings,
  switchNblmSettingsTab,
  switchNblmSourceTab,
});

init();
