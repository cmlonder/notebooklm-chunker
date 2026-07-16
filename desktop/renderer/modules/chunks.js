import {
  appState,
  DEFAULT_CHUNK_MIN_PAGES,
  DEFAULT_CHUNK_MAX_PAGES,
  isReadOnlyProject,
  selectedChunk,
  hasPreparedChunks,
  hasSyncedLineage,
  formatPdfLabel,
  formatNotebookLabel,
  readJson,
  saveTextFile,
  loadProjectMetadata,
  loadRunState,
  saveProjectMetadata,
  saveManifest,
} from "./state.js";
import { escapeHtml, applyOfflineIcons, showLoading, hideLoading } from "./dom.js";
import { switchView, updateNavigationLocks } from "./navigation.js";
import { prepareSyncView } from "./sync.js";
import { prepareStudioView } from "./studio.js";

function syncStructureInputs({ force = false } = {}) {
  const minInput = document.getElementById("min-pages-input");
  const maxInput = document.getElementById("max-pages-input");
  if (!minInput || !maxInput) return;
  if (force || !appState.structureSettingsDirty) {
    minInput.value = String(DEFAULT_CHUNK_MIN_PAGES);
    maxInput.value = String(DEFAULT_CHUNK_MAX_PAGES);
    const skipStartInput = document.getElementById("skip-start-input");
    const skipEndInput = document.getElementById("skip-end-input");
    const skipRangesInput = document.getElementById("skip-ranges-input");
    if (skipStartInput) skipStartInput.value = "0";
    if (skipEndInput) skipEndInput.value = "0";
    if (skipRangesInput) skipRangesInput.value = "";
  }
  updateEstimatedChunkCount();
}

function handleStructureSettingChange() {
  appState.structureSettingsDirty = true;
  updateEstimatedChunkCount();
}

function updateEstimatedChunkCount() {
  const el = document.getElementById("estimated-chunk-count");
  if (!el) return;
  const minPages = Number(document.getElementById("min-pages-input")?.value || DEFAULT_CHUNK_MIN_PAGES);
  const maxPages = Number(document.getElementById("max-pages-input")?.value || DEFAULT_CHUNK_MAX_PAGES);
  const skipStart = Number(document.getElementById("skip-start-input")?.value || 0);
  const skipEnd = Number(document.getElementById("skip-end-input")?.value || 0);
  const skipRanges = window.projectUtils.parseSkipRanges(
    document.getElementById("skip-ranges-input")?.value || "",
  );
  const skippedPages = window.projectUtils.countSkippedPages({
    totalPages: appState.totalPages,
    skipStart,
    skipEnd,
    ranges: skipRanges,
  });
  const effectivePages = Math.max(0, appState.totalPages - skippedPages);
  if (effectivePages <= 0 || minPages <= 0 || maxPages <= 0) {
    el.textContent = "?";
    return;
  }
  const avgPages = (minPages + maxPages) / 2;
  const estimated = Math.max(1, Math.round(effectivePages / avgPages));
  el.textContent = String(estimated);
}

function updateSourceUI(name) {
  const dropZone = document.getElementById("drop-zone");
  const selectedState = document.getElementById("selected-state");
  const duplicateState = document.getElementById("duplicate-state");
  if (dropZone) dropZone.style.display = "none";
  if (duplicateState) duplicateState.style.display = "none";
  if (selectedState) {
    selectedState.style.display = "flex";
    document.getElementById("selected-file-name").textContent = name;
  }
}

function resetSourceUI() {
  const dropZone = document.getElementById("drop-zone");
  const selectedState = document.getElementById("selected-state");
  const duplicateState = document.getElementById("duplicate-state");
  if (dropZone) dropZone.style.display = "flex";
  if (selectedState) selectedState.style.display = "none";
  if (duplicateState) duplicateState.style.display = "none";
}

function prepareSourcesView() {
  const readOnly = isReadOnlyProject();
  const selectRow = document.getElementById("catalog-select-row");
  const titleActions = document.getElementById("catalog-title-actions");
  const continueButton = document.getElementById("continue-sync-btn");
  const readOnlyBanner = document.getElementById("sources-readonly-banner");
  const emptyHint = document.getElementById("sources-empty-hint");
  if (selectRow) selectRow.style.display = readOnly ? "none" : "flex";
  if (titleActions) titleActions.style.display = readOnly ? "none" : "flex";
  if (continueButton) continueButton.style.display = readOnly ? "none" : "block";
  if (readOnlyBanner) readOnlyBanner.style.display = readOnly ? "block" : "none";
  if (emptyHint) emptyHint.style.display = readOnly ? "none" : "inline";
}

function prepareSourceView() {
  const summaryCard = document.getElementById("source-summary-card");
  const selectedState = document.getElementById("selected-state");
  const dropZone = document.getElementById("drop-zone");
  const duplicateState = document.getElementById("duplicate-state");
  const selectedActions = document.getElementById("selected-file-actions");
  const subtitle = document.getElementById("selected-file-subtitle");
  const header = document.getElementById("source-view-header");
  const titleEl = document.getElementById("source-view-title");
  const subtitleEl = document.getElementById("source-view-subtitle");
  const readOnly = isReadOnlyProject();

  document.getElementById("selected-file-name").textContent = formatPdfLabel();
  if (subtitle) {
    subtitle.textContent = readOnly
      ? "Previously synced document"
      : "Document selected";
  }

  if (readOnly) {
    if (header) header.style.display = "none";
    if (dropZone) dropZone.style.display = "none";
    if (duplicateState) duplicateState.style.display = "none";
    if (selectedState) selectedState.style.display = "flex";
    if (selectedActions) selectedActions.style.display = "none";
    if (summaryCard) summaryCard.style.display = "block";
    document.getElementById("source-summary-pdf").textContent = formatPdfLabel();
    document.getElementById("source-summary-notebook").textContent = formatNotebookLabel();
    document.getElementById("source-summary-pages").textContent = appState.totalPages ? String(appState.totalPages) : "Unknown";
    document.getElementById("source-summary-chunks").textContent = String(appState.chunks.length);
  } else {
    if (header) header.style.display = "block";
    if (titleEl) titleEl.textContent = "Add Knowledge";
    if (subtitleEl) subtitleEl.textContent = "Upload a PDF to start chunking.";
    if (summaryCard) summaryCard.style.display = "none";
    if (selectedActions) selectedActions.style.display = appState.selectedPDF ? "flex" : "none";
    if (appState.selectedPDF) {
      if (dropZone) dropZone.style.display = "none";
      if (duplicateState) duplicateState.style.display = "none";
      if (selectedState) selectedState.style.display = "flex";
    } else {
      resetSourceUI();
    }
  }
}

function prepareStructureView() {
  const readOnly = isReadOnlyProject();
  const processButton = document.getElementById("process-btn");
  const banner = document.getElementById("structure-readonly-banner");
  const summary = document.getElementById("structure-readonly-summary");
  const minInput = document.getElementById("min-pages-input");
  const maxInput = document.getElementById("max-pages-input");
  const skipStartInput = document.getElementById("skip-start-input");
  const skipEndInput = document.getElementById("skip-end-input");
  const skipRangesInput = document.getElementById("skip-ranges-input");
  if (processButton) processButton.style.display = readOnly ? "none" : "block";
  if (banner) banner.style.display = readOnly ? "block" : "none";
  if (summary && readOnly) {
    summary.textContent = `${appState.totalPages || "Unknown"} pages were partitioned into ${appState.chunks.length} chunk(s) for this synced version.`;
  }
  if (minInput) minInput.disabled = readOnly;
  if (maxInput) maxInput.disabled = readOnly;
  if (skipStartInput) skipStartInput.disabled = readOnly;
  if (skipEndInput) skipEndInput.disabled = readOnly;
  if (skipRangesInput) skipRangesInput.disabled = readOnly;
  if (!readOnly) {
    updateEstimatedChunkCount();
  }
}

function filteredChunks() {
  const query = appState.chunkSearchQuery.trim().toLowerCase();
  if (!query) return appState.chunks;
  return appState.chunks.filter((chunk) =>
    chunk.filename.toLowerCase().includes(query) ||
    chunk.title.toLowerCase().includes(query),
  );
}

function startNewProject() {
  appState.isResumeMode = false;
  appState.activeNotebookId = null;
  appState.activeNotebookTitle = null;
  appState.selectedPDF = null;
  appState.outputDir = null;
  appState.totalPages = 0;
  appState.calculatedTargetPages = 3.0;
  appState.currentChunkId = null;
  appState.chunks = [];
  appState.selectedChunkIds = new Set();
  appState.structureSettingsDirty = false;
  resetSourceUI();
  switchView("source");
  updateNavigationLocks();
}

async function triggerFileSelect() {
  const result = await window.electronAPI.selectPDF();
  if (!result || !result.success) return;
  appState.selectedPDF = result.path;

  const baseStem = window.projectUtils.slugifyStem(result.name);
  const allProjects = await window.electronAPI.listProjects(appState.paths.projects);
  const rawName = window.projectUtils.nextVersionRawName(
    baseStem,
    allProjects.map((project) => project.rawName),
  );
  appState.outputDir = `${appState.paths.projects}/${rawName}`;
  updateSourceUI(result.name);
  await inspectSelectedPdf();
  await saveProjectMetadata();
  switchView("structure");
}

async function inspectSelectedPdf() {
  const result = await window.electronAPI.runNBLM({
    command: "inspect",
    args: [appState.selectedPDF],
  });
  if (!result.success) {
    throw new Error(result.error || result.output || "Could not inspect PDF.");
  }
  const inspection = JSON.parse(result.output);
  appState.totalPages = inspection.pages || 0;
  document.getElementById("total-pages-display").textContent = String(appState.totalPages || "?");
  appState.structureSettingsDirty = false;
  syncStructureInputs({ force: true });
}

async function startNewVersion() {
  if (!appState.selectedPDF) return;
  const baseStem = window.projectUtils.slugifyStem(appState.selectedPDF.split("/").pop());
  const allProjects = await window.electronAPI.listProjects(appState.paths.projects);
  const rawName = window.projectUtils.nextVersionRawName(
    baseStem,
    allProjects.map((project) => project.rawName),
  );
  appState.outputDir = `${appState.paths.projects}/${rawName}`;
  resetSourceUI();
  updateSourceUI(appState.selectedPDF.split("/").pop());
  await inspectSelectedPdf();
  await saveProjectMetadata();
  switchView("structure");
}

function updateSlider() {
  // Legacy no-op — slider has been removed in favour of min/max page inputs.
  updateEstimatedChunkCount();
}

async function forceRefine() {
  if (!appState.selectedPDF || !appState.outputDir) return;
  showLoading("Preparing chunks...");
  try {
    const minPages = Number(document.getElementById("min-pages-input")?.value || 0);
    const maxPages = Number(document.getElementById("max-pages-input")?.value || 0);
    const skipStart = Number(document.getElementById("skip-start-input")?.value || 0);
    const skipEnd = Number(document.getElementById("skip-end-input")?.value || 0);
    if (!(minPages > 0) || !(maxPages > 0) || minPages > maxPages) {
      throw new Error("Min/Max page settings are invalid. Make sure both are positive and min is not greater than max.");
    }
    const effectivePages = Math.max(0, appState.totalPages - skipStart - skipEnd);
    const avgPages = (minPages + maxPages) / 2;
    const targetPages = Number(avgPages.toFixed(2));
    const args = [
      appState.selectedPDF,
      "--yes",
      "--output-dir",
      appState.outputDir,
      "--target-pages",
      String(targetPages),
      "--min-pages",
      String(minPages),
      "--max-pages",
      String(maxPages),
    ];
    if (skipStart > 0) {
      args.push("--skip-range", `1-${skipStart}`);
    }
    if (skipEnd > 0 && appState.totalPages > 0) {
      const skipEndStart = appState.totalPages - skipEnd + 1;
      if (skipEndStart <= appState.totalPages) {
        args.push("--skip-range", `${skipEndStart}-${appState.totalPages}`);
      }
    }
    const midRanges = window.projectUtils.parseSkipRanges(
      document.getElementById("skip-ranges-input")?.value || "",
    );
    for (const rangeArg of window.projectUtils.skipRangesToArgs(midRanges)) {
      args.push("--skip-range", rangeArg);
    }
    const result = await window.electronAPI.runNBLM({
      command: "prepare",
      args,
    });
    if (!result.success) {
      throw new Error(result.error || result.output || "Chunking failed.");
    }
    await loadRealChunks();
    updateNavigationLocks();
    switchView("sources");
  } catch (error) {
    alert(error.message);
  } finally {
    hideLoading();
  }
}

async function loadRealChunks() {
  if (!appState.outputDir) return false;
  await loadProjectMetadata();
  await loadRunState();
  const manifest = await readJson(`${appState.outputDir}/manifest.json`);
  if (!manifest || !Array.isArray(manifest)) return false;
  appState.chunks = manifest
    .filter((entry) => entry.deleted !== true)
    .map((entry, index) => ({
      id: index + 1,
      title: entry.primary_heading || `Chunk ${index + 1}`,
      synced: entry.synced === true,
      source_id: entry.source_id || null,
      filename: entry.file,
      path: `${appState.outputDir}/${entry.file}`,
    }));
  return true;
}

function populateChunkList() {
  const list = document.getElementById("chunk-list");
  if (!list) return;
  const visibleChunks = filteredChunks();
  if (visibleChunks.length === 0) {
    list.innerHTML = '<p class="text-slate-400 p-4 text-center italic text-xs">Empty catalog</p>';
    return;
  }
  const lockedProject = isReadOnlyProject();
  document.getElementById("bulk-actions").style.display =
    appState.selectedChunkIds.size > 0 && !lockedProject ? "flex" : "none";
  list.innerHTML = visibleChunks.map((chunk) => `
    <div class="dashboard-source-row ${chunk.id === appState.currentChunkId ? "is-active" : ""}">
      ${lockedProject ? "" : `<button onclick="window.toggleChunk(${chunk.id}, ${!appState.selectedChunkIds.has(chunk.id)})" class="dashboard-source-select ${appState.selectedChunkIds.has(chunk.id) ? "is-selected" : ""}" title="${appState.selectedChunkIds.has(chunk.id) ? "Deselect" : "Select"}"><span class="material-symbols-outlined !text-sm">${appState.selectedChunkIds.has(chunk.id) ? "check_circle" : "add_circle"}</span></button>`}
      <button onclick="window.selectChunk(${chunk.id})" class="dashboard-source-main">
        <div class="dashboard-source-copy">
          <p class="text-sm font-bold ${chunk.id === appState.currentChunkId ? "text-primary" : "text-slate-900"} truncate">${escapeHtml(chunk.title)}</p>
          <p class="text-xs text-slate-400 truncate mt-1">${escapeHtml(chunk.filename)}</p>
        </div>
        <span class="inline-flex items-center px-2 py-1 rounded-full ${chunk.synced ? "bg-green-50 text-green-700" : "bg-blue-50 text-blue-600"} text-[10px] font-bold uppercase tracking-widest">${chunk.synced ? "synced" : "draft"}</span>
      </button>
      ${lockedProject ? "" : `<button onclick="window.deleteChunk(${chunk.id})" class="dashboard-source-preview-btn" title="Delete chunk"><span class="material-symbols-outlined !text-base text-slate-300 hover:text-red-500">delete</span></button>`}
    </div>
  `).join("");
  applyOfflineIcons(list);
}

async function selectChunk(chunkId) {
  appState.currentChunkId = chunkId;
  populateChunkList();
  const chunk = selectedChunk();
  if (!chunk) return;
  const result = await window.electronAPI.readFile(chunk.path);
  if (!result.success) {
    alert(result.error || "Could not read chunk file.");
    return;
  }
  const titleEl = document.getElementById("current-chunk-title");
  if (titleEl) {
    titleEl.textContent = chunk.title;
    titleEl.parentElement.style.opacity = "1";
    titleEl.contentEditable = isReadOnlyProject() || chunk.synced ? "false" : "true";
  }
  document.getElementById("markdown-content").innerHTML = result.content
    .split("\n\n")
    .map((paragraph) => `<p class="text-lg leading-relaxed ${(isReadOnlyProject() || chunk.synced) ? "text-slate-500" : "text-slate-700"} mb-6" contenteditable="${(isReadOnlyProject() || chunk.synced) ? "false" : "true"}" oninput="window.handleEdit()">${escapeHtml(paragraph)}</p>`)
    .join("");
}

function toggleChunk(chunkId, checked) {
  if (checked) {
    appState.selectedChunkIds.add(chunkId);
  } else {
    appState.selectedChunkIds.delete(chunkId);
  }
  populateChunkList();
}

function toggleAllChunks(checked) {
  appState.selectedChunkIds = checked
    ? new Set(appState.chunks.map((chunk) => chunk.id))
    : new Set();
  populateChunkList();
}

async function deleteChunk(chunkId) {
  if (!confirm("Delete this chunk?")) return;
  appState.chunks = appState.chunks.filter((chunk) => chunk.id !== chunkId);
  appState.selectedChunkIds.delete(chunkId);
  if (appState.currentChunkId === chunkId) {
    appState.currentChunkId = null;
    document.getElementById("markdown-content").innerHTML = "";
  }
  await saveManifest();
  populateChunkList();
}

async function deleteSelected() {
  if (appState.selectedChunkIds.size === 0) return;
  if (!confirm(`Delete ${appState.selectedChunkIds.size} selected chunk(s)?`)) return;
  appState.chunks = appState.chunks.filter((chunk) => !appState.selectedChunkIds.has(chunk.id));
  appState.selectedChunkIds = new Set();
  appState.currentChunkId = null;
  document.getElementById("markdown-content").innerHTML = "";
  await saveManifest();
  populateChunkList();
}

function handleTitleEdit() {
  const chunk = selectedChunk();
  const titleEl = document.getElementById("current-chunk-title");
  if (!chunk || !titleEl || chunk.synced || isReadOnlyProject()) return;
  chunk.title = titleEl.textContent.trim() || chunk.title;
  chunk.synced = false;
  populateChunkList();
  void saveManifest();
}

async function applyBulkTitleTransform(transform, actionLabel) {
  if (isReadOnlyProject()) return;
  const hasSelection = appState.selectedChunkIds.size > 0;
  // Synced chunks are read-only in the single-title edit path (handleTitleEdit),
  // so exclude them from bulk edits too.
  const targets = appState.chunks.filter(
    (chunk) =>
      !chunk.synced && (!hasSelection || appState.selectedChunkIds.has(chunk.id)),
  );
  if (targets.length === 0) {
    alert("No editable chunks to update. Synced chunks cannot be edited.");
    return;
  }
  const scope = hasSelection
    ? `${targets.length} selected chunk(s)`
    : `all ${targets.length} chunk(s)`;
  if (!confirm(`${actionLabel} for ${scope}?`)) return;

  let changed = 0;
  for (const chunk of targets) {
    const nextTitle = transform(chunk.title);
    if (nextTitle && nextTitle !== chunk.title) {
      chunk.title = nextTitle;
      chunk.synced = false;
      changed += 1;
    }
  }
  if (changed === 0) {
    populateChunkList();
    return;
  }
  // Reuse the same persistence path as single-title edits (handleTitleEdit).
  await saveManifest();
  const current = selectedChunk();
  if (current) {
    const titleEl = document.getElementById("current-chunk-title");
    if (titleEl) titleEl.textContent = current.title;
  }
  populateChunkList();
}

function bulkStripNumbering() {
  return applyBulkTitleTransform(
    window.projectUtils.stripLeadingNumbering,
    "Strip leading numbering",
  );
}

function bulkFixCapitalization() {
  return applyBulkTitleTransform(
    window.projectUtils.normalizeTitleCase,
    "Fix capitalization",
  );
}

function handleEdit() {
  const chunk = selectedChunk();
  if (!chunk || chunk.synced || isReadOnlyProject()) return;
  chunk.synced = false;
  populateChunkList();
  if (appState.saveTimeout) {
    clearTimeout(appState.saveTimeout);
  }
  appState.saveTimeout = setTimeout(async () => {
    const content = Array.from(document.querySelectorAll("#markdown-content p"))
      .map((paragraph) => paragraph.textContent)
      .join("\n\n");
    await saveTextFile(chunk.path, content);
    await saveManifest();
  }, 500);
}

async function replaceSelectedPDF() {
  if (isReadOnlyProject()) return;
  const hasExistingWork = hasPreparedChunks() || hasSyncedLineage();
  if (hasExistingWork && !confirm("Replacing the document will invalidate the current chunks and sync state for this draft lineage. Continue?")) {
    return;
  }
  const result = await window.electronAPI.selectPDF();
  if (!result || !result.success) return;
  appState.selectedPDF = result.path;
  appState.activeNotebookId = null;
  appState.activeNotebookTitle = null;
  appState.projectRunState = null;
  appState.chunks = [];
  appState.totalPages = 0;
  appState.currentChunkId = null;
  appState.selectedChunkIds = new Set();
  appState.chunkSearchQuery = "";
  updateSourceUI(result.name);
  await inspectSelectedPdf();
  await saveProjectMetadata();
  prepareSourceView();
  prepareStructureView();
  prepareSourcesView();
  prepareSyncView();
  prepareStudioView();
  updateNavigationLocks();
}

export {
  syncStructureInputs,
  handleStructureSettingChange,
  updateEstimatedChunkCount,
  updateSourceUI,
  resetSourceUI,
  prepareSourcesView,
  prepareSourceView,
  prepareStructureView,
  filteredChunks,
  startNewProject,
  triggerFileSelect,
  inspectSelectedPdf,
  startNewVersion,
  updateSlider,
  forceRefine,
  loadRealChunks,
  populateChunkList,
  selectChunk,
  toggleChunk,
  toggleAllChunks,
  deleteChunk,
  deleteSelected,
  handleTitleEdit,
  bulkStripNumbering,
  bulkFixCapitalization,
  handleEdit,
  replaceSelectedPDF,
};

// app.js (which wires renderer handlers onto `window`) is not modified for these
// bulk-title actions, so register them here where the module is loaded.
if (typeof window !== "undefined") {
  window.bulkStripNumbering = bulkStripNumbering;
  window.bulkFixCapitalization = bulkFixCapitalization;
}
