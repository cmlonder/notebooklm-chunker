const appState = {
  isAuthenticated: false,
  setupStatus: null,
  currentView: "auth",
  userMenuOpen: false,
  isResumeMode: false,
  isRunning: false,
  selectedPDF: null,
  outputDir: null,
  totalPages: 0,
  calculatedTargetPages: 3.0,
  currentChunkId: null,
  activeNotebookId: null,
  activeNotebookTitle: null,
  chunks: [],
  paths: {},
  localProjects: [],
  selectedChunkIds: new Set(),
  saveTimeout: null,
  loginProcessActive: false,
  loginAwaitingEnter: false,
  currentOperation: null,
  projectMetadata: null,
  projectRunState: null,
  chunkSearchQuery: "",
  notebooksCache: null,
  notebooksLoading: false,
  dashboardNotebookId: null,
  dashboardNotebookTitle: null,
  dashboardProjectPath: null,
  dashboardSourceSearchQuery: "",
  dashboardSelectedSourceKey: null,
  dashboardSelectedSourceKeys: new Set(),
  notebookWorkspaceActive: false,
  syncInProgress: false,
  syncProgressEntries: [],
  studioQueue: [],
  studioQueueCounter: 0,
  dashboardNotebookSearchQuery: "",
  notebookWorkspaceTab: "sources",
  promptLibrary: {},
  studioArtifacts: [],
  studioArtifactsLoading: false,
  selectedStudioArtifactIds: new Set(),
  deletingStudioArtifacts: false,
  studioArtifactsTab: "report",
  studioArtifactsSearchQuery: "",
  studioQueueTab: "all",
  studioQueueSearchQuery: "",
  historySearchQuery: "",
  historyStatusFilter: "all",
  promptStudioTab: "report",
  promptSearchQuery: "",
  selectedPromptIds: new Set(),
  promptEditorId: null,
  studioSettings: {},
  studioSettingsEditor: null,
  toastTimer: null,
  notebookWorkspaceNotice: "",
  structureSettingsDirty: false,
};

const studioIconNames = {
  report: "description",
  slide_deck: "slideshow",
  quiz: "quiz",
  flashcards: "style",
  audio: "podcasts",
};

const promptStudioTypes = ["report", "slide_deck", "quiz", "flashcards", "audio"];

const DEFAULT_CHUNK_MIN_PAGES = 2.5;
const DEFAULT_CHUNK_MAX_PAGES = 4.0;
const DEFAULT_CHUNK_TARGET_PAGES = 3.0;

function studioSettingsStorageKey() {
  return "nblm-desktop-studio-settings-v1";
}

function defaultStudioSettings() {
  return {
    report: { language: "en", format: "study-guide" },
    slide_deck: { language: "en", format: "detailed", length: "default", downloadFormat: "pptx" },
    quiz: { quantity: "more", difficulty: "hard", downloadFormat: "json" },
    flashcards: { quantity: "more", difficulty: "hard", downloadFormat: "markdown" },
    audio: { language: "en", format: "deep-dive", length: "long" },
  };
}

function loadStudioSettings() {
  const defaults = defaultStudioSettings();
  try {
    const raw = localStorage.getItem(studioSettingsStorageKey());
    const parsed = raw ? JSON.parse(raw) : {};
    appState.studioSettings = Object.fromEntries(
      Object.entries(defaults).map(([studioName, config]) => [
        studioName,
        {
          ...config,
          ...(parsed?.[studioName] || {}),
          ...(studioName === "slide_deck" && parsed?.[studioName]?.format === "summary"
            ? { format: "presenter" }
            : {}),
          ...(studioName === "slide_deck" && parsed?.[studioName]?.length === "long"
            ? { length: "default" }
            : {}),
        },
      ]),
    );
  } catch (error) {
    appState.studioSettings = defaults;
  }
}

function persistStudioSettings() {
  localStorage.setItem(studioSettingsStorageKey(), JSON.stringify(appState.studioSettings));
}

function promptStorageKey() {
  return "nblm-desktop-prompts-v1";
}

function emptyPromptLibrary() {
  return Object.fromEntries(promptStudioTypes.map((studioName) => [studioName, []]));
}

function loadPromptLibrary() {
  try {
    const raw = localStorage.getItem(promptStorageKey());
    const parsed = raw ? JSON.parse(raw) : {};
    appState.promptLibrary = emptyPromptLibrary();
    for (const studioName of promptStudioTypes) {
      const items = Array.isArray(parsed?.[studioName]) ? parsed[studioName] : [];
      appState.promptLibrary[studioName] = items.filter((item) => item && item.id && item.name);
    }
  } catch (error) {
    appState.promptLibrary = emptyPromptLibrary();
  }
}

function persistPromptLibrary() {
  localStorage.setItem(promptStorageKey(), JSON.stringify(appState.promptLibrary));
}

const DEFAULT_MAX_PARALLEL = { report: 2, slide_deck: 2, quiz: 2, flashcards: 2, audio: 1 };
const DEFAULT_MAX_PARALLEL_CHUNKS = 3;

function nblmSettingsStorageKey() {
  return "nblm-desktop-nblm-settings-v1";
}

function loadNblmSettings() {
  try {
    const raw = localStorage.getItem(nblmSettingsStorageKey());
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    return {};
  }
}

function persistNblmSettings(settings) {
  localStorage.setItem(nblmSettingsStorageKey(), JSON.stringify(settings));
}

function getMaxParallel(studioName) {
  const settings = loadNblmSettings();
  const val = settings?.maxParallel?.[studioName];
  return val != null ? Number(val) : (DEFAULT_MAX_PARALLEL[studioName] || 2);
}

function getMaxParallelChunks() {
  const settings = loadNblmSettings();
  return settings?.maxParallelChunks != null ? Number(settings.maxParallelChunks) : DEFAULT_MAX_PARALLEL_CHUNKS;
}

function chunkOutputRoot() {
  return appState.outputDir ? appState.outputDir.replace(/\/chunks$/, "") : null;
}

function isProjectFullySynced() {
  return appState.chunks.length > 0 && appState.chunks.every((chunk) => chunk.synced === true);
}

function isReadOnlyProject() {
  return appState.isResumeMode && isProjectFullySynced();
}

function selectedChunk() {
  return appState.chunks.find((chunk) => chunk.id === appState.currentChunkId) || null;
}

function hasPreparedChunks() {
  return appState.chunks.length > 0;
}

function hasSyncedLineage() {
  return appState.chunks.some((chunk) => chunk.synced === true) || Boolean(appState.activeNotebookId && appState.projectRunState);
}

function selectedNotebookReady() {
  return Boolean(appState.activeNotebookId || document.getElementById("new-notebook-title")?.value.trim());
}

function desktopAppReady() {
  return Boolean(appState.setupStatus?.readyForApp);
}

function setupNeedsFullscreen() {
  return appState.currentView === "setup" && !appState.isAuthenticated;
}

async function readJson(filePath) {
  const result = await window.electronAPI.readFile(filePath);
  if (!result.success) {
    return null;
  }
  try {
    return JSON.parse(result.content);
  } catch (error) {
    return null;
  }
}

async function saveTextFile(filePath, content) {
  return window.electronAPI.writeFile(filePath, content);
}

async function loadProjectMetadata() {
  if (!appState.outputDir) return null;
  const metadata = await readJson(`${appState.outputDir}/metadata.json`);
  if (metadata) {
    appState.activeNotebookId = metadata.notebook_id || null;
    appState.activeNotebookTitle = metadata.notebook_title || null;
    appState.selectedPDF = metadata.pdf_path || appState.selectedPDF;
  }
  appState.projectMetadata = metadata || null;
  return metadata;
}

async function loadRunState() {
  if (!appState.outputDir) return null;
  const runState = await readJson(`${appState.outputDir}/.nblm-run-state.json`);
  appState.projectRunState = runState || null;
  return runState;
}

async function saveProjectMetadata() {
  if (!appState.outputDir) return;
  const payload = {
    notebook_id: appState.activeNotebookId,
    notebook_title: appState.activeNotebookTitle,
    pdf_path: appState.selectedPDF,
  };
  await saveTextFile(`${appState.outputDir}/metadata.json`, `${JSON.stringify(payload, null, 2)}\n`);
}

async function saveManifest() {
  if (!appState.outputDir) return;
  const payload = appState.chunks
    .filter((chunk) => !chunk.deleted)
    .map((chunk) => ({
      file: chunk.filename,
      primary_heading: chunk.title,
      synced: chunk.synced === true,
      source_id: chunk.source_id || null,
    }));
  await saveTextFile(`${appState.outputDir}/manifest.json`, `${JSON.stringify(payload, null, 2)}\n`);
}

function formatNotebookLabel() {
  return appState.activeNotebookTitle || appState.activeNotebookId || "Not linked";
}

function notebookUrl() {
  if (!appState.activeNotebookId) return null;
  return `https://notebooklm.google.com/notebook/${appState.activeNotebookId}`;
}

function formatPdfLabel() {
  if (!appState.selectedPDF) return "Unknown PDF";
  return appState.selectedPDF.split("/").pop() || appState.selectedPDF;
}

function summarizeStudioOutputs(runState) {
  const items = [];
  if (!runState || typeof runState !== "object") {
    return items;
  }
  const chunks = runState.chunks || {};
  for (const [fileName, chunkEntry] of Object.entries(chunks)) {
    const studios = chunkEntry && typeof chunkEntry === "object" ? chunkEntry.studios || {} : {};
    for (const [studioName, studioState] of Object.entries(studios)) {
      if (!studioState || studioState.status !== "completed") continue;
      items.push({
        scope: "chunk",
        fileName,
        studioName,
        outputPath: studioState.output_path || null,
        remoteTitle: studioState.remote_title || null,
      });
    }
  }
  const notebookStudios = runState.notebook_studios || {};
  for (const [studioName, studioState] of Object.entries(notebookStudios)) {
    if (!studioState || studioState.status !== "completed") continue;
    items.push({
      scope: "notebook",
      fileName: null,
      studioName,
      outputPath: studioState.output_path || null,
      remoteTitle: studioState.remote_title || null,
    });
  }
  return items;
}

function clearLocalSessionState() {
  appState.isAuthenticated = false;
  appState.activeNotebookId = null;
  appState.activeNotebookTitle = null;
  appState.notebooksCache = null;
  appState.notebooksLoading = false;
  appState.dashboardNotebookId = null;
  appState.dashboardNotebookTitle = null;
  appState.dashboardProjectPath = null;
  appState.dashboardSelectedSourceKey = null;
  appState.dashboardSelectedSourceKeys = new Set();
  appState.notebookWorkspaceActive = false;
  appState.studioQueue = [];
  appState.studioArtifacts = [];
  appState.notebookWorkspaceNotice = "";
}

export {
  appState,
  studioIconNames,
  promptStudioTypes,
  DEFAULT_CHUNK_MIN_PAGES,
  DEFAULT_CHUNK_MAX_PAGES,
  DEFAULT_CHUNK_TARGET_PAGES,
  studioSettingsStorageKey,
  defaultStudioSettings,
  loadStudioSettings,
  persistStudioSettings,
  promptStorageKey,
  emptyPromptLibrary,
  loadPromptLibrary,
  persistPromptLibrary,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_MAX_PARALLEL_CHUNKS,
  nblmSettingsStorageKey,
  loadNblmSettings,
  persistNblmSettings,
  getMaxParallel,
  getMaxParallelChunks,
  chunkOutputRoot,
  isProjectFullySynced,
  isReadOnlyProject,
  selectedChunk,
  hasPreparedChunks,
  hasSyncedLineage,
  selectedNotebookReady,
  desktopAppReady,
  setupNeedsFullscreen,
  readJson,
  saveTextFile,
  loadProjectMetadata,
  loadRunState,
  saveProjectMetadata,
  saveManifest,
  formatNotebookLabel,
  notebookUrl,
  formatPdfLabel,
  summarizeStudioOutputs,
  clearLocalSessionState,
};
