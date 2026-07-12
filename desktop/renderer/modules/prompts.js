import { appState, promptStudioTypes, persistPromptLibrary } from "./state.js";
import { escapeHtml, attrArg, renderTabBar, applyOfflineIcons, showToast } from "./dom.js";

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
      ...items.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`),
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
  tabs.innerHTML = renderTabBar(promptStudioTypes, appState.promptStudioTab, "selectPromptStudioTab");
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
        <input type="checkbox" ${appState.selectedPromptIds.has(item.id) ? "checked" : ""} onchange="window.togglePromptSelection(${attrArg(item.id)})" class="prompt-checkbox" />
        <button onclick="window.selectPromptItem(${attrArg(item.id)})" class="dashboard-source-main">
          <div class="dashboard-source-copy">
            <p class="text-sm font-bold text-slate-900 truncate">${escapeHtml(item.name)}</p>
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
            <h3 class="font-bold text-slate-900">${escapeHtml(current.name)}</h3>
            <p class="text-sm text-slate-500 mt-1 capitalize">${appState.promptStudioTab.replace(/_/g, " ")} prompt</p>
          </div>
          <div class="p-4 rounded-2xl border border-slate-100 bg-slate-50">
            <p class="text-sm text-slate-600 whitespace-pre-wrap">${escapeHtml(current.prompt)}</p>
          </div>
          <div class="flex items-center gap-3">
            <button onclick="window.openPromptEditor(${attrArg(current.id)})" class="secondary-action-btn">Edit prompt</button>
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

export {
  promptFieldId,
  promptSelectId,
  refreshPromptDropdowns,
  updatePromptInputVisibility,
  promptItemsForActiveTab,
  renderPromptsView,
  savePromptPreset,
  deletePromptPreset,
  selectPromptStudioTab,
  startPromptDraft,
  selectPromptItem,
  togglePromptSelection,
  deleteSelectedPrompts,
  openPromptEditor,
  closePromptEditor,
  applyPromptPreset,
};
