// Studio Builder rows. One row per Studio type, generated from a single table
// so the nine types cannot drift apart in markup.
import { promptStudioTypes, studioIconNames } from "./state.js";
import { applyOfflineIcons } from "./dom.js";

const STUDIO_LABELS = {
  report: "Report",
  slide_deck: "Slide deck",
  quiz: "Quiz",
  flashcards: "Flashcards",
  audio: "Audio",
  video: "Video",
  infographic: "Infographic",
  mind_map: "Mind map",
  data_table: "Data table",
};

function studioLabel(studioName) {
  return STUDIO_LABELS[studioName] || String(studioName || "").replace(/_/g, " ");
}

// `slide_deck` keeps its historical prompt field id; everything that reads the
// field goes through prompts.js `promptFieldId`, which knows the same quirk.
function promptFieldId(studioName) {
  return studioName === "slide_deck" ? "studio-slide-prompt" : `studio-${studioName}-prompt`;
}

function studioCardHtml(studioName) {
  const label = studioLabel(studioName);
  const lower = label.toLowerCase();
  const fieldId = promptFieldId(studioName);
  return `
    <div class="studio-card" data-studio="${studioName}">
      <div class="studio-card-row">
        <span class="material-symbols-outlined studio-card-icon">${studioIconNames[studioName] || "description"}</span>
        <div class="studio-card-text">
          <h3>${label}</h3>
          <p id="studio-${studioName}-settings-summary"></p>
        </div>
        <button onclick="window.openStudioSettings('${studioName}')" class="queue-action-btn queue-settings-btn" title="${label} settings" aria-label="${label} settings">
          <span class="material-symbols-outlined !text-sm">settings</span>
        </button>
        <button onclick="window.addStudioQueueItemsForSelection('${studioName}')" class="studio-card-each" title="Queue a separate ${lower} for each selected source">One each</button>
        <button onclick="window.addStudioQueueItem('${studioName}')" class="studio-card-add" title="Queue one ${lower} for the selection">Add</button>
      </div>
      <select id="studio-${studioName}-preset" onchange="window.applyPromptPreset('${studioName}', this.value)" class="studio-card-prompt" aria-label="${label} prompt"></select>
      <div id="${fieldId}-wrap" class="hidden">
        <textarea id="${fieldId}" class="studio-card-textarea" rows="4" placeholder="Custom ${lower} prompt"></textarea>
      </div>
    </div>
  `;
}

function renderStudioCards() {
  const container = document.getElementById("studio-controls");
  if (!container) return;
  container.innerHTML = promptStudioTypes.map(studioCardHtml).join("");
  applyOfflineIcons(container);
}

// "One each" only means something when several sources are ticked.
function updateStudioCardSelection(selectedCount) {
  const container = document.getElementById("studio-controls");
  if (container) container.classList.toggle("has-multi-selection", selectedCount > 1);
}

export { renderStudioCards, updateStudioCardSelection, studioLabel };
