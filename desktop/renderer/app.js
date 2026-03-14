const appState = {
  isAuthenticated: false,
  currentView: "auth",
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
    slide_deck: { language: "en", format: "detailed", length: "default", downloadFormat: "pdf" },
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

function studioSettingSummary(studioName) {
  const settings = appState.studioSettings?.[studioName] || defaultStudioSettings()[studioName] || {};
  if (studioName === "report") {
    return `${String(settings.language || "en").toUpperCase()} · ${settings.format || "study-guide"}`;
  }
  if (studioName === "slide_deck") {
    return `${String(settings.language || "en").toUpperCase()} · ${settings.format || "detailed"} · ${settings.length || "default"}`;
  }
  if (studioName === "quiz" || studioName === "flashcards") {
    return `${settings.quantity || "more"} · ${settings.difficulty || "hard"} · ${settings.downloadFormat || (studioName === "quiz" ? "json" : "markdown")}`;
  }
  if (studioName === "audio") {
    return `${String(settings.language || "en").toUpperCase()} · ${settings.format || "deep-dive"} · ${settings.length || "long"}`;
  }
  return "";
}

function updateStudioSettingsSummaries() {
  for (const studioName of promptStudioTypes) {
    const node = document.getElementById(`studio-${studioName}-settings-summary`);
    if (!node) continue;
    node.textContent = studioSettingSummary(studioName);
  }
}

function partitionBounds() {
  const pages = Number(appState.totalPages || 0);
  if (pages <= 0) {
    return {
      minPages: DEFAULT_CHUNK_MIN_PAGES,
      maxPages: DEFAULT_CHUNK_MAX_PAGES,
      targetPages: DEFAULT_CHUNK_TARGET_PAGES,
      minChunks: 1,
      maxChunks: 50,
      recommendedChunks: 1,
    };
  }
  return {
    minPages: DEFAULT_CHUNK_MIN_PAGES,
    maxPages: DEFAULT_CHUNK_MAX_PAGES,
    targetPages: DEFAULT_CHUNK_TARGET_PAGES,
    minChunks: 1,
    maxChunks: Math.max(1, Math.floor(pages)),
    recommendedChunks: Math.max(1, Math.round(pages / DEFAULT_CHUNK_TARGET_PAGES)),
  };
}

function suggestedStructureSettings(targetPages) {
  const target = Math.max(0.1, Number(targetPages || DEFAULT_CHUNK_TARGET_PAGES));
  return {
    minPages: Math.max(0.1, Number((target * 0.8).toFixed(1))),
    maxPages: Math.max(target, Number((target * 1.25).toFixed(1))),
    wordsPerPage: 500,
  };
}

function syncStructureInputs({ force = false } = {}) {
  const targetPages = Number(appState.calculatedTargetPages || DEFAULT_CHUNK_TARGET_PAGES);
  const suggested = suggestedStructureSettings(targetPages);
  const minInput = document.getElementById("min-pages-input");
  const maxInput = document.getElementById("max-pages-input");
  const wordsInput = document.getElementById("words-per-page-input");
  if (!minInput || !maxInput || !wordsInput) return;
  if (force || !appState.structureSettingsDirty) {
    minInput.value = String(suggested.minPages);
    maxInput.value = String(suggested.maxPages);
    wordsInput.value = String(suggested.wordsPerPage);
  }
}

function handleStructureSettingChange() {
  appState.structureSettingsDirty = true;
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

function artifactKindToStudio(kind) {
  const normalized = String(kind || "").toLowerCase();
  if (normalized.includes("slide")) return "slide_deck";
  if (normalized.includes("flash")) return "flashcards";
  if (normalized.includes("audio") || normalized.includes("podcast")) return "audio";
  if (normalized.includes("quiz")) return "quiz";
  if (normalized.includes("report")) return "report";
  return normalized;
}

function normalizedArtifactStatus(status) {
  if (typeof status === "string" && status.trim()) {
    return status.trim().toLowerCase();
  }
  if (typeof status === "number") {
    const mapped = {
      0: "queued",
      1: "processing",
      2: "processing",
      3: "ready",
      4: "failed",
    };
    return mapped[status] || "ready";
  }
  return "ready";
}

function filteredStudioArtifacts() {
  const query = appState.studioArtifactsSearchQuery.trim().toLowerCase();
  return (appState.studioArtifacts || []).filter((item) => {
    if (artifactKindToStudio(item.kind) !== appState.studioArtifactsTab) return false;
    if (!query) return true;
    return String(item.title || "").toLowerCase().includes(query)
      || String(item.kind || "").toLowerCase().includes(query)
      || String(item.status || "").toLowerCase().includes(query);
  });
}

function promptFieldId(studioName) {
  if (studioName === "slide_deck") return "studio-slide-prompt";
  return `studio-${studioName}-prompt`;
}

function promptSelectId(studioName) {
  return `studio-${studioName}-preset`;
}

function refreshPromptDropdowns() {
  for (const studioName of promptStudioTypes) {
    const select = document.getElementById(promptSelectId(studioName));
    if (!select) continue;
    const selectedValue = select.value || "";
    const items = appState.promptLibrary[studioName] || [];
    select.innerHTML = [
      '<option value="">(Optional) Select</option>',
      ...items.map((item) => `<option value="${item.id}">${item.name}</option>`),
      '<option value="__new__">New...</option>',
    ].join("");
    select.value = items.some((item) => item.id === selectedValue) ? selectedValue : "";
    if (selectedValue === "__new__") {
      select.value = "__new__";
    }
    updatePromptInputVisibility(studioName);
  }
}

function updatePromptInputVisibility(studioName) {
  const select = document.getElementById(promptSelectId(studioName));
  const wrap = document.getElementById(`${promptFieldId(studioName)}-wrap`);
  const field = document.getElementById(promptFieldId(studioName));
  if (!wrap || !field || !select) return;
  const isNew = select.value === "__new__";
  wrap.classList.toggle("hidden", !isNew);
  if (!isNew && select.value === "") {
    field.value = "";
  }
}

function promptItemsForActiveTab() {
  const items = appState.promptLibrary[appState.promptStudioTab] || [];
  const query = appState.promptSearchQuery.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) =>
    item.name.toLowerCase().includes(query) || item.prompt.toLowerCase().includes(query),
  );
}

function renderPromptsView() {
  const tabs = document.getElementById("prompt-tab-bar");
  const list = document.getElementById("prompt-list");
  const detail = document.getElementById("prompt-detail");
  const search = document.getElementById("prompt-search");
  const deleteButton = document.getElementById("delete-prompt-selection-btn");
  if (!tabs || !list || !detail || !search || !deleteButton) return;
  search.value = appState.promptSearchQuery;
  tabs.innerHTML = promptStudioTypes.map((studioName) => `
    <button onclick="window.selectPromptStudioTab('${studioName}')" class="${studioName === appState.promptStudioTab ? "workspace-tab workspace-tab-active" : "workspace-tab"}">
      ${studioName.replace(/_/g, " ")}
    </button>
  `).join("");
  const items = promptItemsForActiveTab();
  const availableIds = new Set(items.map((item) => item.id));
  appState.selectedPromptIds = new Set(Array.from(appState.selectedPromptIds).filter((id) => availableIds.has(id)));
  if (appState.promptEditorId !== "__new__" && appState.promptEditorId && !availableIds.has(appState.promptEditorId)) {
    appState.promptEditorId = null;
  }
  if (!appState.promptEditorId && items[0]) {
    appState.promptEditorId = items[0].id;
  }
  list.innerHTML = items.length === 0
    ? '<div class="p-8 mt-4 rounded-2xl border border-slate-100 bg-slate-50 text-slate-400 italic">No prompts found for this Studio type.</div>'
    : items.map((item) => `
      <div class="dashboard-source-row ${item.id === appState.promptEditorId ? "is-active" : ""}">
        <input type="checkbox" ${appState.selectedPromptIds.has(item.id) ? "checked" : ""} onchange="window.togglePromptSelection('${item.id}')" class="prompt-checkbox" />
        <button onclick="window.selectPromptItem('${item.id}')" class="dashboard-source-main">
          <div class="dashboard-source-copy">
            <p class="text-sm font-bold text-slate-900 truncate">${item.name}</p>
            <p class="text-xs text-slate-400 truncate mt-1">${item.prompt.length} characters</p>
          </div>
        </button>
      </div>
    `).join("");
  deleteButton.disabled = appState.selectedPromptIds.size === 0;
  const current = (appState.promptLibrary[appState.promptStudioTab] || []).find((item) => item.id === appState.promptEditorId);
  detail.innerHTML = `
    <div class="space-y-4">
      ${current ? `
        <div class="space-y-3">
          <div>
            <h3 class="font-bold text-slate-900">${current.name}</h3>
            <p class="text-sm text-slate-500 mt-1 capitalize">${appState.promptStudioTab.replace(/_/g, " ")} prompt</p>
          </div>
          <div class="p-4 rounded-2xl border border-slate-100 bg-slate-50">
            <p class="text-sm text-slate-600 whitespace-pre-wrap">${current.prompt}</p>
          </div>
          <div class="flex items-center gap-3">
            <button onclick="window.openPromptEditor('${current.id}')" class="secondary-action-btn">Edit prompt</button>
          </div>
        </div>
      ` : `
        <div class="p-6 rounded-2xl border border-slate-100 bg-slate-50 text-slate-400 italic">
          Choose a prompt from the left to inspect it, or create a new one from the top bar.
        </div>
      `}
    </div>
  `;
  applyOfflineIcons(list);
  refreshPromptDropdowns();
}

function savePromptPreset() {
  const nameInput = document.getElementById("prompt-modal-name");
  const bodyInput = document.getElementById("prompt-modal-body");
  const name = nameInput?.value.trim();
  const prompt = bodyInput?.value.trim();
  if (!name || !prompt) {
    alert("Prompt name and body are required.");
    return;
  }
  const items = appState.promptLibrary[appState.promptStudioTab] || [];
  if (appState.promptEditorId && appState.promptEditorId !== "__new__") {
    const existing = items.find((item) => item.id === appState.promptEditorId);
    if (existing) {
      existing.name = name;
      existing.prompt = prompt;
    }
  } else {
    const newId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    items.unshift({ id: newId, name, prompt });
    appState.promptLibrary[appState.promptStudioTab] = items;
    appState.promptEditorId = newId;
  }
  persistPromptLibrary();
  closePromptEditor();
  renderPromptsView();
  showToast(`${name} saved.`);
}

function deletePromptPreset(studioName, promptId) {
  appState.promptLibrary[studioName] = (appState.promptLibrary[studioName] || []).filter((item) => item.id !== promptId);
  persistPromptLibrary();
  renderPromptsView();
  showToast("Prompt removed.");
}

function selectPromptStudioTab(studioName) {
  appState.promptStudioTab = studioName;
  appState.promptSearchQuery = "";
  appState.selectedPromptIds = new Set();
  appState.promptEditorId = null;
  renderPromptsView();
}

function handlePromptSearch(value) {
  appState.promptSearchQuery = String(value || "");
  renderPromptsView();
}

function startPromptDraft() {
  appState.promptEditorId = "__new__";
  openPromptEditor("__new__");
}

function selectPromptItem(promptId) {
  appState.promptEditorId = promptId;
  renderPromptsView();
}

function togglePromptSelection(promptId) {
  if (appState.selectedPromptIds.has(promptId)) {
    appState.selectedPromptIds.delete(promptId);
  } else {
    appState.selectedPromptIds.add(promptId);
  }
  renderPromptsView();
}

function deleteSelectedPrompts() {
  if (appState.selectedPromptIds.size === 0) return;
  appState.promptLibrary[appState.promptStudioTab] = (appState.promptLibrary[appState.promptStudioTab] || []).filter(
    (item) => !appState.selectedPromptIds.has(item.id),
  );
  appState.selectedPromptIds = new Set();
  appState.promptEditorId = null;
  persistPromptLibrary();
  renderPromptsView();
  refreshPromptDropdowns();
  showToast("Selected prompts removed.");
}

function openPromptEditor(promptId) {
  appState.promptEditorId = promptId || "__new__";
  const modal = document.getElementById("prompt-modal");
  const title = document.getElementById("prompt-modal-title");
  const meta = document.getElementById("prompt-modal-meta");
  const name = document.getElementById("prompt-modal-name");
  const body = document.getElementById("prompt-modal-body");
  if (!modal || !title || !meta || !name || !body) return;
  const current = (appState.promptLibrary[appState.promptStudioTab] || []).find((item) => item.id === appState.promptEditorId);
  title.textContent = current ? "Edit prompt" : "New prompt";
  meta.textContent = `${appState.promptStudioTab.replace(/_/g, " ")} prompt`;
  name.value = current?.name || "";
  body.value = current?.prompt || "";
  modal.classList.remove("hidden");
}

function closePromptEditor() {
  const modal = document.getElementById("prompt-modal");
  if (modal) modal.classList.add("hidden");
}

function studioSettingsField(field, label, options, value) {
  const opts = options.map((option) => `<option value="${option.value}" ${option.value === value ? "selected" : ""}>${option.label}</option>`).join("");
  return `
    <label class="space-y-2 block">
      <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">${label}</span>
      <select data-studio-setting="${field}" class="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/20 transition-all">
        ${opts}
      </select>
    </label>
  `;
}

function openStudioSettings(studioName) {
  appState.studioSettingsEditor = studioName;
  const modal = document.getElementById("studio-settings-modal");
  const title = document.getElementById("studio-settings-title");
  const meta = document.getElementById("studio-settings-meta");
  const body = document.getElementById("studio-settings-body");
  if (!modal || !title || !meta || !body) return;
  const settings = appState.studioSettings?.[studioName] || defaultStudioSettings()[studioName] || {};
  title.textContent = `${studioName.replace(/_/g, " ")} settings`;
  meta.textContent = "These defaults will be reused for future queue items.";
  const sections = [];
  if (studioName === "report") {
    sections.push(studioSettingsField("language", "Language", [
      { value: "en", label: "English" },
      { value: "tr", label: "Turkish" },
    ], settings.language));
    sections.push(studioSettingsField("format", "Format", [
      { value: "study-guide", label: "Study Guide" },
      { value: "briefing-doc", label: "Briefing Doc" },
      { value: "timeline", label: "Timeline" },
      { value: "faq", label: "FAQ" },
      { value: "custom", label: "Custom" },
    ], settings.format));
  } else if (studioName === "slide_deck") {
    sections.push(studioSettingsField("language", "Language", [
      { value: "en", label: "English" },
      { value: "tr", label: "Turkish" },
    ], settings.language));
    sections.push(studioSettingsField("format", "Format", [
      { value: "detailed", label: "Detailed" },
      { value: "presenter", label: "Presenter" },
    ], settings.format));
    sections.push(studioSettingsField("length", "Length", [
      { value: "short", label: "Short" },
      { value: "default", label: "Default" },
      { value: "long", label: "Long" },
    ], settings.length));
    sections.push(studioSettingsField("downloadFormat", "Download format", [
      { value: "pdf", label: "PDF" },
      { value: "pptx", label: "PPTX" },
    ], settings.downloadFormat));
  } else if (studioName === "quiz" || studioName === "flashcards") {
    sections.push(studioSettingsField("quantity", "Quantity", [
      { value: "fewer", label: "Fewer" },
      { value: "default", label: "Default" },
      { value: "more", label: "More" },
    ], settings.quantity));
    sections.push(studioSettingsField("difficulty", "Difficulty", [
      { value: "easier", label: "Easier" },
      { value: "default", label: "Default" },
      { value: "hard", label: "Hard" },
    ], settings.difficulty));
    sections.push(studioSettingsField("downloadFormat", "Download format", studioName === "quiz" ? [
      { value: "json", label: "JSON" },
      { value: "markdown", label: "Markdown" },
    ] : [
      { value: "markdown", label: "Markdown" },
      { value: "json", label: "JSON" },
    ], settings.downloadFormat));
  } else if (studioName === "audio") {
    sections.push(studioSettingsField("language", "Language", [
      { value: "en", label: "English" },
      { value: "tr", label: "Turkish" },
    ], settings.language));
    sections.push(studioSettingsField("format", "Format", [
      { value: "deep-dive", label: "Deep Dive" },
      { value: "conversational", label: "Conversational" },
    ], settings.format));
    sections.push(studioSettingsField("length", "Length", [
      { value: "short", label: "Short" },
      { value: "default", label: "Default" },
      { value: "long", label: "Long" },
    ], settings.length));
  }
  body.innerHTML = `<div class="space-y-4">${sections.join("")}</div>`;
  modal.classList.remove("hidden");
}

function closeStudioSettings() {
  const modal = document.getElementById("studio-settings-modal");
  if (modal) modal.classList.add("hidden");
  appState.studioSettingsEditor = null;
}

function saveStudioSettings() {
  const studioName = appState.studioSettingsEditor;
  if (!studioName) return;
  const modal = document.getElementById("studio-settings-modal");
  if (!modal) return;
  const next = { ...(appState.studioSettings?.[studioName] || defaultStudioSettings()[studioName] || {}) };
  modal.querySelectorAll("[data-studio-setting]").forEach((node) => {
    next[node.getAttribute("data-studio-setting")] = node.value;
  });
  appState.studioSettings = {
    ...(appState.studioSettings || {}),
    [studioName]: next,
  };
  persistStudioSettings();
  closeStudioSettings();
  renderNotebookDashboardDetail();
  showToast(`${studioName.replace(/_/g, " ")} settings saved.`);
}

function applyPromptPreset(studioName, promptId) {
  const field = document.getElementById(promptFieldId(studioName));
  const select = document.getElementById(promptSelectId(studioName));
  if (!field || !select) return;
  if (!promptId) {
    field.value = "";
    updatePromptInputVisibility(studioName);
    return;
  }
  if (promptId === "__new__") {
    updatePromptInputVisibility(studioName);
    return;
  }
  const item = (appState.promptLibrary[studioName] || []).find((entry) => entry.id === promptId);
  if (!item) return;
  field.value = item.prompt;
  updatePromptInputVisibility(studioName);
  showToast(`${item.name} loaded.`);
}

function progressLog(message) {
  const logEl = document.getElementById("loading-log");
  if (!logEl) return;
  logEl.textContent = String(message || "")
    .replace(/^\d{2}:\d{2}:\d{2}\s+\[nblm\]\s+/, "")
    .split("\n")
    .pop();
}

function setNotebookDashboardLoading(isLoading) {
  const loading = document.getElementById("notebook-dashboard-loading");
  const list = document.getElementById("remote-notebook-list");
  const refreshButton = document.querySelector('#notebooks-view button[onclick="window.refreshNotebookDashboard()"]');
  if (loading) loading.classList.toggle("hidden", !isLoading);
  if (list) list.classList.toggle("hidden", isLoading);
  if (refreshButton) refreshButton.disabled = isLoading;
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

function doctorShowsReadyAuth(output) {
  return /OK\s+auth\s+/i.test(String(output || ""));
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
  return window.electronAPI.runNBLM({
    command: "internal-write-file",
    args: [filePath, content],
  });
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

function navigationGuard(targetView) {
  if (targetView === "auth" || targetView === "history" || targetView === "notebooks" || targetView === "prompts" || targetView === "source") {
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
  if (sidebar) sidebar.style.display = appState.isAuthenticated ? "flex" : "none";
  if (header) {
    header.style.display = ["source", "structure", "sources", "sync"].includes(targetView)
      ? "flex"
      : "none";
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

  appState.currentView = targetView;
  updateNavigationLocks();
}

function switchView(viewName) {
  if (!appState.isAuthenticated && viewName !== "auth") {
    return;
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

function prepareSourcesView() {
  const readOnly = isReadOnlyProject();
  const selectRow = document.getElementById("catalog-select-row");
  const continueButton = document.getElementById("continue-sync-btn");
  const readOnlyBanner = document.getElementById("sources-readonly-banner");
  const emptyHint = document.getElementById("sources-empty-hint");
  if (selectRow) selectRow.style.display = readOnly ? "none" : "flex";
  if (continueButton) continueButton.style.display = readOnly ? "none" : "block";
  if (readOnlyBanner) readOnlyBanner.style.display = readOnly ? "block" : "none";
  if (emptyHint) emptyHint.style.display = readOnly ? "none" : "inline";
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
  const slider = document.getElementById("target-count-slider");
  const banner = document.getElementById("structure-readonly-banner");
  const summary = document.getElementById("structure-readonly-summary");
  const rangeNote = document.getElementById("partition-range-note");
  const bounds = partitionBounds();
  if (slider) {
    slider.min = String(bounds.minChunks);
    slider.max = String(bounds.maxChunks);
    const currentValue = Number(slider.value || bounds.recommendedChunks);
    slider.value = String(Math.min(bounds.maxChunks, Math.max(bounds.minChunks, currentValue || bounds.recommendedChunks)));
    slider.disabled = readOnly;
  }
  if (processButton) processButton.style.display = readOnly ? "none" : "block";
  if (banner) banner.style.display = readOnly ? "block" : "none";
  if (summary && readOnly) {
    summary.textContent = `${appState.totalPages || "Unknown"} pages were partitioned into ${appState.chunks.length} chunk(s) for this synced version.`;
  }
  if (rangeNote) {
    rangeNote.textContent = `Pick any target from 1 to ${bounds.maxChunks}. The chunker still prefers heading boundaries, so it will try to honor your target while keeping section breaks sensible.`;
  }
  if (!readOnly) {
    updateSlider(slider?.value || bounds.recommendedChunks);
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

async function fetchLocalProjects() {
  const listEl = document.getElementById("project-history-list");
  if (!listEl) return;
  const projects = await window.electronAPI.listProjects(appState.paths.projects);
  appState.localProjects = [];

  for (const project of projects) {
    const manifest = await readJson(`${project.path}/manifest.json`);
    const metadata = await readJson(`${project.path}/metadata.json`);
    const runState = await readJson(`${project.path}/.nblm-run-state.json`);
    const queueStateResult = await window.electronAPI.getStudioQueue(project.path);
    const status = window.projectUtils.deriveProjectStatus({
      manifestEntries: manifest,
      metadata,
      runState,
    });
    appState.localProjects.push({
      ...project,
      manifestEntries: manifest || [],
      metadata: metadata || {},
      runState: runState || {},
      queueState: queueStateResult.success ? queueStateResult.queue : { jobs: [] },
      status,
    });
  }

  if (appState.localProjects.length === 0) {
    listEl.innerHTML = '<div class="px-6 py-10 text-sm text-slate-400 italic">No local projects yet.</div>';
    return;
  }

  listEl.innerHTML = appState.localProjects.map((project) => {
    const modified = new Date(project.modified).toLocaleString();
    const notebookLabel = project.metadata?.notebook_title || "Not linked";
    return `
      <div class="grid grid-cols-12 gap-4 px-6 py-5 hover:bg-slate-50/60 items-center">
        <div class="col-span-5 min-w-0">
          <button onclick="window.resumeExistingPath('${project.path}')" class="font-bold text-slate-900 truncate text-left hover:text-primary">
            ${project.rawName}
          </button>
          <p class="text-xs text-slate-400 truncate mt-1">${project.path}</p>
        </div>
        <div class="col-span-3">
          <span class="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold ${
            project.status.tone === "green"
              ? "bg-green-50 text-green-700"
              : project.status.tone === "amber"
              ? "bg-amber-50 text-amber-700"
              : project.status.tone === "blue"
              ? "bg-blue-50 text-blue-700"
              : "bg-slate-100 text-slate-600"
          }">
            ${project.status.label}
          </span>
          <p class="text-xs text-slate-400 mt-1">${project.status.detail}</p>
        </div>
        <div class="col-span-2 text-center text-sm text-slate-500">${modified}</div>
        <div class="col-span-2 flex items-center justify-end gap-3">
          <span class="text-xs text-slate-400 truncate max-w-[150px]">${notebookLabel}</span>
          <button onclick="window.deleteProject('${project.path}')" class="p-2 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50">
            <span class="material-symbols-outlined !text-lg">delete</span>
          </button>
        </div>
      </div>
    `;
  }).join("");
  applyOfflineIcons(listEl);
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
      <button onclick='window.selectDashboardNotebook(${JSON.stringify(notebook.id)}, ${JSON.stringify(notebook.title || notebook.id)})' class="notebook-overview-card">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="font-bold text-slate-900 truncate">${notebook.title || notebook.id}</p>
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
    <button onclick='window.selectDashboardLineage(${JSON.stringify(project.path)})' class="px-3 py-2 rounded-xl border text-sm font-bold ${project.path === appState.dashboardProjectPath ? "border-primary/20 bg-primary/5 text-primary" : ((project.queueState?.jobs || []).some((job) => job.status === "queued" || job.status === "running") ? "border-amber-200 bg-amber-50 text-amber-700" : "border-slate-200 text-slate-600 hover:bg-slate-50")}">
      ${project.rawName}
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
      <button onclick='window.toggleDashboardSourceSelection(${JSON.stringify(item.key)})' class="dashboard-source-select ${appState.dashboardSelectedSourceKeys.has(item.key) ? "is-selected" : ""}" title="${appState.dashboardSelectedSourceKeys.has(item.key) ? "Deselect source" : "Select source"}" aria-label="${appState.dashboardSelectedSourceKeys.has(item.key) ? "Deselect source" : "Select source"}">
        <span class="material-symbols-outlined !text-sm">${appState.dashboardSelectedSourceKeys.has(item.key) ? "check_circle" : "add_circle"}</span>
      </button>
      <button onclick='window.selectDashboardSource(${JSON.stringify(item.key)})' class="dashboard-source-main">
        <div class="dashboard-source-copy">
          <p class="text-sm font-bold text-slate-900 truncate">${item.title}</p>
          <p class="text-xs text-slate-400 truncate mt-1">${item.filename}</p>
        </div>
        <span class="inline-flex items-center px-2 py-1 rounded-full bg-green-50 text-green-700 text-[10px] font-bold uppercase tracking-widest">synced</span>
      </button>
      <button onclick='window.openDashboardPreview(${JSON.stringify(item.key)})' class="dashboard-source-preview-btn" title="Open preview" aria-label="Open preview">
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

function handleNotebookSourceSearch(value) {
  appState.dashboardSourceSearchQuery = String(value || "");
  renderDashboardSources();
}

function handleNotebookSearch(value) {
  appState.dashboardNotebookSearchQuery = String(value || "");
  renderRemoteNotebookList();
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

async function logout() {
  showLoading("Signing out...");
  try {
    const result = await window.electronAPI.runNBLM({ command: "logout", args: [] });
    if (!result.success) {
      throw new Error(result.error || result.output || "NotebookLM logout failed.");
    }
    clearLocalSessionState();
    switchView("auth");
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
    switchView("auth");
    hideLoading();
    await login();
  } catch (error) {
    hideLoading();
    alert(error.message);
  }
}

async function loadStudioArtifacts(force = false) {
  if (!appState.dashboardNotebookId) {
    appState.studioArtifacts = [];
    return;
  }
  if (appState.studioArtifactsLoading) return;
  if (!force && Array.isArray(appState.studioArtifacts) && appState.studioArtifacts.length > 0) return;
  appState.studioArtifactsLoading = true;
  try {
    const result = await window.electronAPI.runNBLM({
      command: "list-artifacts",
      args: ["--notebook-id", appState.dashboardNotebookId],
    });
    if (result.success) {
      appState.studioArtifacts = JSON.parse(result.output || "[]");
    }
  } catch (error) {
    appState.studioArtifacts = [];
  } finally {
    appState.studioArtifactsLoading = false;
    if (appState.notebookWorkspaceTab === "studios") {
      prepareStudioView();
    }
  }
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
      .map((paragraph) => `<p>${paragraph}</p>`)
      .join("")
    : "<p>Could not load local source preview.</p>";
  modal.classList.remove("hidden");
}

function closeDashboardPreview() {
  const modal = document.getElementById("preview-modal");
  if (modal) modal.classList.add("hidden");
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
  updateSlider(partitionBounds().recommendedChunks);
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

function updateSlider(value) {
  const slider = document.getElementById("target-count-slider");
  const bounds = partitionBounds();
  const min = bounds.minChunks;
  const max = bounds.maxChunks;
  const targetCount = Math.min(max, Math.max(min, Number(value || bounds.recommendedChunks)));
  if (slider) slider.value = String(targetCount);
  document.getElementById("target-count-display").textContent = String(targetCount);
  const denominator = Math.max(1, max - min);
  const percent = ((targetCount - min) / denominator) * 100;
  document.getElementById("slider-track").style.width = `${Math.max(0, Math.min(100, percent)).toFixed(2)}%`;
  if (appState.totalPages > 0) {
    appState.calculatedTargetPages = (appState.totalPages / targetCount).toFixed(2);
    document.getElementById("calc-pages-display").textContent = appState.calculatedTargetPages;
  }
  syncStructureInputs();
}

async function forceRefine() {
  if (!appState.selectedPDF || !appState.outputDir) return;
  showLoading("Preparing chunks...");
  try {
    const chunkCount = Number(document.getElementById("target-count-slider")?.value || 5);
    const targetPages = Number((appState.totalPages / chunkCount).toFixed(2));
    const minPages = Number(document.getElementById("min-pages-input")?.value || 0);
    const maxPages = Number(document.getElementById("max-pages-input")?.value || 0);
    const wordsPerPage = Number(document.getElementById("words-per-page-input")?.value || 500);
    if (!(minPages > 0) || !(maxPages > 0) || minPages > maxPages) {
      throw new Error("Min/Max page settings are invalid. Make sure both are positive and min is not greater than max.");
    }
    if (!(wordsPerPage > 0)) {
      throw new Error("Words per page must be greater than 0.");
    }
    const result = await window.electronAPI.runNBLM({
      command: "prepare",
      args: [
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
        "--words-per-page",
        String(wordsPerPage),
      ],
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
    <div class="group p-3 rounded-lg border flex items-center gap-3 source-list-card ${chunk.id === appState.currentChunkId ? "border-primary/20 shadow-sm is-active" : "border-slate-100 hover:border-slate-200"}">
      ${lockedProject ? "" : `<input type="checkbox" ${appState.selectedChunkIds.has(chunk.id) ? "checked" : ""} onchange="window.toggleChunk(${chunk.id}, this.checked)" class="rounded text-primary size-4 cursor-pointer" />`}
      <button onclick="window.selectChunk(${chunk.id})" class="flex-1 min-w-0 text-left">
        <div class="flex items-center justify-between gap-2">
          <h4 class="text-xs font-bold truncate ${chunk.id === appState.currentChunkId ? "text-primary" : "text-slate-700"}">${chunk.filename}</h4>
          <span class="size-1.5 rounded-full ${chunk.synced ? "bg-green-500" : "bg-blue-500"} shrink-0"></span>
        </div>
        <p class="text-xs text-slate-400 truncate mt-1">${chunk.title}</p>
      </button>
      ${lockedProject ? "" : `<button onclick="window.deleteChunk(${chunk.id})" class="opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-red-500 transition-all shrink-0"><span class="material-symbols-outlined !text-sm">delete</span></button>`}
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
    .map((paragraph) => `<p class="text-lg leading-relaxed ${(isReadOnlyProject() || chunk.synced) ? "text-slate-500" : "text-slate-700"} mb-6" contenteditable="${(isReadOnlyProject() || chunk.synced) ? "false" : "true"}" oninput="window.handleEdit()">${paragraph}</p>`)
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

function renderNotebookOptions(notebooks) {
  const select = document.getElementById("notebook-select");
  if (!select) return;
  let options = '<option value="" disabled selected>Select a notebook...</option><option value="new">+ Create New Notebook</option>';
  notebooks.forEach((notebook) => {
    options += `<option value="${notebook.id}" ${notebook.id === appState.activeNotebookId ? "selected" : ""}>${notebook.title || notebook.id}</option>`;
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
            <p class="text-sm font-medium text-slate-900 truncate">${chunk.title}</p>
            <p class="text-xs text-slate-400 truncate mt-1">${chunk.filename}</p>
            ${progress ? `<div class="queue-progress"><div class="${tone}" style="width: ${width}%"></div></div><p class="text-[11px] text-slate-400 mt-2">${progress.message}</p>` : ""}
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
      ? `<a href="#" onclick="window.electronAPI.openExternal('https://notebooklm.google.com/notebook/${appState.activeNotebookId}'); return false;" class="underline font-bold">${appState.activeNotebookTitle || appState.activeNotebookId}</a>`
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
      "3",
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
      maxParallel: 2,
    },
    slide_deck: {
      enabled: true,
      outputDir: `${base}/slides`,
      prompt: document.getElementById("studio-slide-prompt")?.value.trim(),
      language: settings.slide_deck.language,
      format: settings.slide_deck.format,
      length: settings.slide_deck.length,
      downloadFormat: settings.slide_deck.downloadFormat,
      maxParallel: 2,
    },
    quiz: {
      enabled: true,
      outputDir: `${base}/quizzes`,
      prompt: document.getElementById("studio-quiz-prompt")?.value.trim(),
      quantity: settings.quiz.quantity,
      difficulty: settings.quiz.difficulty,
      downloadFormat: settings.quiz.downloadFormat,
      maxParallel: 2,
    },
    flashcards: {
      enabled: true,
      outputDir: `${base}/flashcards`,
      prompt: document.getElementById("studio-flashcards-prompt")?.value.trim(),
      quantity: settings.flashcards.quantity,
      difficulty: settings.flashcards.difficulty,
      downloadFormat: settings.flashcards.downloadFormat,
      maxParallel: 2,
    },
    audio: {
      enabled: true,
      outputDir: `${base}/audio`,
      prompt: document.getElementById("studio-audio-prompt")?.value.trim(),
      language: settings.audio.language,
      format: settings.audio.format,
      length: settings.audio.length,
      maxParallel: 1,
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

function renderStudioQueue(activeProject) {
  const queueList = document.getElementById("studio-queue-list");
  if (!queueList) return;
  const backgroundJobs = activeProject?.queueState?.jobs || [];
  if (appState.studioQueue.length === 0 && backgroundJobs.length === 0) {
    queueList.innerHTML = '<div class="p-4 rounded-2xl border border-slate-100 bg-slate-50 text-slate-400 italic">No queued Studio batches yet.</div>';
    return;
  }
  const stagedRows = appState.studioQueue.map((item, index) => `
    <div class="queue-row">
      <div class="min-w-0 flex items-start gap-3">
        <span class="material-symbols-outlined text-primary !text-lg">${studioIconNames[item.studioName] || "description"}</span>
        <div class="min-w-0">
          <p class="font-bold text-slate-900 capitalize">${item.displayLabel || item.label}</p>
          <p class="text-xs text-slate-400 truncate">${item.sourceSummary} · ${item.localRunName}</p>
          <div class="queue-progress"><div class="queue-progress-bar" style="width: 8%"></div></div>
          <p class="text-[11px] text-slate-400 mt-2">Ready to enqueue</p>
        </div>
      </div>
      <button onclick="window.removeStudioQueueItem(${index})" class="p-2 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50">
        <span class="material-symbols-outlined !text-sm">delete</span>
      </button>
    </div>
  `).join("");
  const backgroundRows = backgroundJobs.map((job) => {
    const tone = job.status === "failed"
      ? "queue-progress-bar is-failed"
      : job.status === "submitted"
      ? "queue-progress-bar is-complete"
      : job.status === "running"
      ? "queue-progress-bar is-running"
      : "queue-progress-bar";
    const logPreview = Array.isArray(job.logs) && job.logs.length > 0
      ? `
        <div class="queue-log-preview">
          ${job.logs.slice(-3).map((entry) => `<p>[${entry.channel}] ${entry.line}</p>`).join("")}
        </div>
      `
      : "";
    return `
      <div class="queue-row">
        <div class="min-w-0 flex items-start gap-3">
          <span class="material-symbols-outlined text-primary !text-lg">${studioIconNames[job.studioName] || "description"}</span>
          <div class="min-w-0">
            <p class="font-bold text-slate-900 capitalize">${job.displayLabel || job.label}</p>
            <p class="text-xs text-slate-400 truncate">${job.sourceSummary} · ${job.localRunName}</p>
            <div class="queue-progress"><div class="${tone}" style="width: ${Number(job.progress || 0)}%"></div></div>
            <p class="text-[11px] text-slate-400 mt-2">${job.message || job.status}</p>
            ${logPreview}
          </div>
        </div>
        <span class="inline-flex items-center px-3 py-1 rounded-full ${job.status === "failed" ? "bg-red-50 text-red-500" : job.status === "submitted" ? "bg-green-50 text-green-700" : job.status === "running" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700"} text-xs font-bold uppercase">${job.status}</span>
      </div>
    `;
  }).join("");
  queueList.innerHTML = `${stagedRows}${backgroundRows}`;
  applyOfflineIcons(queueList);
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
      studioTabBar.innerHTML = promptStudioTypes.map((studioName) => `
        <button onclick="window.selectStudioArtifactsTab('${studioName}')" class="${studioName === appState.studioArtifactsTab ? "workspace-tab workspace-tab-active" : "workspace-tab"}">
          ${studioName.replace(/_/g, " ")}
        </button>
      `).join("");
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
          <input type="checkbox" ${appState.selectedStudioArtifactIds.has(item.id) ? "checked" : ""} onchange="window.toggleStudioArtifactSelection('${item.id}')" class="prompt-checkbox" />
          <span class="material-symbols-outlined text-primary !text-lg">${studioIconNames[appState.studioArtifactsTab] || "description"}</span>
          <div class="min-w-0">
            <p class="font-bold text-slate-900">${item.title || "Untitled artifact"}</p>
            <p class="text-xs text-slate-400 truncate">${item.kind || "artifact"}${statusLabel ? ` · ${statusLabel}` : ""}</p>
          </div>
        </div>
        <span class="inline-flex items-center px-3 py-1 rounded-full ${statusLabel.includes("fail") ? "bg-red-50 text-red-500" : statusLabel.includes("process") || statusLabel.includes("queue") ? "bg-blue-50 text-blue-700" : "bg-green-50 text-green-700"} text-xs font-bold uppercase">${statusLabel}</span>
      </div>
    `;
    }).join("");
    applyOfflineIcons(document.getElementById("dashboard-studios-panel") || generatedList);
  }
}

function selectStudioArtifactsTab(studioName) {
  appState.studioArtifactsTab = studioName;
  appState.selectedStudioArtifactIds = new Set();
  prepareStudioView();
}

function handleStudioArtifactsSearch(value) {
  appState.studioArtifactsSearchQuery = String(value || "");
  prepareStudioView();
}

function toggleStudioArtifactSelection(artifactId) {
  if (appState.deletingStudioArtifacts) return;
  if (appState.selectedStudioArtifactIds.has(artifactId)) {
    appState.selectedStudioArtifactIds.delete(artifactId);
  } else {
    appState.selectedStudioArtifactIds.add(artifactId);
  }
  prepareStudioView();
}

async function deleteSelectedStudioArtifacts() {
  if (!appState.dashboardNotebookId || appState.selectedStudioArtifactIds.size === 0 || appState.deletingStudioArtifacts) return;
  appState.deletingStudioArtifacts = true;
  prepareStudioView();
  try {
    const result = await window.electronAPI.runNBLM({
      command: "delete-artifacts",
      args: [
        "--notebook-id",
        appState.dashboardNotebookId,
        ...Array.from(appState.selectedStudioArtifactIds).flatMap((artifactId) => ["--artifact-id", artifactId]),
      ],
    });
    if (!result.success) {
      throw new Error(result.error || result.output || "Could not delete selected Studio items.");
    }
    appState.selectedStudioArtifactIds = new Set();
    await loadStudioArtifacts(true);
    showToast("Selected Studio items deleted.");
  } catch (error) {
    alert(error.message);
  } finally {
    appState.deletingStudioArtifacts = false;
    prepareStudioView();
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
        maxParallelChunks: 3,
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

async function resumeExistingPath(projectPath) {
  appState.outputDir = projectPath;
  appState.isResumeMode = true;
  appState.selectedChunkIds = new Set();
  appState.chunkSearchQuery = "";
  await loadProjectMetadata();
  if (appState.selectedPDF) {
    try {
      await inspectSelectedPdf();
    } catch (error) {
      // Keep loading the lineage even if the original PDF path no longer exists.
    }
  }
  const loaded = await loadRealChunks();
  if (!loaded) {
    appState.chunks = [];
    appState.projectRunState = null;
  }
  switchView("source");
}

async function deleteProject(projectPath) {
  if (!confirm("Delete this local project version?")) return;
  const result = await window.electronAPI.deleteProject(projectPath);
  if (!result.success) {
    alert(result.error || "Could not delete project.");
    return;
  }
  await fetchLocalProjects();
}

async function refreshNotebookDashboard() {
  await prepareNotebooksView({ force: true });
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

async function init() {
  appState.loginProcessActive = false;
  appState.loginAwaitingEnter = false;
  loadPromptLibrary();
  loadStudioSettings();
  applyOfflineIcons();
  hideLoading();
  appState.paths = await window.electronAPI.getAppPaths();
  try {
    const result = await window.electronAPI.runNBLM({ command: "doctor", args: [] });
    appState.isAuthenticated = doctorShowsReadyAuth(result.output);
  } catch (error) {
    appState.isAuthenticated = false;
  }
  switchView(appState.isAuthenticated ? "history" : "auth");
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
  updateLoginPromptUI();
  hideLoading();
  updateNavigationLocks();
  refreshPromptDropdowns();
}

function handleChunkSearch(value) {
  appState.chunkSearchQuery = String(value || "");
  populateChunkList();
}

Object.assign(window, {
  login,
  confirmLogin,
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
  updateSlider,
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
});

init();
