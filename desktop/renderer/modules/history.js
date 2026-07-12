import { appState, readJson, loadProjectMetadata } from "./state.js";
import { escapeHtml, attrArg, matchesQuery } from "./dom.js";
import { switchView } from "./navigation.js";
import { inspectSelectedPdf, loadRealChunks } from "./chunks.js";

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

  renderHistoryList();
}

function renderHistoryList() {
  const listEl = document.getElementById("project-history-list");
  if (!listEl) return;
  const statusFilter = appState.historyStatusFilter || "all";
  const filtered = appState.localProjects.filter((project) => {
    if (statusFilter !== "all" && project.status.label !== statusFilter) return false;
    return matchesQuery(
      `${project.rawName} ${project.metadata?.notebook_title || ""} ${project.status.label}`,
      appState.historySearchQuery,
    );
  });

  if (appState.localProjects.length === 0) {
    listEl.innerHTML = '<p class="text-sm text-slate-400 italic col-span-full py-10">No local chunks yet.</p>';
    return;
  }
  if (filtered.length === 0) {
    listEl.innerHTML = '<p class="text-sm text-slate-400 italic col-span-full py-10">No matches.</p>';
    return;
  }

  const badge = (tone) =>
    tone === "green" ? "color: #15803d;" : tone === "blue" ? "color: #1d4ed8;" : tone === "amber" ? "color: #b45309;" : "color: #64748b;";

  listEl.innerHTML = filtered.map((project) => {
    const date = new Date(project.modified).toLocaleDateString();
    return `<div onclick="window.resumeExistingPath(${attrArg(project.path)})" style="cursor:pointer;border:1px solid #e2e8f0;border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:12px;transition:border-color .15s;" onmouseenter="this.style.borderColor='#93c5fd'" onmouseleave="this.style.borderColor='#e2e8f0'">
  <div style="display:flex;justify-content:space-between;align-items:start;">
    <p style="font-weight:700;font-size:14px;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${escapeHtml(project.rawName)}</p>
    <button onclick="event.stopPropagation();window.deleteProject(${attrArg(project.path)})" style="background:none;border:none;cursor:pointer;color:#cbd5e1;padding:4px;margin:-4px -4px 0 8px;transition:color .15s;" onmouseenter="this.style.color='#ef4444'" onmouseleave="this.style.color='#cbd5e1'" title="Delete"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 7h14M9 7V5h6v2M9 10v7M15 10v7M7 7l1 12h8l1-12"/></svg></button>
  </div>
  <div style="display:flex;align-items:center;gap:8px;font-size:12px;">
    <span style="font-weight:700;${badge(project.status.tone)}">${escapeHtml(project.status.label)}</span>
    <span style="color:#94a3b8;">${escapeHtml(project.status.detail)}</span>
  </div>
  <span style="font-size:11px;color:#94a3b8;">${date}</span>
</div>`;
  }).join("");
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
  if (!confirm("Delete this local chunk version?")) return;
  const result = await window.electronAPI.deleteProject(projectPath);
  if (!result.success) {
    alert(result.error || "Could not delete chunk version.");
    return;
  }
  await fetchLocalProjects();
}

export {
  fetchLocalProjects,
  renderHistoryList,
  resumeExistingPath,
  deleteProject,
};
