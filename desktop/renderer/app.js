// NotebookLM Chunker - Ultimate Absolute Stable Release
let appState = {
    isAuthenticated: false,
    currentView: 'auth',
    isResumeMode: false,
    activeNotebookId: null,
    activeNotebookTitle: null,
    selectedPDF: null,
    outputDir: null,
    chunks: [],
    isRunning: false,
    totalPages: 0,
    calculatedTargetPages: 3.0,
    currentChunkId: null,
    saveTimeout: null,
    localProjects: [],
    paths: {}
};

// --- CORE UTILS ---

function updateSourceUI(n) {
    const d = document.getElementById('drop-zone'), s = document.getElementById('selected-state');
    if (d && s) { d.style.display = 'none'; s.style.display = 'flex'; document.getElementById('selected-file-name').textContent = n; }
}

function resetSourceUI() {
    const d = document.getElementById('drop-zone'), s = document.getElementById('selected-state');
    if (d && s) { d.style.display = 'flex'; s.style.display = 'none'; }
}

async function fetchLocalProjects() {
    if (!appState.paths.projects) return;
    try {
        const projects = await window.electronAPI.listProjects(appState.paths.projects);
        appState.localProjects = projects;
        renderDashboard();
    } catch(e) {}
}

function renderDashboard() {
    const list = document.getElementById('recent-projects-list'); if (!list) return;
    if (appState.localProjects.length > 0) {
        list.innerHTML = appState.localProjects.map(p => `
            <div onclick="window.resumeLocalProject('${p.path}')" class="project-card p-6 bg-white border border-slate-100 rounded-3xl shadow-sm hover:shadow-md transition-all cursor-pointer border-b-4 border-b-primary/20 fade-in text-left">
                <div class="flex justify-between mb-4"><span class="material-symbols-outlined text-slate-400">description</span><span class="text-[10px] font-bold text-slate-500 uppercase bg-slate-100 px-2 py-1 rounded">Local</span></div>
                <h3 class="font-bold text-slate-900 truncate mb-1">${p.rawName || p.name}</h3>
                <div class="flex items-center gap-2 text-primary font-bold text-[10px] uppercase mt-4"><span class="material-symbols-outlined !text-sm">edit_note</span> Open Catalog</div>
            </div>
        `).join('');
    } else { list.innerHTML = `<p class="col-span-full text-slate-400 italic text-center p-8">No local projects found.</p>`; }
}

async function loadProjectMetadata() {
    if (!appState.outputDir) return false;
    const metaPath = `${appState.outputDir}/metadata.json`.replace(/\\/g, '/');
    try {
        const res = await window.electronAPI.readFile(metaPath);
        if (res.success) {
            const meta = JSON.parse(res.content);
            appState.activeNotebookId = meta.notebook_id;
            appState.activeNotebookTitle = meta.notebook_title;
            return true;
        }
    } catch (e) {}
    return false;
}

async function saveProjectMetadata() {
    if (!appState.outputDir || !appState.activeNotebookId) return;
    const metadata = { notebook_id: appState.activeNotebookId, notebook_title: appState.activeNotebookTitle };
    await window.electronAPI.runNBLM({ command: 'internal-write-file', args: [`${appState.outputDir}/metadata.json`, JSON.stringify(metadata, null, 2)] });
}

async function loadRealChunks() {
    if (!appState.outputDir) return false;
    try {
        await loadProjectMetadata();
        const res = await window.electronAPI.readFile(`${appState.outputDir}/manifest.json`);
        if (res.success) {
            appState.chunks = JSON.parse(res.content).map((item, idx) => ({ 
                id: idx + 1, 
                title: item.primary_heading || `Chunk ${idx+1}`, 
                synced: item.synced === true, 
                source_id: item.source_id || null,
                filename: item.file, 
                path: `${appState.outputDir}/${item.file}` 
            }));
            return true;
        }
    } catch (err) {}
    return false;
}

function populateChunkList() {
    const list = document.getElementById('chunk-list'); if (!list) return;
    list.innerHTML = appState.chunks.map(c => `
        <div data-chunk-id="${c.id}" class="chunk-item group p-3 rounded-lg hover:bg-slate-50 border border-transparent cursor-pointer text-left relative">
            <div onclick="window.selectChunk(${c.id})" class="flex items-center justify-between gap-2 pr-8">
                <h4 class="text-sm font-semibold truncate title-preview">${c.id}: ${c.title}</h4>
                <span class="status-dot size-1.5 ${c.synced ? 'bg-green-500' : 'bg-blue-500'} rounded-full"></span>
            </div>
            <button onclick="window.deleteChunk(${c.id})" class="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-500 transition-all">
                <span class="material-symbols-outlined !text-sm">delete</span>
            </button>
        </div>
    `).join('');
    if (appState.currentChunkId) selectChunk(appState.currentChunkId); else if (appState.chunks.length > 0) selectChunk(1);
}

async function selectChunk(id) {
    const chunk = appState.chunks.find(c => c.id === id); if (!chunk) return;
    appState.currentChunkId = id;
    document.querySelectorAll('.chunk-item').forEach(i => i.className = (parseInt(i.dataset.chunkId) === id) ? "chunk-item group p-3 rounded-lg bg-primary/10 border border-primary/20 cursor-pointer relative text-left" : "chunk-item group p-3 rounded-lg hover:bg-slate-50 border border-transparent cursor-pointer text-left");
    document.getElementById('current-chunk-title').textContent = chunk.title;
    const res = await window.electronAPI.readFile(chunk.path);
    if (res.success) document.getElementById('markdown-content').innerHTML = res.content.split('\n\n').map(p => `<p class="text-lg leading-relaxed text-slate-700 mb-6" contenteditable="true" oninput="window.handleEdit()">${p}</p>`).join('');
}

function prepareSyncView() {
    const list = document.getElementById('sync-chunk-list'); if (!list) return;
    const hasNB = appState.isResumeMode || !!appState.activeNotebookId;
    
    const settingsPanel = document.getElementById('notebook-settings-panel');
    if (settingsPanel) settingsPanel.style.display = hasNB ? 'none' : 'block';
    
    const mainPanel = document.getElementById('sync-main-panel');
    if (mainPanel) mainPanel.style.display = 'block';
    
    const info = document.getElementById('active-notebook-info');
    if (info) info.style.display = hasNB ? 'block' : 'none';
    
    const nameDisplay = document.getElementById('active-notebook-name');
    if (nameDisplay && appState.activeNotebookId) {
        const nbUrl = `https://notebooklm.google.com/notebook/${appState.activeNotebookId}`;
        nameDisplay.innerHTML = `<a href="#" onclick="window.electronAPI.openExternal('${nbUrl}'); return false;" class="text-primary hover:underline font-bold flex items-center gap-1">${appState.activeNotebookTitle || "View Notebook"} <span class="material-symbols-outlined !text-xs">open_in_new</span></a>`;
    }


    document.getElementById('sync-count-total').textContent = appState.chunks.length;
    list.innerHTML = appState.chunks.map(chunk => `
        <div data-filename="${chunk.filename}" class="px-6 py-4 flex items-center justify-between hover:bg-slate-50/50 text-left">
            <div class="flex items-center gap-4 truncate">
                <span class="material-symbols-outlined ${chunk.synced ? 'text-green-500' : 'text-blue-500'}">${chunk.synced ? 'check_circle' : 'sync_problem'}</span>
                <div class="truncate"><p class="text-sm font-medium text-slate-900 truncate">${chunk.title}</p></div>
            </div>
            <span class="status-text text-[10px] font-bold uppercase ${chunk.synced ? 'text-green-500' : 'text-blue-500'}">${chunk.synced ? 'DONE' : 'CHANGED'}</span>
        </div>
    `).join('');
}

// --- AUTHENTICATION ---

async function checkAuthStatus() {
    console.log("[App] Checking auth status...");
    try {
        const res = await window.electronAPI.runNBLM({ command: 'doctor', args: [] });
        const output = (res.output || "") + (res.error || "");
        if (output.includes('OK   auth')) {
            appState.isAuthenticated = true;
            document.getElementById('main-sidebar').style.display = 'flex';
            document.getElementById('auth-view').style.display = 'none';
            await fetchLocalProjects();
            switchView('dashboard');
        } else {
            appState.isAuthenticated = false;
            switchView('auth');
        }
    } catch (e) { appState.isAuthenticated = false; switchView('auth'); }
}

async function login() {
    document.getElementById('login-btn').style.display = 'none';
    const c = document.getElementById('confirm-login-btn');
    c.classList.remove('hidden'); c.style.display = 'block';
    window.electronAPI.runNBLM({ command: 'login', args: [] });
}

async function confirmLogin() {
    await window.electronAPI.sendNBLMInput("\n");
    await new Promise(r => setTimeout(r, 1500));
    await checkAuthStatus();
}

// --- NAVIGATION ---

function isStepEnabled(viewName) {
    if (!appState.isAuthenticated) return viewName === 'auth';
    if (appState.isResumeMode && (viewName === 'source' || viewName === 'structure')) return false;
    const name = (viewName === 'refinement' || viewName === 'sources') ? 'sources' : viewName;
    switch(name) {
        case 'source': return true;
        case 'structure': return !!appState.selectedPDF;
        case 'sources': return !!appState.selectedPDF || appState.isResumeMode;
        case 'sync': return appState.chunks.length > 0 || appState.isResumeMode;
        case 'studio': return appState.chunks.length > 0 || appState.isResumeMode;
        default: return true;
    }
}

function switchView(viewName) {
    const targetView = (viewName === 'refinement' || viewName === 'sources') ? 'sources' : viewName;
    if (!appState.isAuthenticated && targetView !== 'auth') return;
    if (!isStepEnabled(targetView)) return;

    const sidebar = document.getElementById('main-sidebar');
    if (sidebar) sidebar.style.display = appState.isAuthenticated ? 'flex' : 'none';

    const header = document.getElementById('wizard-header');
    if (header) header.style.display = ['source', 'structure', 'sources', 'sync', 'studio'].includes(targetView) ? 'flex' : 'none';

    document.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.style.display = 'none'; });
    const viewEl = document.getElementById(`${targetView}-view`);
    if (viewEl) {
        viewEl.classList.add('active');
        viewEl.style.display = (targetView === 'sources' || targetView === 'dashboard' || targetView === 'source' || targetView === 'structure' || targetView === 'sync') ? 'flex' : 'flex';
        if (targetView === 'dashboard') viewEl.style.display = 'block';
    }

    document.querySelectorAll('[data-sidebar]').forEach(l => {
        l.className = (l.dataset.sidebar === targetView ? "flex items-center gap-3 px-3 py-2.5 rounded-xl bg-primary/10 text-primary font-bold transition-all cursor-pointer" : "flex items-center gap-3 px-3 py-2.5 rounded-xl text-slate-500 hover:bg-slate-100 transition-all cursor-pointer");
    });

    document.querySelectorAll('[data-nav]').forEach(l => {
        const navName = l.dataset.nav === 'refinement' ? 'sources' : l.dataset.nav;
        l.style.display = (appState.isResumeMode && (navName === 'source' || navName === 'structure')) ? 'none' : 'block';
        if (navName === targetView) l.className = "px-4 py-1.5 rounded-lg bg-white shadow-sm text-xs font-bold text-primary transition-all cursor-pointer";
        else l.className = "px-4 py-1.5 rounded-lg text-xs font-bold text-slate-500 hover:text-slate-900 transition-colors cursor-pointer";
    });

    if (targetView === 'dashboard') fetchLocalProjects();
    if (targetView === 'sources' && appState.chunks.length > 0) populateChunkList();
    if (targetView === 'sync') prepareSyncView();
    appState.currentView = targetView;
}

// --- ENGINE ---

async function forceRefine() {
    if (!appState.selectedPDF) return;
    appState.isRunning = true;
    document.getElementById('loading-overlay').style.display = 'flex';
    const chunkCount = parseInt(document.getElementById('target-count-slider')?.value || 15);
    const target = (appState.totalPages / chunkCount).toFixed(3);
    const outDir = appState.outputDir.replace(/\\/g, '/');
    const pdfPath = appState.selectedPDF.replace(/\\/g, '/');
    
    // PDF Path must be FIRST argument
    const args = [pdfPath, '--yes', '--output-dir', outDir, '--target-pages', target.toString(), '--min-pages', '0.001', '--max-pages', (parseFloat(target) * 1.5).toFixed(3), '--words-per-page', '300'];
    try {
        const res = await window.electronAPI.runNBLM({ command: 'prepare', args: args });
        if ((res.output || "").includes('Chunks generated')) {
            await new Promise(r => setTimeout(r, 1000));
            if (await loadRealChunks()) switchView('sources');
        } else { alert("Engine failed. Check terminal."); }
    } finally { appState.isRunning = false; document.getElementById('loading-overlay').style.display = 'none'; }
}

async function handleFileSelect(path, name) {
    appState.selectedPDF = path;
    const baseSafeName = name.replace('.pdf', '').replace(/[^a-z0-9]/gi, '-');
    const baseDir = `${appState.paths.projects}/${baseSafeName}-chunks`;
    
    // Klasörleri tara (baseSafeName ile başlayan tüm projeleri bul)
    const allProjects = await window.electronAPI.listProjects(appState.paths.projects);
    const related = allProjects.filter(p => p.path.includes(baseSafeName));

    const dropZone = document.getElementById('drop-zone');
    const selectedState = document.getElementById('selected-state');
    const duplicateState = document.getElementById('duplicate-state');

    if (related.length > 0) {
        if (dropZone) dropZone.style.display = 'none';
        if (selectedState) selectedState.style.display = 'none';
        if (duplicateState) {
            duplicateState.style.display = 'flex';
            const list = document.getElementById('existing-versions-list');
            list.innerHTML = related.map((p, i) => `
                <div onclick="window.resumeExistingPath('${p.path}')" class="p-4 bg-white border border-slate-200 rounded-xl hover:border-primary/50 hover:shadow-sm cursor-pointer transition-all flex items-center justify-between group">
                    <div class="flex items-center gap-3">
                        <span class="material-symbols-outlined text-slate-400 group-hover:text-primary">folder_open</span>
                        <div class="text-left">
                            <p class="font-bold text-slate-900">${p.name}</p>
                            <p class="text-[10px] text-slate-400 uppercase tracking-tighter">Existing Version ${i+1}</p>
                        </div>
                    </div>
                    <span class="material-symbols-outlined text-primary opacity-0 group-hover:opacity-100 transition-all">play_circle</span>
                </div>
            `).join('');
        }
        return;
    }

    appState.outputDir = baseDir;
    updateSourceUI(name);
    const res = await window.electronAPI.runNBLM({ command: 'inspect', args: [path] });
    if (res.success) {
        try {
            const data = JSON.parse(res.output);
            appState.totalPages = data.pages;
            if (document.getElementById('total-pages-display')) document.getElementById('total-pages-display').textContent = data.pages;
            updateSlider(15);
        } catch(e) {}
    }
}

async function resumeExistingPath(path) {
    appState.outputDir = path;
    const success = await loadRealChunks();
    if (success) {
        appState.isResumeMode = true;
        switchView('sources');
    }
}

async function startNewVersion() {
    const baseSafeName = appState.selectedPDF.split('/').pop().replace('.pdf', '').replace(/[^a-z0-9]/gi, '-');
    let index = 1;
    let targetDir = `${appState.paths.projects}/${baseSafeName}-chunks-${index}`;
    
    // Boş versiyon numarası bulana kadar dön
    while (await window.electronAPI.dirExists(targetDir)) {
        index++;
        targetDir = `${appState.paths.projects}/${baseSafeName}-chunks-${index}`;
    }
    
    appState.outputDir = targetDir;
    const dup = document.getElementById('duplicate-state');
    if (dup) dup.style.display = 'none';
    
    updateSourceUI(appState.selectedPDF.split('/').pop());
    
    const res = await window.electronAPI.runNBLM({ command: 'inspect', args: [appState.selectedPDF] });
    if (res.success) {
        const data = JSON.parse(res.output);
        appState.totalPages = data.pages;
        if (document.getElementById('total-pages-display')) document.getElementById('total-pages-display').textContent = data.pages;
        updateSlider(15);
        switchView('structure');
    }
}

// --- INTERFACE ---

function updateSlider(val) {
    const v = parseInt(val);
    const d = document.getElementById('target-count-display'), t = document.getElementById('slider-track'), c = document.getElementById('calc-pages-display');
    if (d) d.textContent = v;
    if (t) t.style.width = `${((v - 1) / 49) * 100}%`;
    if (appState.totalPages > 0) {
        appState.calculatedTargetPages = (appState.totalPages / v).toFixed(3);
        if (c) c.textContent = appState.calculatedTargetPages;
    }
}

function handleTitleEdit() {
    const t = document.getElementById('current-chunk-title').textContent; const c = appState.chunks.find(ch => ch.id === appState.currentChunkId);
    if (c) { c.title = t; c.synced = false; const el = document.querySelector(`[data-chunk-id="${c.id}"] .title-preview`); if (el) el.textContent = `${c.id}: ${t}`; const dot = document.querySelector(`[data-chunk-id="${c.id}"] .status-dot`); if (dot) dot.className = "status-dot size-1.5 bg-blue-500 rounded-full"; handleEdit(); }
}

function handleEdit() {
    const chunk = appState.chunks.find(c => c.id === appState.currentChunkId);
    if (!chunk) return;
    if (chunk.synced) { chunk.synced = false; const dot = document.querySelector(`[data-chunk-id="${chunk.id}"] .status-dot`); if (dot) dot.className = "status-dot size-1.5 bg-blue-500 rounded-full"; }
    if (appState.saveTimeout) clearTimeout(appState.saveTimeout);
    appState.saveTimeout = setTimeout(async () => {
        const c = appState.chunks.find(ch => ch.id === appState.currentChunkId); if (!c) return;
        const content = Array.from(document.getElementById('markdown-content').querySelectorAll('p')).map(p => p.textContent).join('\n\n');
        await window.electronAPI.runNBLM({ command: 'internal-write-file', args: [c.path, content] });
        const manifest = appState.chunks.map(ch => ({ file: ch.filename, primary_heading: ch.title, word_count: 500, synced: ch.synced, source_id: ch.source_id }));
        await window.electronAPI.runNBLM({ command: 'internal-write-file', args: [`${appState.outputDir}/manifest.json`, JSON.stringify(manifest, null, 2)] });
    }, 1000);
}

async function runSync() {
    if (appState.isRunning) return;
    appState.isRunning = true;
    const btn = document.getElementById('start-sync-btn'); if (btn) { btn.disabled = true; btn.innerHTML = `Syncing...`; }
    try {
        await loadProjectMetadata();
        let args = [appState.outputDir, '--max-parallel-chunks', 5, '--rename-remote-titles', '--only-changed'];
        if (appState.activeNotebookId) args.push('--notebook-id', appState.activeNotebookId);
        else if (document.getElementById('new-notebook-title')?.value) {
            const title = document.getElementById('new-notebook-title').value;
            args.push('--notebook-title', title);
            appState.activeNotebookTitle = title;
        }
        const res = await window.electronAPI.runNBLM({ command: 'upload', args: args });
        const output = res.output || "";
        const idMatch = output.match(/Notebook ID:\s*([a-f0-9\-]+)/i);
        if (idMatch) { appState.activeNotebookId = idMatch[1].trim(); await saveProjectMetadata(); }
        if (output.includes('Uploaded sources') || output.includes('no files to process')) {
            appState.chunks.forEach(c => c.synced = true);
            const manifest = appState.chunks.map(ch => ({ file: ch.filename, primary_heading: ch.title, word_count: 500, synced: true, source_id: ch.source_id }));
            await window.electronAPI.runNBLM({ command: 'internal-write-file', args: [`${appState.outputDir}/manifest.json`, JSON.stringify(manifest, null, 2)] });
            alert("Sync Complete!");
            switchView('sync');
        }
    } finally { appState.isRunning = false; if (btn) { btn.disabled = false; btn.innerHTML = `Upload Changes`; } }
}

function handleSyncLog(t) {
    const m = t.match(/upload:.*?\s([^\s]+\.md)/);
    if (m) {
        const f = m[1];
        const item = document.querySelector(`[data-filename="${f}"]`);
        if (item) { const icon = item.querySelector('.material-symbols-outlined'); if (icon) { icon.className = "material-symbols-outlined text-primary animate-spin"; icon.textContent = "sync"; } }
    }
}

function deleteChunk(id) {
    if (!confirm("Are you sure?")) return;
    appState.chunks = appState.chunks.filter(c => c.id !== id);
    populateChunkList();
    const manifest = appState.chunks.map(ch => ({ file: ch.filename, primary_heading: ch.title, word_count: 500, synced: ch.synced, source_id: ch.source_id }));
    window.electronAPI.runNBLM({ command: 'internal-write-file', args: [`${appState.outputDir}/manifest.json`, JSON.stringify(manifest, null, 2)] });
}

function startNewProject() {
    appState.isResumeMode = false;
    appState.activeNotebookId = null;
    appState.activeNotebookTitle = null;
    appState.selectedPDF = null;
    appState.chunks = [];
    appState.totalPages = 0;
    resetSourceUI();
    const dup = document.getElementById('duplicate-state');
    if (dup) dup.style.display = 'none';
    switchView('source');
}

// --- BOOTSTRAP & GLOBALS ---

async function init() {
    try {
        appState.paths = await window.electronAPI.getAppPaths();
        await checkAuthStatus();
    } catch (e) {}
    window.electronAPI.onNBLMOutput((data) => {
        const text = data.data.trim();
        const logEl = document.getElementById('loading-log');
        if (logEl && appState.isRunning) logEl.textContent = text.replace(/^\d{2}:\d{2}:\d{2}\s+\[nblm\]\s+/, "").split('\n').pop();
        
        // Capture filename -> sourceId mapping: "upload: filename.md -> id (captured)"
        const idMatch = text.match(/upload:\s+([^\s]+\.md)\s+->\s+([a-f0-9\-]+)\s+\(captured\)/);
        if (idMatch) {
            const filename = idMatch[1];
            const sourceId = idMatch[2];
            const chunk = appState.chunks.find(c => c.filename === filename);
            if (chunk) { 
                chunk.source_id = sourceId; 
                chunk.synced = true; 
                console.log(`[App] Captured remote ID for ${filename}: ${sourceId}`);
            }
        }
        if (text.includes('upload:')) handleSyncLog(text);
    });
}

window.login = login;
window.confirmLogin = confirmLogin;
window.switchView = switchView;
window.startNewProject = startNewProject;
window.triggerFileSelect = async () => { const r = await window.electronAPI.selectPDF(); if (r && r.success) handleFileSelect(r.path, r.name); };
window.startStructurePhase = () => switchView('structure');
window.forceRefine = forceRefine;
window.resumeLocalProject = async (path) => { appState.isResumeMode = true; appState.outputDir = path; if (await loadRealChunks()) switchView('sources'); };
window.handleTitleEdit = handleTitleEdit;
window.handleEdit = handleEdit;
window.runSync = runSync;
window.fetchLocalProjects = fetchLocalProjects;
window.selectChunk = selectChunk;
window.updateSlider = updateSlider;
window.deleteChunk = deleteChunk;
window.resumeExistingPath = resumeExistingPath;
window.startNewVersion = startNewVersion;

init();
