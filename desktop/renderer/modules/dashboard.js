import { appState, summarizeStudioOutputs } from "./state.js";
import { escapeHtml, attrArg, applyOfflineIcons } from "./dom.js";
import { switchView } from "./navigation.js";
import { fetchLocalProjects } from "./history.js";
import { loadExistingNotebooks } from "./sync.js";
import { refreshPromptDropdowns } from "./prompts.js";
import { updateStudioSettingsSummaries } from "./settings.js";
import { prepareStudioView } from "./studio.js";
import { loadStudioArtifacts } from "./artifacts.js";

function setNotebookWorkspaceNotice(message = "") {
  appState.notebookWorkspaceNotice = String(message || "");
  const notice = document.getElementById("dashboard-workspace-notice");
  if (!notice) return;
  if (!appState.notebookWorkspaceNotice) {
    notice.classList.add("hidden");
    notice.textContent = "";
    return;
  }
  notice.classList.remove("hidden");
  notice.textContent = appState.notebookWorkspaceNotice;
}

function setNotebookDashboardLoading(isLoading) {
  const loading = document.getElementById("notebook-dashboard-loading");
  const list = document.getElementById("remote-notebook-list");
  const refreshButton = document.querySelector('#notebooks-view button[onclick="window.refreshNotebookDashboard()"]');
  if (loading) loading.classList.toggle("hidden", !isLoading);
  if (list) list.classList.toggle("hidden", isLoading);
  if (refreshButton) refreshButton.disabled = isLoading;
}

function openNotebookDashboard() {
  appState.notebookWorkspaceActive = false;
  appState.dashboardNotebookId = null;
  appState.dashboardNotebookTitle = null;
  appState.dashboardProjectPath = null;
  appState.dashboardSelectedSourceKey = null;
  appState.dashboardSelectedSourceKeys = new Set();
  appState.studioQueue = [];
  appState.notebookWorkspaceTab = "sources";
  switchView("notebooks");
}

function linkedProjectsForNotebook(notebookId) {
  return appState.localProjects
    .filter((project) => project.metadata?.notebook_id === notebookId)
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

function notebookSummary(notebookId) {
  const projects = linkedProjectsForNotebook(notebookId);
  const syncedSources = projects.reduce((sum, project) => (
    sum + (Array.isArray(project.manifestEntries)
      ? project.manifestEntries.filter((entry) => entry && entry.synced === true).length
      : 0)
  ), 0);
  const generatedOutputs = projects.reduce((sum, project) => (
    sum + summarizeStudioOutputs(project.runState || {}).length
  ), 0);
  const pendingStudioJobs = projects.reduce((sum, project) => (
    sum + ((project.queueState?.jobs || []).filter((job) => job.status === "queued" || job.status === "running").length)
  ), 0);
  return {
    lineages: projects.length,
    syncedSources,
    generatedOutputs,
    pendingStudioJobs,
  };
}

function currentDashboardProject() {
  return appState.localProjects.find((project) => project.path === appState.dashboardProjectPath) || null;
}

function currentDashboardSources() {
  const project = currentDashboardProject();
  if (!project || !Array.isArray(project.manifestEntries)) {
    return [];
  }
  const query = appState.dashboardSourceSearchQuery.trim().toLowerCase();
  const runStateChunks = project.runState?.chunks || {};
  const sources = project.manifestEntries
    .filter((entry) => entry && entry.file && entry.synced === true)
    .map((entry) => {
      const runStateChunk = runStateChunks?.[entry.file] || {};
      const nestedSourceId = runStateChunk?.source?.source_id || null;
      const legacySourceId = runStateChunk?.source_id || null;
      return {
        key: `${project.path}:${entry.file}`,
        title: entry.primary_heading || entry.file,
        filename: entry.file,
        path: `${project.path}/${entry.file}`,
        projectPath: project.path,
        projectName: project.rawName,
        sourceId: entry.source_id || nestedSourceId || legacySourceId || null,
      };
    });
  if (!query) {
    return sources;
  }
  return sources.filter((item) =>
    item.title.toLowerCase().includes(query) || item.filename.toLowerCase().includes(query),
  );
}

function currentSelectedDashboardSources() {
  const sources = currentDashboardSources();
  const selected = sources.filter((item) => appState.dashboardSelectedSourceKeys.has(item.key));
  if (selected.length > 0) {
    return selected;
  }
  const focused = sources.find((item) => item.key === appState.dashboardSelectedSourceKey);
  return focused ? [focused] : [];
}

function updateDashboardSelectedCount() {
  const counter = document.getElementById("dashboard-selected-count");
  if (!counter) return;
  const count = currentSelectedDashboardSources().length;
  counter.textContent = `${count} selected`;
}

function renderRemoteNotebookList() {
  const list = document.getElementById("remote-notebook-list");
  if (!list) return;
  if (appState.notebooksLoading && !Array.isArray(appState.notebooksCache)) {
    list.innerHTML = '<div class="px-6 py-6 text-sm text-slate-400 italic">Loading notebooks...</div>';
    return;
  }
  const query = appState.dashboardNotebookSearchQuery.trim().toLowerCase();
  const notebooks = (Array.isArray(appState.notebooksCache) ? appState.notebooksCache : []).filter((notebook) => {
    if (!query) return true;
    return String(notebook.title || "").toLowerCase().includes(query) || String(notebook.id || "").toLowerCase().includes(query);
  });
  if (notebooks.length === 0) {
    list.innerHTML = '<div class="px-6 py-6 text-sm text-slate-400 italic">No notebooks found.</div>';
    return;
  }
  list.innerHTML = notebooks.map((notebook) => {
    const summary = notebookSummary(notebook.id);
    return `
      <button onclick="window.selectDashboardNotebook(${attrArg(notebook.id)}, ${attrArg(notebook.title || notebook.id)})" class="notebook-overview-card">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="font-bold text-slate-900 truncate">${escapeHtml(notebook.title || notebook.id)}</p>
          </div>
        </div>
        <div class="notebook-overview-stats">
          <div class="notebook-overview-stat-pill" title="Synced sources">
            <span class="material-symbols-outlined notebook-overview-stat-icon">description</span>
            <span class="notebook-overview-stat-value">${summary.syncedSources}</span>
          </div>
          <div class="notebook-overview-stat-pill" title="Studios">
            <span class="material-symbols-outlined notebook-overview-stat-icon">auto_stories</span>
            <span class="notebook-overview-stat-value">${summary.generatedOutputs}</span>
          </div>
        </div>
        ${summary.pendingStudioJobs > 0 ? `<p class="text-xs font-bold text-amber-700">${summary.pendingStudioJobs} Studio job(s) still in progress</p>` : ""}
      </button>
    `;
  }).join("");
  applyOfflineIcons(list);
}

function renderDashboardLineages() {
  const container = document.getElementById("dashboard-lineage-list");
  if (!container) return;
  const projects = linkedProjectsForNotebook(appState.dashboardNotebookId);
  if (projects.length === 0) {
    container.innerHTML = '<span class="text-sm text-slate-400 italic">No local synced runs found for this notebook yet.</span>';
    return;
  }
  container.innerHTML = projects.map((project) => `
    <button onclick="window.selectDashboardLineage(${attrArg(project.path)})" class="px-3 py-2 rounded-xl border text-sm font-bold ${project.path === appState.dashboardProjectPath ? "border-primary/20 bg-primary/5 text-primary" : ((project.queueState?.jobs || []).some((job) => job.status === "queued" || job.status === "running") ? "border-amber-200 bg-amber-50 text-amber-700" : "border-slate-200 text-slate-600 hover:bg-slate-50")}">
      ${escapeHtml(project.rawName)}
    </button>
  `).join("");
}

function renderDashboardSources() {
  const list = document.getElementById("dashboard-source-list");
  const summary = document.getElementById("dashboard-source-summary");
  const selectAllButton = document.querySelector('#dashboard-sources-panel .secondary-action-btn');
  if (!list) return;
  const sources = currentDashboardSources();
  if (summary) {
    summary.textContent = appState.dashboardProjectPath
      ? `${sources.length} synced source${sources.length === 1 ? "" : "s"} in this notebook workspace.`
      : "Choose a notebook with synced sources to inspect them here.";
  }
  if (!appState.dashboardProjectPath) {
    list.innerHTML = '<div class="px-5 py-6 text-sm text-slate-400 italic">No synced sources available for this notebook yet.</div>';
    return;
  }
  if (sources.length === 0) {
    list.innerHTML = '<div class="px-5 py-6 text-sm text-slate-400 italic">No synced sources available in this local run.</div>';
    return;
  }
  if (!sources.some((source) => source.key === appState.dashboardSelectedSourceKey)) {
    appState.dashboardSelectedSourceKey = sources[0].key;
  }
  const selectedKeys = new Set(sources.map((item) => item.key));
  appState.dashboardSelectedSourceKeys = new Set(
    Array.from(appState.dashboardSelectedSourceKeys).filter((key) => selectedKeys.has(key)),
  );
  const allVisibleSelected = sources.length > 0 && sources.every((item) => appState.dashboardSelectedSourceKeys.has(item.key));
  if (selectAllButton) {
    selectAllButton.innerHTML = allVisibleSelected
      ? '<span class="material-symbols-outlined !text-sm">checklist</span><span>Clear selection</span>'
      : '<span class="material-symbols-outlined !text-sm">checklist</span><span>Select all</span>';
    applyOfflineIcons(selectAllButton);
  }
  const source = sources.find((item) => item.key === appState.dashboardSelectedSourceKey);
  list.innerHTML = sources.map((item) => `
    <div class="dashboard-source-row ${item.key === appState.dashboardSelectedSourceKey ? "is-active" : ""}">
      <button onclick="window.toggleDashboardSourceSelection(${attrArg(item.key)})" class="dashboard-source-select ${appState.dashboardSelectedSourceKeys.has(item.key) ? "is-selected" : ""}" title="${appState.dashboardSelectedSourceKeys.has(item.key) ? "Deselect source" : "Select source"}" aria-label="${appState.dashboardSelectedSourceKeys.has(item.key) ? "Deselect source" : "Select source"}">
        <span class="material-symbols-outlined !text-sm">${appState.dashboardSelectedSourceKeys.has(item.key) ? "check_circle" : "add_circle"}</span>
      </button>
      <button onclick="window.selectDashboardSource(${attrArg(item.key)})" class="dashboard-source-main">
        <div class="dashboard-source-copy">
          <p class="text-sm font-bold text-slate-900 truncate">${escapeHtml(item.title)}</p>
          <p class="text-xs text-slate-400 truncate mt-1">${escapeHtml(item.filename)}</p>
        </div>
        <span class="inline-flex items-center px-2 py-1 rounded-full bg-green-50 text-green-700 text-[10px] font-bold uppercase tracking-widest">synced</span>
      </button>
      <button onclick="window.openDashboardPreview(${attrArg(item.key)})" class="dashboard-source-preview-btn" title="Open preview" aria-label="Open preview">
        <span class="material-symbols-outlined !text-base">search</span>
      </button>
    </div>
  `).join("");
  applyOfflineIcons(list);
  const selectedMeta = document.getElementById("dashboard-selected-source-meta");
  if (selectedMeta) {
    const selectedSources = currentSelectedDashboardSources();
    selectedMeta.textContent = selectedSources.length > 1
      ? `${selectedSources.length} sources selected. Add report, slide, quiz, flashcard, or audio jobs for them.`
      : source
      ? `${source.title} selected. Add report, slide, quiz, flashcard, or audio jobs for this source.`
      : "Select a source on the left, then add report, slide, quiz, flashcard, or audio jobs for it.";
  }
  updateDashboardSelectedCount();
}

async function prepareNotebooksView({ force = false } = {}) {
  setNotebookDashboardLoading(true);
  try {
    await fetchLocalProjects();
    await loadExistingNotebooks({ force });
    renderRemoteNotebookList();
    renderNotebookDashboardDetail();
  } finally {
    setNotebookDashboardLoading(false);
  }
}

function renderNotebookDashboardDetail() {
  const overviewPanel = document.getElementById("notebook-overview-panel");
  const workspacePanel = document.getElementById("notebook-workspace-panel");
  const title = document.getElementById("dashboard-header-title");
  const subtitle = document.getElementById("dashboard-header-subtitle");
  const linkButton = document.getElementById("dashboard-notebook-link-btn");
  if (!overviewPanel || !workspacePanel || !title || !subtitle) return;
  if (!appState.notebookWorkspaceActive || !appState.dashboardNotebookId) {
    overviewPanel.classList.remove("hidden");
    workspacePanel.classList.add("hidden");
    return;
  }
  overviewPanel.classList.add("hidden");
  workspacePanel.classList.remove("hidden");
  title.textContent = appState.dashboardNotebookTitle || appState.dashboardNotebookId;
  const linked = linkedProjectsForNotebook(appState.dashboardNotebookId);
  subtitle.textContent = linked.length > 0
    ? "Inspect synced sources, submit Studio jobs, and review NotebookLM outputs here."
    : "This notebook has no synced local sources yet. Sync a project first to manage it here.";
  if (linkButton) {
    const url = `https://notebooklm.google.com/notebook/${appState.dashboardNotebookId}`;
    linkButton.classList.remove("hidden");
    linkButton.onclick = (event) => {
      event.preventDefault();
      window.electronAPI.openExternal(url);
    };
  }
  setNotebookWorkspaceNotice(appState.notebookWorkspaceNotice);
  if (!appState.dashboardProjectPath && linked.length > 0) {
    appState.dashboardProjectPath = linked[0].path;
  }
  if (appState.dashboardProjectPath && !linked.some((project) => project.path === appState.dashboardProjectPath)) {
    appState.dashboardProjectPath = linked[0]?.path || null;
  }
  renderDashboardSources();
  refreshPromptDropdowns();
  updateStudioSettingsSummaries();
  prepareStudioView();
  switchNotebookWorkspaceTab(appState.notebookWorkspaceTab);
}

function selectDashboardNotebook(notebookId, notebookTitle) {
  appState.dashboardNotebookId = notebookId;
  appState.dashboardNotebookTitle = notebookTitle || notebookId;
  appState.dashboardProjectPath = linkedProjectsForNotebook(notebookId)[0]?.path || null;
  appState.dashboardSourceSearchQuery = "";
  appState.dashboardSelectedSourceKey = null;
  appState.dashboardSelectedSourceKeys = new Set();
  appState.notebookWorkspaceActive = true;
  appState.notebookWorkspaceTab = "sources";
  appState.studioQueue = [];
  appState.studioArtifacts = [];
  appState.notebookWorkspaceNotice = "";
  const search = document.getElementById("dashboard-source-search");
  if (search) search.value = "";
  renderNotebookDashboardDetail();
}

function exitNotebookWorkspace() {
  appState.notebookWorkspaceActive = false;
  appState.dashboardNotebookId = null;
  appState.dashboardNotebookTitle = null;
  appState.dashboardProjectPath = null;
  appState.dashboardSelectedSourceKey = null;
  appState.dashboardSourceSearchQuery = "";
  appState.dashboardSelectedSourceKeys = new Set();
  appState.studioQueue = [];
  appState.notebookWorkspaceTab = "sources";
  appState.studioArtifacts = [];
  appState.notebookWorkspaceNotice = "";
  renderRemoteNotebookList();
  renderNotebookDashboardDetail();
}

function selectDashboardLineage(projectPath) {
  appState.dashboardProjectPath = projectPath;
  appState.dashboardSelectedSourceKey = null;
  appState.dashboardSelectedSourceKeys = new Set();
  appState.studioQueue = [];
  appState.notebookWorkspaceTab = "sources";
  renderNotebookDashboardDetail();
}

function selectDashboardSource(sourceKey) {
  appState.dashboardSelectedSourceKey = sourceKey;
  renderDashboardSources();
}

function toggleDashboardSourceSelection(sourceKey) {
  if (appState.dashboardSelectedSourceKeys.has(sourceKey)) {
    appState.dashboardSelectedSourceKeys.delete(sourceKey);
  } else {
    appState.dashboardSelectedSourceKeys.add(sourceKey);
  }
  if (!appState.dashboardSelectedSourceKey) {
    appState.dashboardSelectedSourceKey = sourceKey;
  }
  renderDashboardSources();
}

function toggleAllDashboardSources() {
  const sources = currentDashboardSources();
  if (sources.length === 0) return;
  const allVisibleSelected = sources.every((item) => appState.dashboardSelectedSourceKeys.has(item.key));
  if (allVisibleSelected) {
    for (const item of sources) {
      appState.dashboardSelectedSourceKeys.delete(item.key);
    }
  } else {
    for (const item of sources) {
      appState.dashboardSelectedSourceKeys.add(item.key);
    }
  }
  if (!appState.dashboardSelectedSourceKey && sources[0]) {
    appState.dashboardSelectedSourceKey = sources[0].key;
  }
  renderDashboardSources();
}

function switchNotebookWorkspaceTab(tabName) {
  appState.notebookWorkspaceTab = tabName;
  const sourcesPanel = document.getElementById("dashboard-sources-panel");
  const queuePanel = document.getElementById("dashboard-queue-panel");
  const studiosPanel = document.getElementById("dashboard-studios-panel");
  const sourcesTab = document.getElementById("workspace-tab-sources");
  const queueTab = document.getElementById("workspace-tab-queue");
  const studiosTab = document.getElementById("workspace-tab-studios");

  if (sourcesPanel) sourcesPanel.classList.toggle("hidden", tabName !== "sources");
  if (queuePanel) queuePanel.classList.toggle("hidden", tabName !== "queue");
  if (studiosPanel) studiosPanel.classList.toggle("hidden", tabName !== "studios");
  if (sourcesTab) sourcesTab.className = tabName === "sources" ? "workspace-tab workspace-tab-active" : "workspace-tab";
  if (queueTab) queueTab.className = tabName === "queue" ? "workspace-tab workspace-tab-active" : "workspace-tab";
  if (studiosTab) studiosTab.className = tabName === "studios" ? "workspace-tab workspace-tab-active" : "workspace-tab";
  if (tabName === "studios") {
    void loadStudioArtifacts();
  }
}

async function openDashboardPreview(sourceKey) {
  const source = currentDashboardSources().find((item) => item.key === (sourceKey || appState.dashboardSelectedSourceKey));
  if (!source) return;
  const modal = document.getElementById("preview-modal");
  const title = document.getElementById("preview-modal-title");
  const meta = document.getElementById("preview-modal-meta");
  const body = document.getElementById("preview-modal-body");
  if (!modal || !title || !meta || !body) return;
  const result = await window.electronAPI.readFile(source.path);
  title.textContent = source.title;
  meta.textContent = `${source.projectName} · ${source.filename}`;
  body.innerHTML = result.success
    ? String(result.content)
      .split("\n\n")
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join("")
    : "<p>Could not load local source preview.</p>";
  modal.classList.remove("hidden");
}

function closeDashboardPreview() {
  const modal = document.getElementById("preview-modal");
  if (modal) modal.classList.add("hidden");
}

async function refreshNotebookDashboard() {
  await prepareNotebooksView({ force: true });
}

export {
  setNotebookWorkspaceNotice,
  setNotebookDashboardLoading,
  openNotebookDashboard,
  linkedProjectsForNotebook,
  notebookSummary,
  currentDashboardProject,
  currentDashboardSources,
  currentSelectedDashboardSources,
  updateDashboardSelectedCount,
  renderRemoteNotebookList,
  renderDashboardLineages,
  renderDashboardSources,
  prepareNotebooksView,
  renderNotebookDashboardDetail,
  selectDashboardNotebook,
  exitNotebookWorkspace,
  selectDashboardLineage,
  selectDashboardSource,
  toggleDashboardSourceSelection,
  toggleAllDashboardSources,
  switchNotebookWorkspaceTab,
  openDashboardPreview,
  closeDashboardPreview,
  refreshNotebookDashboard,
};
