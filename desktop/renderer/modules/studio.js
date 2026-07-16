import {
  appState,
  studioIconNames,
  promptStudioTypes,
  chunkOutputRoot,
  defaultStudioSettings,
  getMaxParallel,
  getMaxParallelChunks,
  readJson,
} from "./state.js";
import {
  escapeHtml,
  attrArg,
  matchesQuery,
  renderTabBar,
  applyOfflineIcons,
  showToast,
} from "./dom.js";
import { fetchLocalProjects } from "./history.js";
import {
  currentDashboardProject,
  currentDashboardSources,
  currentSelectedDashboardSources,
  renderNotebookDashboardDetail,
  renderRemoteNotebookList,
  renderDashboardLineages,
} from "./dashboard.js";
import { filteredStudioArtifacts, normalizedArtifactStatus } from "./artifacts.js";

function buildQueueItemForSources(studioName, activeProject, selectedSources, sourceIds, { batchNumber, isPerSource = false } = {}) {
  const studios = buildStudioSelections();
  const config = studios[studioName];
  if (!config) return null;
  const label = studioName.replace(/_/g, " ");
  const summary = isPerSource
    ? selectedSources[0]?.title || "Selected source"
    : selectedSources.length === 1
    ? selectedSources[0].title
    : `${selectedSources.length} selected sources`;
  return {
    id: `${studioName}-${batchNumber}`,
    studioName,
    lineagePath: activeProject.path,
    localRunName: activeProject.rawName,
    notebookId: activeProject.metadata?.notebook_id,
    label,
    displayLabel: `${label} batch #${batchNumber}`,
    sourceIds,
    sourceSummary: summary,
    config: {
      ...config,
      perChunk: false,
    },
  };
}

async function resolveDashboardSourceIds(activeProject, selectedSources) {
  let sourceIds = selectedSources.map((item) => item.sourceId).filter(Boolean);
  if (sourceIds.length === selectedSources.length) {
    return sourceIds;
  }
  await fetchLocalProjects();
  renderNotebookDashboardDetail();
  const refreshedLookup = new Map(currentDashboardSources().map((item) => [item.key, item.sourceId]));
  sourceIds = selectedSources.map((item) => refreshedLookup.get(item.key)).filter(Boolean);
  if (sourceIds.length === selectedSources.length) {
    return sourceIds;
  }
  if (activeProject.path) {
    const runState = await readJson(`${activeProject.path}/.nblm-run-state.json`);
    const runStateChunks = runState?.chunks || {};
    sourceIds = selectedSources
      .map((item) => {
        const chunkState = runStateChunks?.[item.filename] || {};
        return chunkState?.source?.source_id || chunkState?.source_id || null;
      })
      .filter(Boolean);
  }
  return sourceIds;
}

function buildStudioSelections() {
  const activeProjectPath = currentDashboardProject()?.path || appState.outputDir;
  const base = activeProjectPath ? activeProjectPath.replace(/\/chunks$/, "") : chunkOutputRoot();
  if (!base) return {};
  const settings = {
    ...defaultStudioSettings(),
    ...(appState.studioSettings || {}),
  };
  return {
    report: {
      enabled: true,
      outputDir: `${base}/reports`,
      prompt: document.getElementById("studio-report-prompt")?.value.trim(),
      language: settings.report.language,
      format: settings.report.format,
      maxParallel: getMaxParallel("report"),
    },
    slide_deck: {
      enabled: true,
      outputDir: `${base}/slides`,
      prompt: document.getElementById("studio-slide-prompt")?.value.trim(),
      language: settings.slide_deck.language,
      format: settings.slide_deck.format,
      length: settings.slide_deck.length,
      downloadFormat: settings.slide_deck.downloadFormat,
      maxParallel: getMaxParallel("slide_deck"),
    },
    quiz: {
      enabled: true,
      outputDir: `${base}/quizzes`,
      prompt: document.getElementById("studio-quiz-prompt")?.value.trim(),
      quantity: settings.quiz.quantity,
      difficulty: settings.quiz.difficulty,
      downloadFormat: settings.quiz.downloadFormat,
      maxParallel: getMaxParallel("quiz"),
    },
    flashcards: {
      enabled: true,
      outputDir: `${base}/flashcards`,
      prompt: document.getElementById("studio-flashcards-prompt")?.value.trim(),
      quantity: settings.flashcards.quantity,
      difficulty: settings.flashcards.difficulty,
      downloadFormat: settings.flashcards.downloadFormat,
      maxParallel: getMaxParallel("flashcards"),
    },
    audio: {
      enabled: true,
      outputDir: `${base}/audio`,
      prompt: document.getElementById("studio-audio-prompt")?.value.trim(),
      language: settings.audio.language,
      format: settings.audio.format,
      length: settings.audio.length,
      maxParallel: getMaxParallel("audio"),
    },
  };
}

function studioQueueSummary(activeProject) {
  if (!activeProject) {
    return "Choose a local run to start building the queue.";
  }
  const selectedSources = currentSelectedDashboardSources();
  if (selectedSources.length === 0) {
    return "Choose a source to start building the queue.";
  }
  if (appState.studioQueue.length === 0) {
    return "Queue is empty. Add report, slide, quiz, flashcard, or audio batches for the selected source set.";
  }
  return `${appState.studioQueue.length} queued job${appState.studioQueue.length === 1 ? "" : "s"} across the selected sources in this local run.`;
}

async function retryStudioJob(jobId) {
  const activeProject = currentDashboardProject();
  if (!activeProject) return;
  const result = await window.electronAPI.retryStudioJob({
    projectPath: activeProject.path,
    jobId,
  });
  if (!result.success) {
    alert(result.error || "Could not retry job.");
    return;
  }
  await fetchLocalProjects();
  renderNotebookDashboardDetail();
  showToast("Job re-queued for retry.");
}

async function retryAllFailedStudioJobs() {
  const activeProject = currentDashboardProject();
  if (!activeProject) return;
  const result = await window.electronAPI.retryAllFailedStudioJobs({
    projectPath: activeProject.path,
  });
  if (!result.success) {
    alert(result.error || "Could not retry failed jobs.");
    return;
  }
  await fetchLocalProjects();
  renderNotebookDashboardDetail();
  showToast(`${result.retried} failed job${result.retried === 1 ? "" : "s"} re-queued for retry.`);
}

async function removeBackgroundStudioJob(jobId) {
  const activeProject = currentDashboardProject();
  if (!activeProject) return;
  const result = await window.electronAPI.removeStudioJob({
    projectPath: activeProject.path,
    jobId,
  });
  if (!result.success) {
    alert(result.error || "Could not remove job.");
    return;
  }
  await fetchLocalProjects();
  renderNotebookDashboardDetail();
}

async function clearSubmittedStudioJobs() {
  const activeProject = currentDashboardProject();
  if (!activeProject) return;
  const result = await window.electronAPI.clearSubmittedStudioJobs({
    projectPath: activeProject.path,
  });
  if (!result.success) {
    alert(result.error || "Could not clear submitted jobs.");
    return;
  }
  await fetchLocalProjects();
  renderNotebookDashboardDetail();
  showToast(`${result.removed} submitted job${result.removed === 1 ? "" : "s"} cleared.`);
}

function selectStudioQueueTab(tab) {
  appState.studioQueueTab = tab;
  prepareStudioView();
}

function filteredQueueJobs(backgroundJobs) {
  const tab = appState.studioQueueTab || "all";
  return backgroundJobs.filter((job) => {
    if (tab !== "all" && job.studioName !== tab) return false;
    return matchesQuery(
      `${job.displayLabel || job.label || ""} ${job.sourceSummary || ""} ${job.message || ""} ${job.status || ""}`,
      appState.studioQueueSearchQuery,
    );
  });
}

// Live "retry in mm:ss" text for a quota-blocked job, from its ISO blocked_until.
function studioCountdownText(iso) {
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "Waiting to retry";
  const ms = target - Date.now();
  if (ms <= 0) return "Retrying…";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  const clock = hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
  return `Retry in ${clock}`;
}

// A single interval refreshes every visible countdown once a second and stops
// itself when no blocked jobs remain on screen.
let studioCountdownTimer = null;
function syncStudioCountdowns() {
  const tick = () => {
    const nodes = document.querySelectorAll(".queue-countdown[data-blocked-until]");
    if (nodes.length === 0) {
      if (studioCountdownTimer) {
        clearInterval(studioCountdownTimer);
        studioCountdownTimer = null;
      }
      return;
    }
    nodes.forEach((node) => {
      node.textContent = studioCountdownText(node.getAttribute("data-blocked-until"));
    });
  };
  tick();
  if (!studioCountdownTimer) {
    studioCountdownTimer = setInterval(tick, 1000);
  }
}

function renderQueueJobRow(job) {
  const tone = job.status === "failed"
    ? "queue-progress-bar is-failed"
    : job.status === "submitted"
    ? "queue-progress-bar is-complete"
    : job.status === "running"
    ? "queue-progress-bar is-running"
    : job.status === "blocked"
    ? "queue-progress-bar is-blocked"
    : "queue-progress-bar";
  const isBlocked = job.status === "blocked" && job.blockedUntil;
  const statusLine = isBlocked
    ? `<p class="text-[11px] text-amber-600 font-semibold mt-2 queue-countdown" data-blocked-until="${escapeHtml(job.blockedUntil)}">${escapeHtml(studioCountdownText(job.blockedUntil))}</p>`
    : `<p class="text-[11px] text-slate-400 mt-2">${escapeHtml(job.message || job.status)}</p>`;
  const logLines = job.status === "failed" ? 6 : 3;
  const logPreview = Array.isArray(job.logs) && job.logs.length > 0
    ? `<div class="queue-log-preview ${job.status === "failed" ? "is-error" : ""}">${job.logs.slice(-logLines).map((entry) => `<p>[${escapeHtml(entry.channel)}] ${escapeHtml(entry.line)}</p>`).join("")}</div>`
    : "";
  return `
    <div class="flex items-center justify-between gap-4 p-4 rounded-2xl bg-slate-50 border border-slate-100">
      <div class="min-w-0 flex items-start gap-3">
        <span class="material-symbols-outlined text-primary !text-lg">${studioIconNames[job.studioName] || "description"}</span>
        <div class="min-w-0">
          <p class="font-bold text-slate-900 capitalize">${escapeHtml(job.displayLabel || job.label)}</p>
          <p class="text-xs text-slate-400 truncate">${escapeHtml(job.sourceSummary)} · ${escapeHtml(job.localRunName)}</p>
          <div class="queue-progress"><div class="${tone}" style="width: ${Number(job.progress || 0)}%"></div></div>
          ${statusLine}
          ${logPreview}
        </div>
      </div>
      <div class="flex flex-col items-end gap-2">
        <span class="inline-flex items-center px-3 py-1 rounded-full ${job.status === "failed" ? "bg-red-50 text-red-500" : job.status === "submitted" ? "bg-green-50 text-green-700" : job.status === "running" ? "bg-blue-50 text-blue-700" : job.status === "blocked" ? "bg-orange-50 text-orange-600" : "bg-amber-50 text-amber-700"} text-xs font-bold uppercase">${job.status}</span>
        <div class="flex items-center gap-1">
          ${(job.status === "failed" || job.status === "blocked") ? `<button onclick="window.retryStudioJob(${attrArg(job.id)})" class="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-bold hover:bg-primary/20 transition-all cursor-pointer"><span class="material-symbols-outlined !text-xs">refresh</span>${job.status === "blocked" ? "Retry now" : "Retry"}</button>` : ""}
          ${job.status !== "running" ? `<button onclick="window.removeBackgroundStudioJob(${attrArg(job.id)})" class="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all" title="Remove"><span class="material-symbols-outlined !text-sm">delete</span></button>` : ""}
        </div>
      </div>
    </div>
  `;
}

function renderStudioQueue(activeProject) {
  const queueList = document.getElementById("studio-queue-list");
  const tabBar = document.getElementById("studio-queue-tab-bar");
  const searchInput = document.getElementById("studio-queue-search");
  if (!queueList) return;
  const backgroundJobs = activeProject?.queueState?.jobs || [];
  const allJobs = [...appState.studioQueue.map((item, index) => ({ ...item, _staged: true, _index: index, status: "staged" })), ...backgroundJobs];

  // Render tab bar
  if (tabBar) {
    const queueTabs = ["all", ...promptStudioTypes];
    const countFor = (tab) => (tab === "all" ? allJobs.length : allJobs.filter((j) => j.studioName === tab).length);
    tabBar.innerHTML = renderTabBar(queueTabs, appState.studioQueueTab, "selectStudioQueueTab", {
      skip: (tab) => tab !== "all" && countFor(tab) === 0,
      label: (tab) => `${tab === "all" ? "All" : tab.replace(/_/g, " ")} <span class="text-[10px] opacity-60">${countFor(tab)}</span>`,
    });
  }
  if (searchInput) {
    searchInput.value = appState.studioQueueSearchQuery;
  }

  if (allJobs.length === 0) {
    queueList.innerHTML = '<div class="p-4 rounded-2xl border border-slate-100 bg-slate-50 text-slate-400 italic">No queued Studio batches yet.</div>';
    syncStudioCountdowns();
    return;
  }

  // Action buttons
  const failedCount = backgroundJobs.filter((job) => job.status === "failed").length;
  const submittedCount = backgroundJobs.filter((job) => job.status === "submitted").length;
  const actionButtons = [];
  if (submittedCount > 0) {
    actionButtons.push(`<button onclick="window.clearSubmittedStudioJobs()" class="p-2 rounded-lg text-green-600 hover:bg-green-50 transition-all" title="Clear ${submittedCount} submitted job${submittedCount === 1 ? "" : "s"}"><span class="material-symbols-outlined !text-lg">done_all</span></button>`);
  }
  if (failedCount > 1) {
    actionButtons.push(`<button onclick="window.retryAllFailedStudioJobs()" class="p-2 rounded-lg text-red-500 hover:bg-red-50 transition-all" title="Retry ${failedCount} failed job${failedCount === 1 ? "" : "s"}"><span class="material-symbols-outlined !text-lg">refresh</span></button>`);
  }
  const topBar = actionButtons.length > 0
    ? `<div class="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-50 border border-slate-100"><p class="text-[11px] text-slate-400">Submitted jobs may keep processing inside NotebookLM after they leave this queue.</p><div class="flex items-center gap-1">${actionButtons.join("")}</div></div>`
    : "";

  // Filter and render
  const filteredBg = filteredQueueJobs(backgroundJobs);
  const tab = appState.studioQueueTab || "all";
  const query = appState.studioQueueSearchQuery.trim().toLowerCase();
  const filteredStaged = appState.studioQueue
    .map((item, index) => ({ ...item, _index: index }))
    .filter((item) => {
      if (tab !== "all" && item.studioName !== tab) return false;
      return matchesQuery(
        `${item.displayLabel || item.label || ""} ${item.sourceSummary || ""}`,
        appState.studioQueueSearchQuery,
      );
    });

  const stagedRows = filteredStaged.map((item) => `
    <div class="flex items-center justify-between gap-4 p-4 rounded-2xl bg-slate-50 border border-slate-100">
      <div class="min-w-0 flex items-start gap-3">
        <span class="material-symbols-outlined text-primary !text-lg">${studioIconNames[item.studioName] || "description"}</span>
        <div class="min-w-0">
          <p class="font-bold text-slate-900 capitalize">${escapeHtml(item.displayLabel || item.label)}</p>
          <p class="text-xs text-slate-400 truncate">${escapeHtml(item.sourceSummary)} · ${escapeHtml(item.localRunName)}</p>
          <p class="text-[11px] text-amber-600 mt-2">Ready to enqueue</p>
        </div>
      </div>
      <div class="flex flex-col items-end gap-2">
        <span class="inline-flex items-center px-3 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-bold uppercase">staged</span>
        <button onclick="window.removeStudioQueueItem(${item._index})" class="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all" title="Remove"><span class="material-symbols-outlined !text-sm">delete</span></button>
      </div>
    </div>
  `).join("");

  const backgroundRows = filteredBg.map((job) => renderQueueJobRow(job)).join("");

  const tabLabel = tab === "all" ? "" : tab.replace(/_/g, " ");
  const emptyMessage = filteredBg.length === 0 && filteredStaged.length === 0
    ? `<div class="p-4 rounded-2xl border border-slate-100 bg-slate-50 text-slate-400 italic">No ${tabLabel} jobs found${query ? " matching your filter" : ""}.</div>`
    : "";

  queueList.innerHTML = `${topBar}${stagedRows}${backgroundRows}${emptyMessage}`;
  applyOfflineIcons(queueList);
  syncStudioCountdowns();
}

function prepareStudioView() {
  const summaryEl = document.getElementById("studio-summary");
  const generatedList = document.getElementById("studio-generated-list");
  const deleteButton = document.getElementById("delete-studio-selection-btn");
  const studioTabBar = document.getElementById("studio-artifact-tab-bar");
  const studioSearch = document.getElementById("studio-artifact-search");
  const activeProject = currentDashboardProject();
  if (summaryEl) {
    summaryEl.textContent = studioQueueSummary(activeProject);
  }
  const generateButton = document.getElementById("generate-studios-btn");
  if (generateButton) generateButton.disabled = !activeProject || appState.studioQueue.length === 0;
  renderStudioQueue(activeProject);
  if (generatedList) {
    if (studioTabBar) {
      studioTabBar.innerHTML = renderTabBar(promptStudioTypes, appState.studioArtifactsTab, "selectStudioArtifactsTab");
    }
    if (studioSearch) {
      studioSearch.value = appState.studioArtifactsSearchQuery;
    }
    if (appState.studioArtifactsLoading) {
      generatedList.innerHTML = '<div class="p-4 rounded-2xl border border-slate-100 bg-slate-50 text-slate-400 italic">Loading NotebookLM Studio items...</div>';
      return;
    }
    const knownIds = new Set((appState.studioArtifacts || []).map((item) => item.id).filter(Boolean));
    appState.selectedStudioArtifactIds = new Set(
      Array.from(appState.selectedStudioArtifactIds).filter((id) => knownIds.has(id)),
    );
    if (deleteButton) {
      deleteButton.disabled = appState.deletingStudioArtifacts || appState.selectedStudioArtifactIds.size === 0;
      deleteButton.title = appState.deletingStudioArtifacts ? "Deleting..." : "Delete selected";
      deleteButton.setAttribute("aria-label", appState.deletingStudioArtifacts ? "Deleting..." : "Delete selected");
      deleteButton.innerHTML = appState.deletingStudioArtifacts
        ? '<span class="material-symbols-outlined">sync_problem</span>'
        : '<span class="material-symbols-outlined">delete</span>';
    }
    const items = filteredStudioArtifacts();
    const label = appState.studioArtifactsTab.replace(/_/g, " ");
    generatedList.innerHTML = items.length === 0 ? `
      <div class="p-4 rounded-2xl border border-slate-100 bg-slate-50 text-slate-400 italic">
        No ${label} items found in NotebookLM yet.
      </div>
    ` : items.map((item) => {
      const statusLabel = normalizedArtifactStatus(item.status);
      return `
      <div class="flex items-center justify-between gap-4 p-4 rounded-2xl bg-slate-50 border border-slate-100">
        <div class="min-w-0 flex items-start gap-3">
          <input type="checkbox" ${appState.selectedStudioArtifactIds.has(item.id) ? "checked" : ""} onchange="window.toggleStudioArtifactSelection(${attrArg(item.id)})" class="prompt-checkbox" />
          <span class="material-symbols-outlined text-primary !text-lg">${studioIconNames[appState.studioArtifactsTab] || "description"}</span>
          <div class="min-w-0">
            <p class="font-bold text-slate-900">${escapeHtml(item.title || "Untitled artifact")}</p>
            <p class="text-xs text-slate-400 truncate">${escapeHtml(item.kind || "artifact")}${statusLabel ? ` · ${escapeHtml(statusLabel)}` : ""}</p>
          </div>
        </div>
        <span class="inline-flex items-center px-3 py-1 rounded-full ${statusLabel.includes("fail") ? "bg-red-50 text-red-500" : statusLabel.includes("process") || statusLabel.includes("queue") ? "bg-blue-50 text-blue-700" : "bg-green-50 text-green-700"} text-xs font-bold uppercase">${escapeHtml(statusLabel)}</span>
      </div>
    `;
    }).join("");
    applyOfflineIcons(document.getElementById("dashboard-studios-panel") || generatedList);
  }
}

async function addStudioQueueItem(studioName) {
  const activeProject = currentDashboardProject();
  if (!activeProject) {
    alert("Choose a local run first.");
    return;
  }
  const selectedSources = currentSelectedDashboardSources();
  if (selectedSources.length === 0) {
    alert("Choose a source first.");
    return;
  }
  const sourceIds = await resolveDashboardSourceIds(activeProject, selectedSources);
  if (sourceIds.length === 0) {
    alert("The selected sources are missing NotebookLM source IDs.");
    return;
  }
  appState.studioQueueCounter += 1;
  const batchNumber = appState.studioQueueCounter;
  const queueItem = buildQueueItemForSources(studioName, activeProject, selectedSources, sourceIds, { batchNumber });
  if (!queueItem) return;
  appState.studioQueue.push(queueItem);
  prepareStudioView();
  showToast(`${queueItem.label} added to queue.`);
}

async function addStudioQueueItemsForSelection(studioName) {
  const activeProject = currentDashboardProject();
  if (!activeProject) {
    alert("Choose a notebook workspace first.");
    return;
  }
  const selectedSources = currentSelectedDashboardSources();
  if (selectedSources.length === 0) {
    alert("Choose at least one source first.");
    return;
  }
  const label = studioName.replace(/_/g, " ");
  const confirmed = confirm(`This will add ${selectedSources.length} ${label} job${selectedSources.length === 1 ? "" : "s"} to the queue, one for each selected source. Continue?`);
  if (!confirmed) return;
  const sourceIds = await resolveDashboardSourceIds(activeProject, selectedSources);
  if (sourceIds.length !== selectedSources.length) {
    alert("Some selected sources are missing NotebookLM source IDs.");
    return;
  }
  const queuedItems = [];
  selectedSources.forEach((source, index) => {
    appState.studioQueueCounter += 1;
    const queueItem = buildQueueItemForSources(
      studioName,
      activeProject,
      [source],
      [sourceIds[index]],
      { batchNumber: appState.studioQueueCounter, isPerSource: true },
    );
    if (queueItem) {
      queuedItems.push(queueItem);
    }
  });
  if (queuedItems.length === 0) return;
  appState.studioQueue.push(...queuedItems);
  prepareStudioView();
  showToast(`${queuedItems.length} ${label} job${queuedItems.length === 1 ? "" : "s"} added to queue.`);
}

function removeStudioQueueItem(index) {
  appState.studioQueue.splice(index, 1);
  prepareStudioView();
}

async function runStudios() {
  const activeProject = currentDashboardProject();
  if (!activeProject || !activeProject.metadata?.notebook_id) {
    alert("Choose a linked notebook local run first.");
    return;
  }
  if (appState.studioQueue.length === 0) {
    alert("Add at least one Studio batch to the queue.");
    return;
  }
  const button = document.getElementById("generate-studios-btn");
  if (button) button.disabled = true;
  try {
    const jobs = appState.studioQueue.map((item) => ({
      ...item,
      configToml: window.projectUtils.buildStudiosToml({
        outputDir: `${item.lineagePath}/.desktop-studio-scratch/${item.id}`,
        notebookId: item.notebookId,
        maxParallelChunks: getMaxParallelChunks(),
        downloadOutputs: true,
        studios: {
          [item.studioName]: item.config,
        },
      }),
      args: item.sourceIds.flatMap((sourceId) => ["--source-id", sourceId]),
    }));
    const result = await window.electronAPI.enqueueStudioJobs({
      projectPath: activeProject.path,
      jobs,
    });
    if (!result.success) {
      throw new Error(result.error || "Could not enqueue Studio jobs.");
    }
    appState.studioQueue = [];
    await fetchLocalProjects();
    renderNotebookDashboardDetail();
    showToast("Studio jobs submitted. Use the Studios tab to track final output status.");
  } catch (error) {
    alert(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function applyStudioQueueUpdate(payload) {
  const project = appState.localProjects.find((item) => item.path === payload.projectPath);
  if (project) {
    project.queueState = payload.queue;
  }
  if (appState.currentView === "notebooks") {
    renderRemoteNotebookList();
  }
  if (appState.dashboardProjectPath === payload.projectPath) {
    prepareStudioView();
    renderDashboardLineages();
  }
}

export {
  buildQueueItemForSources,
  resolveDashboardSourceIds,
  buildStudioSelections,
  studioQueueSummary,
  retryStudioJob,
  retryAllFailedStudioJobs,
  removeBackgroundStudioJob,
  clearSubmittedStudioJobs,
  selectStudioQueueTab,
  filteredQueueJobs,
  renderQueueJobRow,
  renderStudioQueue,
  prepareStudioView,
  addStudioQueueItem,
  addStudioQueueItemsForSelection,
  removeStudioQueueItem,
  runStudios,
  applyStudioQueueUpdate,
};
