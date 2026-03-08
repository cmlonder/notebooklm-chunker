// State Management
let appState = {
    isAuthenticated: false,
    currentView: 'auth',
    selectedPDF: null,
    outputDir: null,
    chunks: [],
    isRunning: false,
    totalPages: 0,
    calculatedTargetPages: 3.0
};

let authPollingInterval = null;

// DOM Elements
const elements = {
    header: document.getElementById('master-header'),
    authView: document.getElementById('auth-view'),
    sourceView: document.getElementById('source-view'),
    loginBtn: document.getElementById('login-btn'),
    navLinks: document.querySelectorAll('nav a')
};

// --- Initialization ---
async function init() {
    setupEventListeners();
    checkAuthStatus();
    
    window.electronAPI.onNBLMOutput((data) => {
        const text = data.data.trim();
        const logMsg = document.getElementById('loading-log');
        const progressBar = document.getElementById('progress-bar-fill');
        const progressPercent = document.getElementById('progress-percent');

        if (logMsg && appState.isRunning) logMsg.textContent = text.replace(/^\d{2}:\d{2}:\d{2}\s+\[nblm\]\s+/, "").split('\n').pop();

        // Capture total pages: "100 page(s)"
        const pageMatch = text.match(/(\d+)\s+page\(s\)/);
        if (pageMatch) {
            updatePageMetadata(parseInt(pageMatch[1]));
        }

        // Capture progress: "1/105"
        const progressMatch = text.match(/(\d+)\/(\d+)/);
        if (progressMatch && appState.isRunning) {
            const current = parseInt(progressMatch[1]);
            const total = parseInt(progressMatch[2]);
            if (progressBar) {
                const percent = Math.round((current / total) * 100);
                progressBar.style.width = `${percent}%`;
                if (progressPercent) progressPercent.textContent = `${percent}%`;
            }
        }
        if (text.includes('upload:') && appState.currentView === 'sync') handleSyncLog(text);
    });
}

function updatePageMetadata(total) {
    if (!total || total === appState.totalPages) return;
    console.log("[App] Metadata: Document has", total, "pages.");
    appState.totalPages = total;
    const totalDisplay = document.getElementById('total-pages-display');
    if (totalDisplay) totalDisplay.textContent = total;
    const slider = document.getElementById('target-count-slider');
    if (slider) updateChunkCalculations(slider.value);
}

function setupEventListeners() {
    if (elements.loginBtn) {
        elements.loginBtn.addEventListener('click', async () => {
            if (appState.isAuthenticated) return;
            elements.loginBtn.disabled = true;
            elements.loginBtn.innerHTML = `Opening Browser...`;
            window.electronAPI.runNBLM({ command: 'login', args: [] });
            startAuthPolling();
        });
    }

    const dropZone = document.getElementById('drop-zone');
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('border-primary/50', 'bg-primary/5'); });
        dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('border-primary/50', 'bg-primary/5'); });
        dropZone.addEventListener('drop', async (e) => {
            e.preventDefault();
            dropZone.classList.remove('border-primary/50', 'bg-primary/5');
            const file = e.dataTransfer.files[0];
            if (file && file.name.toLowerCase().endsWith('.pdf')) handleFileSelect(file.path, file.name);
        });
        dropZone.addEventListener('click', async () => {
            const result = await window.electronAPI.selectPDF();
            if (result.success) handleFileSelect(result.path, result.name);
        });
    }
    setupStructureListeners();
}

// --- Auth ---
function startAuthPolling() {
    if (authPollingInterval) return;
    authPollingInterval = setInterval(checkAuthStatus, 3000);
}

async function checkAuthStatus() {
    try {
        const result = await window.electronAPI.runNBLM({ command: 'doctor', args: [] });
        const combined = (result.output || "") + (result.error || "");
        if (combined.includes('OK   auth')) { onLoginSuccess(); return true; }
    } catch (err) {}
    return false;
}

function onLoginSuccess() {
    if (authPollingInterval) { clearInterval(authPollingInterval); authPollingInterval = null; }
    if (appState.isAuthenticated) return;
    appState.isAuthenticated = true;
    elements.authView.classList.add('hidden');
    elements.header.classList.remove('hidden');
    elements.header.classList.add('flex');
    switchView('source');
}

// --- Source ---
function handleFileSelect(path, name) {
    appState.selectedPDF = path;
    appState.outputDir = path.replace('.pdf', '-chunks');
    appState.chunks = [];
    appState.totalPages = 0;
    const dropZone = document.getElementById('drop-zone');
    const selectedState = document.getElementById('selected-state');
    const fileNameEl = document.getElementById('selected-file-name');
    if (dropZone && selectedState && fileNameEl) {
        dropZone.classList.add('hidden');
        selectedState.classList.remove('hidden');
        selectedState.classList.add('flex');
        fileNameEl.textContent = name;
    }
}

// --- Structure ---
function setupStructureListeners() {
    const slider = document.getElementById('target-count-slider');
    const display = document.getElementById('target-count-display');
    const track = document.getElementById('slider-track');
    if (slider) {
        slider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            display.textContent = val;
            const min = parseFloat(slider.min) || 1;
            const max = parseFloat(slider.max) || 50;
            const percent = ((val - min) / (max - min)) * 100;
            track.style.width = `${percent}%`;
            updateChunkCalculations(val);
        });
    }
}

function updateChunkCalculations(chunkCount) {
    const calcDisplay = document.getElementById('calc-pages-display');
    if (!calcDisplay) return;
    if (appState.totalPages > 0) {
        appState.calculatedTargetPages = (appState.totalPages / chunkCount).toFixed(2);
        calcDisplay.textContent = appState.calculatedTargetPages;
        const minEl = document.getElementById('min-pages');
        const maxEl = document.getElementById('max-pages');
        if (minEl) minEl.value = Math.max(0.1, (appState.calculatedTargetPages * 0.5)).toFixed(1);
        if (maxEl) maxEl.value = (appState.calculatedTargetPages * 2.5).toFixed(1);
    } else {
        calcDisplay.textContent = "?";
    }
}

async function runPrepare() {
    if (!appState.selectedPDF) return false;
    appState.isRunning = true;
    showLoadingOverlay("Optimizing document structure...");

    const getValue = (id, def) => document.getElementById(id) ? document.getElementById(id).value : def;
    const skipRangesRaw = getValue('skip-ranges', '');
    const minPages = getValue('min-pages', '0.5');
    const maxPages = getValue('max-pages', '20.0');
    const wordsPerPage = getValue('words-per-page', '500');
    const skipRanges = skipRangesRaw.split(',').map(r => r.trim()).filter(r => r.length > 0).map(r => `"${r}"`).join(', ');

    let config = `[source]\npath = "${appState.selectedPDF.replace(/\\/g, '\\\\')}"\n${skipRanges ? `skip_ranges = [${skipRanges}]` : ''}\n\n[chunking]\noutput_dir = "${appState.outputDir.replace(/\\/g, '\\\\')}"\nwords_per_page = ${wordsPerPage}\ntarget_pages = ${appState.calculatedTargetPages}\nmin_pages = ${minPages}\nmax_pages = ${maxPages}`;

    try {
        console.log("[App] Executing nblm prepare...");
        const result = await window.electronAPI.runNBLM({ command: 'prepare', args: ['--yes'], config: config });
        const combined = (result.output || "") + (result.error || "");
        
        if (combined.includes('Chunks generated')) {
            console.log("[App] Success detected. Loading chunks...");
            // Dosyaların diske tam yazılması için minik bir bekleme
            await new Promise(r => setTimeout(r, 500));
            return await loadRealChunks();
        } else {
            console.error("[App] Prepare failed. CLI Output:", combined);
            alert("Chunking failed. Check terminal for details.");
            return false;
        }
    } catch (err) { 
        console.error("[App] Prepare Exception:", err);
        return false; 
    }
    finally { appState.isRunning = false; hideLoadingOverlay(); }
}

async function loadRealChunks() {
    const manifestPath = `${appState.outputDir}/manifest.json`;
    console.log("[App] Reading manifest from:", manifestPath);
    try {
        const result = await window.electronAPI.readFile(manifestPath);
        if (result.success) {
            const manifest = JSON.parse(result.content);
            // Manifest doğrudan bir liste olduğu için direkt map ediyoruz
            appState.chunks = manifest.map((item, index) => ({
                id: index + 1,
                title: item.primary_heading || `Chunk ${index + 1}`,
                words: item.word_count,
                path: `${appState.outputDir}/${item.file}`
            }));
            console.log("[App] Chunks loaded successfully:", appState.chunks.length);
            return true;
        } else {
            console.error("[App] Read file failed:", result.error);
            return false;
        }
    } catch (err) { 
        console.error("[App] loadRealChunks Exception:", err);
        return false; 
    }
}

function populateChunkList() {
    const list = document.getElementById('chunk-list');
    if (!list) return;
    if (appState.chunks.length === 0) {
        list.innerHTML = `<p class="text-slate-400 p-4 text-center text-sm italic">No chunks found. Try refining again.</p>`;
        return;
    }
    list.innerHTML = appState.chunks.map(chunk => `
        <div data-chunk-id="${chunk.id}" class="chunk-item p-3 rounded-lg hover:bg-slate-50 border border-transparent cursor-pointer transition-all group text-left">
            <h4 class="text-sm font-semibold text-slate-700 truncate mb-1">${chunk.id}: ${chunk.title}</h4>
            <div class="flex items-center gap-2 text-[10px] font-medium text-slate-400"><span class="material-symbols-outlined !text-xs">description</span><span>${chunk.words} words</span></div>
        </div>
    `).join('');
    list.querySelectorAll('.chunk-item').forEach(item => item.addEventListener('click', () => selectChunk(parseInt(item.dataset.chunkId))));
    if (appState.chunks.length > 0) selectChunk(1);
}

async function selectChunk(id) {
    const chunk = appState.chunks.find(c => c.id === id);
    if (!chunk) return;
    document.querySelectorAll('.chunk-item').forEach(item => {
        item.className = (parseInt(item.dataset.chunkId) === id) ? "chunk-item p-3 rounded-lg bg-primary/10 border border-primary/20 cursor-pointer relative group text-left" : "chunk-item p-3 rounded-lg hover:bg-slate-50 border border-transparent cursor-pointer transition-all group text-left";
    });
    document.getElementById('current-chunk-title').textContent = `Chunk ${chunk.id}: ${chunk.title}`;
    const contentResult = await window.electronAPI.readFile(chunk.path);
    if (contentResult.success) {
        document.getElementById('markdown-content').innerHTML = contentResult.content.split('\n\n').map(p => `<p class="text-lg leading-relaxed text-slate-700 mb-6">${p}</p>`).join('');
    }
}

function prepareSyncView() {
    const list = document.getElementById('sync-chunk-list');
    const countTotal = document.getElementById('sync-count-total');
    if (!list) return;
    countTotal.textContent = appState.chunks.length;
    list.innerHTML = appState.chunks.map(chunk => `
        <div id="sync-item-${chunk.id}" class="px-6 py-4 flex items-center justify-between hover:bg-slate-50/50 transition-colors">
            <div class="flex items-center gap-4 overflow-hidden">
                <div class="relative flex-shrink-0 status-icon">
                    <svg class="w-10 h-10 -rotate-90"><circle class="text-slate-100" cx="20" cy="20" fill="transparent" r="18" stroke="currentColor" stroke-width="3"></circle><circle class="progress-ring text-primary opacity-0" cx="20" cy="20" fill="transparent" r="18" stroke="currentColor" stroke-dasharray="113.1" stroke-dashoffset="113.1" stroke-width="3"></circle></svg>
                    <div class="absolute inset-0 flex items-center justify-center"><span class="material-symbols-outlined text-[16px] text-slate-400 status-symbol">schedule</span></div>
                </div>
                <div class="truncate text-left"><p class="text-sm font-medium truncate text-slate-900">${chunk.title}</p><p class="text-xs text-slate-400">Chunk #${chunk.id} • ${chunk.words} words</p></div>
            </div>
            <span class="status-text text-xs font-semibold text-slate-400 uppercase">Waiting</span>
        </div>
    `).join('');
}

async function runSync() {
    if (appState.isRunning || appState.chunks.length === 0) return;
    const notebookId = document.getElementById('notebook-selector').value;
    const notebookTitle = document.getElementById('new-notebook-title').value;
    const startBtn = document.getElementById('start-sync-btn');
    appState.isRunning = true;
    startBtn.disabled = true;
    startBtn.innerHTML = `Syncing...`;
    const config = `[source]\npath = "${appState.selectedPDF.replace(/\\/g, '\\\\')}"\n[notebook]\n${notebookId ? `id = "${notebookId}"` : `title = "${notebookTitle || 'Untitled Notebook'}"`}\n[chunking]\noutput_dir = "${appState.outputDir.replace(/\\/g, '\\\\')}"`;
    try {
        await window.electronAPI.runNBLM({ command: 'sync', args: ['--yes'], config: config });
        alert("Sync completed!");
    } catch (err) {}
    finally { appState.isRunning = false; startBtn.disabled = false; startBtn.innerHTML = `Upload to NotebookLM`; }
}

function handleSyncLog(text) {
    const match = text.match(/upload:\s+(\d+)\/(\d+)\s+([^\s]+)\s+->\s+(\w+)/);
    if (match) {
        const currentId = parseInt(match[1]);
        const status = match[4];
        const item = document.getElementById(`sync-item-${currentId}`);
        if (!item) return;
        const ring = item.querySelector('.progress-ring');
        const symbol = item.querySelector('.status-symbol');
        const textEl = item.querySelector('.status-text');
        if (status === 'DONE') {
            ring.classList.remove('opacity-0'); ring.classList.add('text-green-500'); ring.style.strokeDashoffset = "0";
            symbol.textContent = "check"; symbol.className = "material-symbols-outlined text-[16px] text-green-600 status-symbol";
            textEl.textContent = "DONE"; textEl.className = "status-text text-xs font-semibold text-green-500 uppercase";
        } else {
            ring.classList.remove('opacity-0'); ring.style.strokeDashoffset = "40";
            symbol.textContent = "sync"; symbol.classList.add('animate-spin');
            textEl.textContent = "UPLOADING"; textEl.className = "status-text text-xs font-bold text-primary uppercase";
        }
    }
}

function showLoadingOverlay(msg) {
    let overlay = document.getElementById('loading-overlay');
    if (!overlay) {
        overlay = document.createElement('div'); overlay.id = 'loading-overlay';
        overlay.className = "fixed inset-0 z-[100] flex flex-col items-center justify-center bg-white/95 backdrop-blur-md fade-in";
        overlay.innerHTML = `<div class="flex flex-col items-center gap-8 w-full max-w-sm text-center px-6"><div class="space-y-2 w-full"><p class="text-2xl font-bold text-slate-900 tracking-tight">${msg}</p><p id="loading-log" class="text-sm font-medium text-slate-400 truncate text-center w-full">Initializing engine...</p></div><div class="w-full space-y-3"><div class="h-2 w-full bg-slate-100 rounded-full overflow-hidden"><div id="progress-bar-fill" class="h-full bg-primary transition-all duration-300 w-0"></div></div><p id="progress-percent" class="text-xs font-bold text-primary uppercase tracking-widest text-center">0%</p></div></div>`;
        document.body.appendChild(overlay);
    } else {
        overlay.classList.remove('hidden'); overlay.classList.add('flex');
        document.getElementById('progress-bar-fill').style.width = '0%'; document.getElementById('progress-percent').textContent = '0%';
    }
}

function hideLoadingOverlay() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) { overlay.classList.remove('flex'); overlay.classList.add('hidden'); }
}

window.switchView = async function(viewName) {
    if (!appState.isAuthenticated && viewName !== 'auth') return;
    
    console.log(`[App] Switching to view: ${viewName}`);

    const updateUI = () => {
        elements.navLinks.forEach(link => {
            const isSelected = link.getAttribute('data-nav') === viewName;
            link.className = isSelected ? "px-4 py-1.5 rounded-lg bg-white shadow-sm text-sm font-semibold text-primary cursor-pointer" : "px-4 py-1.5 rounded-lg text-sm font-medium text-slate-500 hover:text-slate-900 cursor-pointer";
        });
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active', 'flex'));
        const target = document.getElementById(`${viewName}-view`);
        if (target) {
            target.classList.add('active', 'flex');
            if (viewName === 'refinement') populateChunkList();
            if (viewName === 'sync') prepareSyncView();
        }
        appState.currentView = viewName;
    };

    if (viewName === 'refinement' && appState.chunks.length === 0) {
        const success = await runPrepare();
        if (success) {
            updateUI();
        } else {
            console.error("[App] Transition cancelled due to prepare failure.");
        }
    } else {
        updateUI();
    }
};

init();
