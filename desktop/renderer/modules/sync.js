import {
  appState,
  isReadOnlyProject,
  selectedNotebookReady,
  summarizeStudioOutputs,
  notebookUrl,
  getMaxParallelChunks,
  loadRunState,
  saveProjectMetadata,
  saveManifest,
} from "./state.js";
import { escapeHtml, attrArg, applyOfflineIcons, showToast } from "./dom.js";
import { switchView, updateNavigationLocks } from "./navigation.js";
import { fetchLocalProjects } from "./history.js";
import { prepareStudioView } from "./studio.js";

function renderNotebookOptions(notebooks) {
  const select = document.getElementById("notebook-select");
  if (!select) return;
  let options = '<option value="" disabled selected>Select a notebook...</option><option value="new">+ Create New Notebook</option>';
  notebooks.forEach((notebook) => {
    options += `<option value="${escapeHtml(notebook.id)}" ${notebook.id === appState.activeNotebookId ? "selected" : ""}>${escapeHtml(notebook.title || notebook.id)}</option>`;
  });
  select.innerHTML = options;
  if (!appState.activeNotebookId && select.value !== "new") {
    select.value = "";
  }
}

async function loadExistingNotebooks({ force = false } = {}) {
  const select = document.getElementById("notebook-select");
  if (!select) return;
  if (!force && Array.isArray(appState.notebooksCache)) {
    renderNotebookOptions(appState.notebooksCache);
    return;
  }
  if (appState.notebooksLoading) {
    return;
  }
  appState.notebooksLoading = true;
  select.innerHTML = '<option value="" disabled selected>Loading notebooks...</option>';
  try {
    const result = await window.electronAPI.runNBLM({ command: "list-notebooks", args: [] });
    if (!result.success) {
      select.innerHTML = '<option value="" disabled selected>Failed to load notebooks</option><option value="new">+ Create New Notebook</option>';
      return;
    }
    appState.notebooksCache = JSON.parse(result.output);
    renderNotebookOptions(appState.notebooksCache);
  } finally {
    appState.notebooksLoading = false;
  }
}

function handleNotebookSelectChange(value, options = {}) {
  const { rerender = true } = options;
  const group = document.getElementById("new-notebook-input-group");
  if (group) group.style.display = value === "new" ? "block" : "none";
  if (value && value !== "new") {
    appState.activeNotebookId = value;
    appState.activeNotebookTitle = document.getElementById("notebook-select").selectedOptions[0]?.textContent || null;
  } else {
    appState.activeNotebookId = null;
    appState.activeNotebookTitle = null;
  }
  if (rerender) {
    prepareSyncView();
  }
}

function prepareSyncView() {
  const list = document.getElementById("sync-chunk-list");
  if (!list) return;
  const readOnly = isReadOnlyProject();
  const pending = appState.chunks.filter((chunk) => chunk.synced !== true);
  const progressMap = new Map(appState.syncProgressEntries.map((entry) => [entry.filename, entry]));
  const countEl = document.getElementById("sync-count-total");
  const listTitle = document.getElementById("sync-list-title");
  if (countEl) countEl.textContent = String(readOnly ? appState.chunks.length : pending.length);
  if (listTitle) {
    listTitle.textContent = readOnly
      ? `Synced Sources (${appState.chunks.length})`
      : `Pending Changes (${pending.length})`;
  }
  list.innerHTML = (readOnly ? appState.chunks : (pending.length ? pending : appState.chunks)).map((chunk) => {
    const progress = progressMap.get(chunk.filename);
    const tone = progress?.status === "completed"
      ? "queue-progress-bar is-complete"
      : progress?.status === "failed"
      ? "queue-progress-bar is-failed"
      : progress?.status === "running"
      ? "queue-progress-bar is-running"
      : "queue-progress-bar";
    const width = progress?.status === "completed"
      ? 100
      : progress?.status === "failed"
      ? 100
      : progress?.status === "running"
      ? 72
      : 0;
    const statusLabel = progress?.status
      ? progress.status
      : chunk.synced
      ? "synced"
      : "changed";
    return `
      <div class="sync-row hover:bg-slate-50/50 text-left">
        <div class="sync-row-main">
          <span class="material-symbols-outlined ${chunk.synced || progress?.status === "completed" ? "text-green-500" : progress?.status === "failed" ? "text-red-500" : "text-blue-500"}">${chunk.synced || progress?.status === "completed" ? "check_circle" : "sync_problem"}</span>
          <div class="sync-row-copy">
            <p class="text-sm font-medium text-slate-900 truncate">${escapeHtml(chunk.title)}</p>
            <p class="text-xs text-slate-400 truncate mt-1">${escapeHtml(chunk.filename)}</p>
            ${progress ? `<div class="queue-progress"><div class="${tone}" style="width: ${width}%"></div></div><p class="text-[11px] text-slate-400 mt-2">${escapeHtml(progress.message)}</p>` : ""}
          </div>
        </div>
        <div class="sync-row-meta">
          <span class="text-[10px] font-bold uppercase ${statusLabel === "completed" || statusLabel === "synced" ? "text-green-600" : statusLabel === "failed" ? "text-red-500" : "text-blue-600"}">${statusLabel}</span>
        </div>
      </div>
    `;
  }).join("");
  applyOfflineIcons(list);

  const startButton = document.getElementById("start-sync-btn");
  if (startButton) {
    startButton.disabled = readOnly || pending.length === 0 || !selectedNotebookReady() || appState.syncInProgress;
    startButton.style.display = readOnly ? "none" : "block";
    startButton.innerHTML = appState.syncInProgress
      ? '<span class="material-symbols-outlined">refresh</span><span>Syncing...</span>'
      : '<span class="material-symbols-outlined">cloud_upload</span><span>Upload Changes</span>';
    applyOfflineIcons(startButton);
  }

  const notebookPanel = document.getElementById("notebook-settings-panel");
  if (notebookPanel) notebookPanel.style.display = readOnly ? "none" : "block";

  const syncBanner = document.getElementById("sync-readonly-banner");
  if (syncBanner) syncBanner.style.display = readOnly ? "block" : "none";
  if (syncBanner) {
    syncBanner.style.marginBottom = readOnly ? "0.75rem" : "0";
    if (readOnly) {
      const studioCount = summarizeStudioOutputs(appState.projectRunState || {}).length;
      syncBanner.innerHTML = `
        <div class="flex items-start justify-between gap-4">
          <div>
            <h3 class="font-bold text-green-700">Already synced</h3>
            <p class="text-sm text-green-700 mt-2">This lineage is read-only. Review the synced status below.</p>
          </div>
          <div class="sync-readonly-stats">
            <span class="sync-readonly-stat" title="Sources">
              <span class="material-symbols-outlined !text-sm">description</span>
              <span>${appState.chunks.length}</span>
            </span>
            <span class="sync-readonly-stat" title="Studios">
              <span class="material-symbols-outlined !text-sm">auto_stories</span>
              <span>${studioCount}</span>
            </span>
          </div>
        </div>
      `;
      applyOfflineIcons(syncBanner);
    }
  }

  const info = document.getElementById("active-notebook-info");
  if (info) info.style.display = "none";
  const activeName = document.getElementById("active-notebook-name");
  if (activeName) {
    activeName.innerHTML = appState.activeNotebookId
      ? `<a href="#" onclick="window.electronAPI.openExternal(${attrArg(`https://notebooklm.google.com/notebook/${appState.activeNotebookId}`)}); return false;" class="underline font-bold">${escapeHtml(appState.activeNotebookTitle || appState.activeNotebookId)}</a>`
      : "...";
  }

  const syncLinkButton = document.getElementById("sync-notebook-link-btn");
  if (syncLinkButton) {
    const url = notebookUrl();
    syncLinkButton.style.display = url ? "inline-flex" : "none";
    if (url) {
      syncLinkButton.onclick = (event) => {
        event.preventDefault();
        window.electronAPI.openExternal(url);
      };
    } else {
      syncLinkButton.onclick = null;
    }
  }

  if (!readOnly && !appState.notebooksCache && !appState.notebooksLoading) {
    void loadExistingNotebooks();
  }
}

function initializeSyncProgress() {
  const pending = appState.chunks.filter((chunk) => chunk.synced !== true);
  appState.syncProgressEntries = pending.map((chunk) => ({
    filename: chunk.filename,
    title: chunk.title,
    status: "queued",
    message: "Waiting to upload",
  }));
}

function markSyncEntry(filename, updates) {
  appState.syncProgressEntries = appState.syncProgressEntries.map((entry) =>
    entry.filename === filename ? { ...entry, ...updates } : entry,
  );
  prepareSyncView();
}

function processSyncOutput(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const startMatch = line.match(/upload:\s+(?:resume\s+)?\d+\/\d+\s+(.+?)(?:\s+->.*)?$/i);
    const startingFile = startMatch?.[1] || null;
    if (startingFile) {
      markSyncEntry(startingFile, {
        status: "running",
        message: "Uploading to NotebookLM",
      });
    }
    const resumeMatch = line.match(/upload:\s+resume\s+\d+\/\d+\s+(.+?)\s+->/i);
    const uploadMatch = line.match(/upload:\s+\d+\/\d+\s+(.+?)(?:\s+->.*)?$/i);
    const fileName = resumeMatch?.[1] || uploadMatch?.[1] || null;
    if (fileName) {
      markSyncEntry(fileName, {
        status: "completed",
        message: resumeMatch ? "Already synced" : "Uploaded to NotebookLM",
      });
    }
  }
}

async function runSync() {
  if (!appState.outputDir) return;
  appState.isRunning = true;
  appState.currentOperation = "sync";
  appState.syncInProgress = true;
  initializeSyncProgress();
  prepareSyncView();
  try {
    const args = [
      appState.outputDir,
      "--max-parallel-chunks",
      String(getMaxParallelChunks()),
      "--only-changed",
      "--rename-remote-titles",
    ];
    if (appState.activeNotebookId) {
      args.push("--notebook-id", appState.activeNotebookId);
    } else {
      const notebookTitle = document.getElementById("new-notebook-title")?.value.trim();
      if (!notebookTitle) {
        throw new Error("Pick an existing notebook or enter a new notebook title.");
      }
      appState.activeNotebookTitle = notebookTitle;
      args.push("--notebook-title", notebookTitle);
    }

    const result = await window.electronAPI.runNBLM({ command: "upload", args });
    if (!result.success) {
      throw new Error(result.error || result.output || "Upload failed.");
    }
    await loadRunState();
    const notebookId = window.projectUtils.parseNotebookId(result.output);
    if (notebookId) {
      appState.activeNotebookId = notebookId;
      if (!appState.activeNotebookTitle) {
        appState.activeNotebookTitle = notebookId;
      }
      await saveProjectMetadata();
    }
    appState.chunks.forEach((chunk) => {
      chunk.synced = true;
    });
    await saveManifest();
    await fetchLocalProjects();
    appState.syncProgressEntries = appState.syncProgressEntries.map((entry) => ({
      ...entry,
      status: entry.status === "failed" ? "failed" : "completed",
      message: entry.status === "failed" ? entry.message : "Uploaded to NotebookLM",
    }));
    prepareSyncView();
    prepareStudioView();
    updateNavigationLocks();
    const syncedProject = appState.localProjects.find((project) => project.path === appState.outputDir);
    if (appState.activeNotebookId) {
      appState.dashboardNotebookId = appState.activeNotebookId;
      appState.dashboardNotebookTitle = appState.activeNotebookTitle || appState.activeNotebookId;
      appState.dashboardProjectPath = syncedProject?.path || appState.outputDir;
      appState.dashboardSelectedSourceKey = null;
      appState.dashboardSelectedSourceKeys = new Set();
      appState.notebookWorkspaceActive = true;
      appState.notebookWorkspaceTab = "sources";
      appState.studioQueue = [];
      appState.notebookWorkspaceNotice = "Sync finished. You can now open the sources below and queue Studio generation for them in batches from this workspace.";
      switchView("notebooks");
      showToast("Sync complete. NotebookLM workspace is ready.");
    } else {
      showToast("Sync complete.");
    }
  } catch (error) {
    appState.syncProgressEntries = appState.syncProgressEntries.map((entry) => (
      entry.status === "completed" ? entry : { ...entry, status: "failed", message: error.message }
    ));
    prepareSyncView();
    alert(error.message);
  } finally {
    appState.isRunning = false;
    appState.currentOperation = null;
    appState.syncInProgress = false;
    prepareSyncView();
  }
}

export {
  renderNotebookOptions,
  loadExistingNotebooks,
  handleNotebookSelectChange,
  prepareSyncView,
  initializeSyncProgress,
  markSyncEntry,
  processSyncOutput,
  runSync,
};
