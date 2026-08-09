// Workflow presets (roadmap D1)
// ----------------------------------------------------------------------------
// One-click Studio configurations. Each preset names which of the five
// queue-builder studios to enqueue (report, slide_deck, quiz, flashcards, audio)
// plus optional per-studio config overrides.
//
// The queue builder has no per-studio enable/disable toggles: a studio is added
// to the queue via addStudioQueueItem(). A preset therefore drives the queue by
// enqueuing its studios in one click through enqueueStudioPreset() (a studio.js
// helper that reuses the normal queue-item build path and layers the overrides
// on top). Settings such as report format or quiz difficulty live in the
// per-studio settings modal (appState.studioSettings), not in the queue-builder
// DOM, so a preset passes them as config overrides rather than mutating the
// user's saved settings.
//
// Override values below MUST match the options offered in the settings modal:
//   report.format   : study-guide | briefing-doc | timeline | faq | custom
//   quiz/flashcards : quantity fewer|standard, difficulty easier|default|hard
//   audio.format    : deep-dive | conversational,  length short|default|long
//   slide_deck      : format detailed|presenter, length default|short
// ----------------------------------------------------------------------------

import { enqueueStudioPreset } from "./studio.js";
import { escapeHtml, applyOfflineIcons } from "./dom.js";

const STUDIO_PRESETS = [
  {
    id: "learning-kit",
    name: "Learning Kit",
    icon: "school",
    description: "Study-guide report, quiz, and flashcards",
    studios: {
      report: { format: "study-guide" },
      quiz: { quantity: "standard", difficulty: "default" },
      flashcards: { quantity: "standard", difficulty: "default" },
    },
  },
  {
    id: "quiz-only",
    name: "Quiz Only",
    icon: "quiz",
    description: "A single hard quiz batch",
    studios: {
      quiz: { quantity: "standard", difficulty: "hard" },
    },
  },
  {
    id: "slides-report",
    name: "Slides + Report",
    icon: "slideshow",
    description: "Slide deck plus a study-guide report",
    studios: {
      slide_deck: {},
      report: { format: "study-guide" },
    },
  },
  {
    id: "podcast-series",
    name: "Podcast Series",
    icon: "podcasts",
    description: "Long deep-dive audio",
    studios: {
      audio: { format: "deep-dive", length: "long" },
    },
  },
  {
    id: "everything",
    name: "Everything",
    icon: "auto_awesome",
    description: "Report, slides, quiz, flashcards, and audio",
    studios: {
      report: {},
      slide_deck: {},
      quiz: {},
      flashcards: {},
      audio: {},
    },
  },
];

function findPreset(id) {
  return STUDIO_PRESETS.find((preset) => preset.id === id) || null;
}

// Drives the queue builder for a named preset: enqueues each of the preset's
// studios (with its config overrides) via the studio.js helper. buildStudioSelections
// is untouched — the helper reuses it and layers overrides onto the resulting config.
async function applyPreset(id) {
  const preset = findPreset(id);
  if (!preset) return;
  await enqueueStudioPreset(Object.keys(preset.studios), preset.studios, preset.name);
}

function renderPresetPicker() {
  const container = document.getElementById("studio-preset-picker");
  if (!container) return;
  const chips = STUDIO_PRESETS.map((preset) => `
    <button type="button" class="preset-chip" onclick="window.applyPreset('${escapeHtml(preset.id)}')" title="${escapeHtml(preset.description)}">
      <span class="material-symbols-outlined preset-chip-icon">${escapeHtml(preset.icon)}</span>
      <span class="preset-chip-body">
        <span class="preset-chip-name">${escapeHtml(preset.name)}</span>
        <span class="preset-chip-desc">${escapeHtml(preset.description)}</span>
      </span>
    </button>
  `).join("");
  container.innerHTML = `
    <div class="preset-picker-head">
      <span class="material-symbols-outlined preset-picker-icon">bolt</span>
      <div class="preset-picker-heading">
        <p class="preset-picker-title">Workflow presets</p>
        <p class="preset-picker-sub">One click to queue a ready-made Studio set for the selected sources.</p>
      </div>
    </div>
    <div class="preset-chip-row">${chips}</div>
  `;
  applyOfflineIcons(container);
}

export { STUDIO_PRESETS, applyPreset, renderPresetPicker };

// Self-register the handler + render the picker, matching the inline-onclick
// pattern used elsewhere in the renderer. app.js is off-limits, so this module
// wires itself up on evaluation (the app.js module script runs after the DOM is
// parsed, so the picker container already exists).
window.applyPreset = applyPreset;
renderPresetPicker();
