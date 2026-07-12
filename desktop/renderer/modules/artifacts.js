import { appState } from "./state.js";
import { matchesQuery, showToast } from "./dom.js";
import { prepareStudioView } from "./studio.js";

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
  const query = appState.studioArtifactsSearchQuery;
  return (appState.studioArtifacts || []).filter((item) => {
    if (artifactKindToStudio(item.kind) !== appState.studioArtifactsTab) return false;
    return matchesQuery(item.title, query)
      || matchesQuery(item.kind, query)
      || matchesQuery(item.status, query);
  });
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

function selectStudioArtifactsTab(studioName) {
  appState.studioArtifactsTab = studioName;
  appState.selectedStudioArtifactIds = new Set();
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

export {
  artifactKindToStudio,
  normalizedArtifactStatus,
  filteredStudioArtifacts,
  loadStudioArtifacts,
  selectStudioArtifactsTab,
  toggleStudioArtifactSelection,
  deleteSelectedStudioArtifacts,
};
