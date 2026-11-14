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
    return `${settings.quantity || "standard"} · ${settings.difficulty || "hard"} · ${settings.downloadFormat || (studioName === "quiz" ? "json" : "markdown")}`;
  }
  if (studioName === "audio") {
    return `${String(settings.language || "en").toUpperCase()} · ${settings.format || "deep-dive"} · ${settings.length || "long"}`;
  }
  if (studioName === "video") {
    return `${String(settings.language || "en").toUpperCase()} · ${settings.format || "explainer"} · ${settings.style || "auto"}`;
  }
  if (studioName === "infographic") {
    return `${String(settings.language || "en").toUpperCase()} · ${settings.orientation || "portrait"} · ${settings.detail || "detailed"} · ${settings.style || "auto"}`;
  }
  if (studioName === "mind_map") {
    return `${String(settings.language || "en").toUpperCase()} · ${settings.format || "note-backed"}`;
  }
  if (studioName === "data_table") {
    return String(settings.language || "en").toUpperCase();
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

function studioSettingsField(field, label, options, value, onChange) {
  const opts = options.map((option) => `<option value="${option.value}" ${option.value === value ? "selected" : ""}>${option.label}</option>`).join("");
  const onChangeAttr = onChange ? ` onchange="${onChange}"` : "";
  return `
    <label class="space-y-2 block">
      <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">${label}</span>
      <select data-studio-setting="${field}"${onChangeAttr} class="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/20 transition-all">
        ${opts}
      </select>
    </label>
  `;
}

function studioSettingsTextField(field, label, value, placeholder) {
  const safeValue = String(value || "").replace(/"/g, "&quot;");
  const safePlaceholder = String(placeholder || "").replace(/"/g, "&quot;");
  return `
    <label class="space-y-2 block">
      <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">${label}</span>
      <input data-studio-setting="${field}" type="text" value="${safeValue}" placeholder="${safePlaceholder}" class="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/20 transition-all" />
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

// Re-render the option fields after a choice that changes which fields exist
// (video format/style). Works in both places the fields are shown: the
// per-Studio modal on the dashboard and the NotebookLM settings view.
function refreshStudioSettingsFields(studioName) {
  const modal = document.getElementById("studio-settings-modal");
  const body = document.getElementById("studio-settings-body");
  const modalOpen = modal && body && !modal.classList.contains("hidden");
  if (!modalOpen || appState.studioSettingsEditor !== studioName) {
    switchNblmSourceTab(studioName);
    return;
  }
  const draft = { ...(appState.studioSettings?.[studioName] || defaultStudioSettings()[studioName] || {}) };
  modal.querySelectorAll("[data-studio-setting]").forEach((node) => {
    draft[node.getAttribute("data-studio-setting")] = node.value;
  });
  body.innerHTML = `<div class="space-y-4">${nblmSourceSettingsFields(studioName, draft).join("")}</div>`;
}
window.refreshStudioSettingsFields = refreshStudioSettingsFields;

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

// Studio types that expose a settings panel in the NotebookLM settings view:
// the same nine the builder can queue.
const SETTINGS_STUDIO_TYPES = promptStudioTypes;

// Option lists come from project-utils.js STUDIO_OPTIONS, which mirrors
// notebooklm_chunker/config.py (source of truth), so the settings UI can never
// offer a value the engine rejects.
const OPTION_LABELS = {
  pdf: "PDF",
  pptx: "PPTX",
  json: "JSON",
  html: "HTML",
  "briefing-doc": "Briefing Doc",
};

function studioOptions(studioName, field) {
  const values = window.projectUtils.STUDIO_OPTIONS?.[studioName]?.[field] || [];
  return values.map((value) => ({
    value,
    label:
      OPTION_LABELS[value] ||
      value
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" "),
  }));
}

// UI defaults for studio types not covered by state.js defaultStudioSettings().
// state.js only ships defaults for the five prompt studios, so the settings-only
// studio types (video, infographic, data_table, mind_map) get theirs here.
function studioSettingsDefaults(studioName) {
  const base = defaultStudioSettings()[studioName];
  if (base) return base;
  const extra = {
    video: { language: "en", format: "explainer", style: "auto", stylePrompt: "" },
    infographic: { language: "en", orientation: "portrait", detail: "detailed", style: "auto" },
    data_table: { language: "en" },
    mind_map: { language: "en", format: "note-backed" },
  };
  return extra[studioName] || {};
}

function nblmSourceSettingsFields(studioName, settings) {
  const sections = [];
  const select = (field, label, onChange) =>
    sections.push(
      studioSettingsField(field, label, studioOptions(studioName, field), settings[field], onChange),
    );
  const language = () =>
    sections.push(studioSettingsField("language", "Language", NBLM_LANGUAGES, settings.language));

  if (studioName === "report") {
    language();
    select("format", "Format");
  } else if (studioName === "slide_deck") {
    language();
    select("format", "Format");
    select("length", "Length");
    select("downloadFormat", "Download format");
  } else if (studioName === "quiz" || studioName === "flashcards") {
    select("quantity", "Quantity");
    select("difficulty", "Difficulty");
    select("downloadFormat", "Download format");
  } else if (studioName === "audio") {
    language();
    select("format", "Format");
    select("length", "Length");
  } else if (studioName === "video") {
    language();
    // Changing format or style must re-render the panel so the custom
    // style_prompt input can appear/disappear.
    select("format", "Format", "window.refreshStudioSettingsFields('video')");
    const isShort = settings.format === "short";
    const styles = studioOptions("video", "style").filter(
      (option) => !(isShort && option.value === "custom"),
    );
    sections.push(
      studioSettingsField("style", "Style", styles, settings.style, "window.refreshStudioSettingsFields('video')"),
    );
    if (settings.style === "custom" && !isShort) {
      sections.push(studioSettingsTextField("stylePrompt", "Style prompt", settings.stylePrompt, "Describe the visual style for the video"));
    }
  } else if (studioName === "infographic") {
    language();
    select("orientation", "Orientation");
    select("detail", "Detail");
    select("style", "Style");
  } else if (studioName === "data_table") {
    language();
  } else if (studioName === "mind_map") {
    language();
    select("format", "Type");
    sections.push(`
      <p class="text-xs text-slate-400 leading-relaxed">
        Interactive is the mind map shown in NotebookLM's Studio panel. Note Backed saves the map as a note.
      </p>
    `);
  }
  return sections;
}

function renderNblmSettingsBody() {
  const body = document.getElementById("nblm-settings-body");
  if (!body) return;

  if (nblmSettingsActiveTab === "sources") {
    const studioName = nblmSettingsActiveSourceTab;
    const settings = nblmSettingsDraft.studioSettings[studioName] || studioSettingsDefaults(studioName);
    const maxPar = nblmSettingsDraft.maxParallel[studioName] ?? DEFAULT_MAX_PARALLEL[studioName] ?? 2;

    const sourceTabBar = renderTabBar(SETTINGS_STUDIO_TYPES, studioName, "switchNblmSourceTab", {
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
