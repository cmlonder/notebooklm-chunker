import {
  appState,
  promptStudioTypes,
  defaultStudioSettings,
  persistStudioSettings,
  loadNblmSettings,
  persistNblmSettings,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_MAX_PARALLEL_CHUNKS,
} from "./state.js";
import { renderTabBar, showToast } from "./dom.js";
import { switchView, closeUserMenu } from "./navigation.js";
import { renderNotebookDashboardDetail } from "./dashboard.js";

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
  const sections = nblmSourceSettingsFields(studioName, settings);
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

const NBLM_SETTINGS_TABS = ["sources", "sync"];

const NBLM_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh_Hans", label: "中文（简体）" },
  { value: "zh_Hant", label: "中文（繁體）" },
  { value: "es", label: "Español" },
  { value: "es_419", label: "Español (Latinoamérica)" },
  { value: "es_MX", label: "Español (México)" },
  { value: "hi", label: "हिन्दी" },
  { value: "ar_001", label: "العربية" },
  { value: "ar_eg", label: "العربية (مصر)" },
  { value: "pt_BR", label: "Português (Brasil)" },
  { value: "pt_PT", label: "Português (Portugal)" },
  { value: "bn", label: "বাংলা" },
  { value: "ru", label: "Русский" },
  { value: "ja", label: "日本語" },
  { value: "pa", label: "ਪੰਜਾਬੀ" },
  { value: "de", label: "Deutsch" },
  { value: "jv", label: "Basa Jawa" },
  { value: "ko", label: "한국어" },
  { value: "fr", label: "Français" },
  { value: "fr_CA", label: "Français (Canada)" },
  { value: "te", label: "తెలుగు" },
  { value: "vi", label: "Tiếng Việt" },
  { value: "mr", label: "मराठी" },
  { value: "ta", label: "தமிழ்" },
  { value: "tr", label: "Türkçe" },
  { value: "ur", label: "اردو" },
  { value: "it", label: "Italiano" },
  { value: "th", label: "ไทย" },
  { value: "gu", label: "ગુજરાતી" },
  { value: "fa", label: "فارسی" },
  { value: "pl", label: "Polski" },
  { value: "uk", label: "Українська" },
  { value: "ml", label: "മലയാളം" },
  { value: "kn", label: "ಕನ್ನಡ" },
  { value: "or", label: "ଓଡ଼ିଆ" },
  { value: "my", label: "မြန်မာဘာသာ" },
  { value: "sw", label: "Kiswahili" },
  { value: "nl_NL", label: "Nederlands" },
  { value: "ro", label: "Română" },
  { value: "hu", label: "Magyar" },
  { value: "el", label: "Ελληνικά" },
  { value: "cs", label: "Čeština" },
  { value: "sv", label: "Svenska" },
  { value: "be", label: "Беларуская" },
  { value: "bg", label: "Български" },
  { value: "hr", label: "Hrvatski" },
  { value: "sk", label: "Slovenčina" },
  { value: "da", label: "Dansk" },
  { value: "fi", label: "Suomi" },
  { value: "nb_NO", label: "Norsk Bokmål" },
  { value: "nn_NO", label: "Norsk Nynorsk" },
  { value: "he", label: "עברית" },
  { value: "id", label: "Bahasa Indonesia" },
  { value: "ms", label: "Bahasa Melayu" },
  { value: "fil", label: "Filipino" },
  { value: "ceb", label: "Cebuano" },
  { value: "sr", label: "Српски" },
  { value: "sl", label: "Slovenščina" },
  { value: "sq", label: "Shqip" },
  { value: "mk", label: "Македонски" },
  { value: "lt", label: "Lietuvių" },
  { value: "lv", label: "Latviešu" },
  { value: "et", label: "Eesti" },
  { value: "hy", label: "Հայերեն" },
  { value: "ka", label: "ქართული" },
  { value: "az", label: "Azərbaycanca" },
  { value: "af", label: "Afrikaans" },
  { value: "am", label: "አማርኛ" },
  { value: "eu", label: "Euskara" },
  { value: "ca", label: "Català" },
  { value: "gl", label: "Galego" },
  { value: "is", label: "Íslenska" },
  { value: "la", label: "Latina" },
  { value: "ne", label: "नेपाली" },
  { value: "ps", label: "پښتو" },
  { value: "sd", label: "سنڌي" },
  { value: "si", label: "සිංහල" },
  { value: "ht", label: "Kreyòl Ayisyen" },
  { value: "kok", label: "कोंकणी" },
  { value: "mai", label: "मैथिली" },
];

let nblmSettingsActiveTab = "sources";
let nblmSettingsActiveSourceTab = "report";
let nblmSettingsDraft = {};

function initNblmSettingsDraft() {
  const nblmSettings = loadNblmSettings();
  nblmSettingsDraft = {
    studioSettings: JSON.parse(JSON.stringify(appState.studioSettings || defaultStudioSettings())),
    maxParallel: { ...DEFAULT_MAX_PARALLEL, ...(nblmSettings.maxParallel || {}) },
    maxParallelChunks: nblmSettings.maxParallelChunks ?? DEFAULT_MAX_PARALLEL_CHUNKS,
  };
}

function collectCurrentTabIntoDraft() {
  const body = document.getElementById("nblm-settings-body");
  if (!body) return;
  if (nblmSettingsActiveTab === "sources") {
    const studioName = nblmSettingsActiveSourceTab;
    const next = { ...(nblmSettingsDraft.studioSettings[studioName] || {}) };
    body.querySelectorAll("[data-studio-setting]").forEach((node) => {
      next[node.getAttribute("data-studio-setting")] = node.value;
    });
    nblmSettingsDraft.studioSettings[studioName] = next;
    const maxParNode = body.querySelector(`[data-nblm-setting="maxParallel"]`);
    if (maxParNode) {
      nblmSettingsDraft.maxParallel[studioName] = Math.max(1, Number(maxParNode.value) || DEFAULT_MAX_PARALLEL[studioName] || 2);
    }
  } else if (nblmSettingsActiveTab === "sync") {
    const mpcNode = body.querySelector('[data-nblm-setting="maxParallelChunks"]');
    if (mpcNode) {
      nblmSettingsDraft.maxParallelChunks = Math.max(1, Number(mpcNode.value) || DEFAULT_MAX_PARALLEL_CHUNKS);
    }
  }
}

function openNotebookLMSettings() {
  closeUserMenu();
  nblmSettingsActiveTab = "sources";
  nblmSettingsActiveSourceTab = "report";
  initNblmSettingsDraft();
  switchView("nblm-settings");
}

function renderNblmSettingsTabs() {
  const tabBar = document.getElementById("nblm-settings-tab-bar");
  if (!tabBar) return;
  tabBar.innerHTML = renderTabBar(NBLM_SETTINGS_TABS, nblmSettingsActiveTab, "switchNblmSettingsTab", {
    label: (tab) => (tab === "sources" ? "Sources" : "Sync"),
  });
}

function switchNblmSettingsTab(tab) {
  collectCurrentTabIntoDraft();
  nblmSettingsActiveTab = tab;
  renderNblmSettingsTabs();
  renderNblmSettingsBody();
}

function switchNblmSourceTab(studioName) {
  collectCurrentTabIntoDraft();
  nblmSettingsActiveSourceTab = studioName;
  renderNblmSettingsBody();
}

function nblmSourceSettingsFields(studioName, settings) {
  const sections = [];
  if (studioName === "report") {
    sections.push(studioSettingsField("language", "Language", NBLM_LANGUAGES, settings.language));
    sections.push(studioSettingsField("format", "Format", [
      { value: "study-guide", label: "Study Guide" }, { value: "briefing-doc", label: "Briefing Doc" },
      { value: "timeline", label: "Timeline" }, { value: "faq", label: "FAQ" }, { value: "custom", label: "Custom" },
    ], settings.format));
  } else if (studioName === "slide_deck") {
    sections.push(studioSettingsField("language", "Language", NBLM_LANGUAGES, settings.language));
    sections.push(studioSettingsField("format", "Format", [
      { value: "detailed", label: "Detailed" }, { value: "presenter", label: "Presenter" },
    ], settings.format));
    sections.push(studioSettingsField("length", "Length", [
      { value: "default", label: "Default" }, { value: "short", label: "Short" },
    ], settings.length));
    sections.push(studioSettingsField("downloadFormat", "Download format", [
      { value: "pdf", label: "PDF" }, { value: "pptx", label: "PPTX" },
    ], settings.downloadFormat));
  } else if (studioName === "quiz" || studioName === "flashcards") {
    sections.push(studioSettingsField("quantity", "Quantity", [
      { value: "fewer", label: "Fewer" }, { value: "default", label: "Default" }, { value: "more", label: "More" },
    ], settings.quantity));
    sections.push(studioSettingsField("difficulty", "Difficulty", [
      { value: "easier", label: "Easier" }, { value: "default", label: "Default" }, { value: "hard", label: "Hard" },
    ], settings.difficulty));
    sections.push(studioSettingsField("downloadFormat", "Download format", studioName === "quiz" ? [
      { value: "json", label: "JSON" }, { value: "markdown", label: "Markdown" },
    ] : [
      { value: "markdown", label: "Markdown" }, { value: "json", label: "JSON" },
    ], settings.downloadFormat));
  } else if (studioName === "audio") {
    sections.push(studioSettingsField("language", "Language", NBLM_LANGUAGES, settings.language));
    sections.push(studioSettingsField("format", "Format", [
      { value: "deep-dive", label: "Deep Dive" }, { value: "conversational", label: "Conversational" },
    ], settings.format));
    sections.push(studioSettingsField("length", "Length", [
      { value: "short", label: "Short" }, { value: "default", label: "Default" }, { value: "long", label: "Long" },
    ], settings.length));
  }
  return sections;
}

function renderNblmSettingsBody() {
  const body = document.getElementById("nblm-settings-body");
  if (!body) return;

  if (nblmSettingsActiveTab === "sources") {
    const studioName = nblmSettingsActiveSourceTab;
    const settings = nblmSettingsDraft.studioSettings[studioName] || defaultStudioSettings()[studioName] || {};
    const maxPar = nblmSettingsDraft.maxParallel[studioName] ?? DEFAULT_MAX_PARALLEL[studioName] ?? 2;

    const sourceTabBar = renderTabBar(promptStudioTypes, studioName, "switchNblmSourceTab", {
      extraClass: " text-xs",
    });

    const settingSections = nblmSourceSettingsFields(studioName, settings);

    settingSections.push(`
      <label class="space-y-2 block border-t border-slate-100 pt-4 mt-2">
        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Max Parallel Requests</span>
        <input data-nblm-setting="maxParallel" class="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/20 transition-all" type="number" step="1" min="1" max="10" value="${maxPar}" />
        <span class="text-[10px] text-slate-400">How many ${studioName.replace(/_/g, " ")} jobs run in parallel per queue batch</span>
      </label>
    `);

    body.innerHTML = `
      <div class="flex gap-1 mb-4 flex-wrap">${sourceTabBar}</div>
      <div class="space-y-4">${settingSections.join("")}</div>
    `;
  } else if (nblmSettingsActiveTab === "sync") {
    const mpc = nblmSettingsDraft.maxParallelChunks ?? DEFAULT_MAX_PARALLEL_CHUNKS;
    body.innerHTML = `
      <div class="space-y-4">
        <label class="space-y-2 block">
          <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Max Parallel Chunk Uploads</span>
          <input data-nblm-setting="maxParallelChunks" class="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/20 transition-all" type="number" step="1" min="1" max="10" value="${mpc}" />
          <span class="text-[10px] text-slate-400">Number of chunks uploaded to NotebookLM simultaneously during sync</span>
        </label>
      </div>
    `;
  }
}

function saveNotebookLMSettings() {
  collectCurrentTabIntoDraft();
  // Persist all studio settings at once
  appState.studioSettings = nblmSettingsDraft.studioSettings;
  persistStudioSettings();
  // Persist nblm settings (maxParallel + maxParallelChunks)
  const nblmSettings = loadNblmSettings();
  nblmSettings.maxParallel = nblmSettingsDraft.maxParallel;
  nblmSettings.maxParallelChunks = nblmSettingsDraft.maxParallelChunks;
  persistNblmSettings(nblmSettings);
  updateStudioSettingsSummaries();
  showToast("NotebookLM settings saved.");
}

export {
  studioSettingSummary,
  updateStudioSettingsSummaries,
  studioSettingsField,
  openStudioSettings,
  closeStudioSettings,
  saveStudioSettings,
  NBLM_SETTINGS_TABS,
  NBLM_LANGUAGES,
  openNotebookLMSettings,
  renderNblmSettingsTabs,
  switchNblmSettingsTab,
  switchNblmSourceTab,
  nblmSourceSettingsFields,
  renderNblmSettingsBody,
  saveNotebookLMSettings,
};
