// State
let selectedPDF = null;
let outputDir = './chunks';
let isRunning = false;

// DOM Elements
const views = {
  prepare: document.getElementById('prepare-view'),
  run: document.getElementById('run-view'),
  settings: document.getElementById('settings-view'),
  about: document.getElementById('about-view')
};

const navItems = document.querySelectorAll('.nav-item');
const selectPDFBtn = document.getElementById('select-pdf-btn');
const clearPDFBtn = document.getElementById('clear-pdf-btn');
const pdfInfo = document.getElementById('pdf-info');
const pdfName = document.getElementById('pdf-name');
const selectOutputBtn = document.getElementById('select-output-btn');
const outputPath = document.getElementById('output-path');
const runBtn = document.getElementById('run-btn');
const stopBtn = document.getElementById('stop-btn');
const backBtn = document.getElementById('back-btn');
const terminal = document.getElementById('terminal');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const cliStatus = document.getElementById('cli-status');

// Initialize
async function init() {
  // Get app version
  const version = await window.electronAPI.getVersion();
  document.getElementById('version').textContent = `v${version}`;
  document.getElementById('about-version').textContent = version;

  // Check CLI status
  checkCLIStatus();

  // Setup event listeners
  setupEventListeners();

  // Listen to nblm output
  window.electronAPI.onNBLMOutput((data) => {
    addTerminalLine(data.data, data.type === 'stderr' ? 'error' : '');
    
    // Update progress based on output
    updateProgress(data.data);
  });
}

// Check if nblm CLI is available
async function checkCLIStatus() {
  const result = await window.electronAPI.checkNBLM();
  
  if (result.available) {
    cliStatus.textContent = '✓ Available';
    cliStatus.classList.add('success');
  } else {
    cliStatus.textContent = '✗ Not Found';
    cliStatus.classList.add('error');
    showNotification('nblm CLI not found. Please install notebooklm-chunker first.', 'error');
  }
}

// Setup event listeners
function setupEventListeners() {
  // Navigation
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const viewName = item.dataset.view;
      switchView(viewName);
    });
  });

  // File selection
  selectPDFBtn.addEventListener('click', async () => {
    const result = await window.electronAPI.selectPDF();
    if (result.success) {
      selectedPDF = result.path;
      pdfName.textContent = result.name;
      pdfInfo.style.display = 'flex';
      selectPDFBtn.style.display = 'none';
      updateRunButton();
    }
  });

  clearPDFBtn.addEventListener('click', () => {
    selectedPDF = null;
    pdfInfo.style.display = 'none';
    selectPDFBtn.style.display = 'block';
    updateRunButton();
  });

  selectOutputBtn.addEventListener('click', async () => {
    const result = await window.electronAPI.selectOutputDir();
    if (result.success) {
      outputDir = result.path;
      outputPath.textContent = result.path;
    }
  });

  // Run workflow
  runBtn.addEventListener('click', runWorkflow);
  stopBtn.addEventListener('click', stopWorkflow);
  backBtn.addEventListener('click', () => switchView('prepare'));
}

// Switch view
function switchView(viewName) {
  // Update nav
  navItems.forEach(item => {
    if (item.dataset.view === viewName) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Update views
  Object.keys(views).forEach(key => {
    if (key === viewName) {
      views[key].classList.add('active');
    } else {
      views[key].classList.remove('active');
    }
  });
}

// Update run button state
function updateRunButton() {
  runBtn.disabled = !selectedPDF || isRunning;
}

// Run workflow
async function runWorkflow() {
  if (!selectedPDF) return;

  isRunning = true;
  updateRunButton();
  switchView('run');
  clearTerminal();
  setProgress(0, 'Starting workflow...');

  // Build config
  const config = buildConfig();

  try {
    addTerminalLine('Starting NotebookLM Chunker workflow...', 'success');
    
    const result = await window.electronAPI.runNBLM({
      command: 'run',
      args: ['--yes'],
      config: config
    });

    if (result.success) {
      setProgress(100, 'Workflow completed successfully!');
      addTerminalLine('✓ Workflow completed successfully!', 'success');
    }
  } catch (error) {
    setProgress(0, 'Workflow failed');
    addTerminalLine(`✗ Error: ${error.error || error.message}`, 'error');
  } finally {
    isRunning = false;
    updateRunButton();
  }
}

// Stop workflow
async function stopWorkflow() {
  const result = await window.electronAPI.stopNBLM();
  if (result.success) {
    addTerminalLine('Process stopped by user', 'error');
    setProgress(0, 'Stopped');
    isRunning = false;
    updateRunButton();
  }
}

// Build TOML config
function buildConfig() {
  const targetPages = document.getElementById('target-pages').value;
  const minPages = document.getElementById('min-pages').value;
  const maxPages = document.getElementById('max-pages').value;

  const enabledStudios = [];
  if (document.getElementById('studio-report').checked) enabledStudios.push('report');
  if (document.getElementById('studio-slides').checked) enabledStudios.push('slide_deck');
  if (document.getElementById('studio-quiz').checked) enabledStudios.push('quiz');
  if (document.getElementById('studio-audio').checked) enabledStudios.push('audio');

  return `
[source]
path = "${selectedPDF.replace(/\\/g, '\\\\')}"

[chunking]
output_dir = "${outputDir.replace(/\\/g, '\\\\')}"
target_pages = ${targetPages}
min_pages = ${minPages}
max_pages = ${maxPages}

[runtime]
download_outputs = true

${enabledStudios.map(studio => `
[studios.${studio}]
enabled = true
per_chunk = true
`).join('\n')}
`;
}

// Terminal functions
function addTerminalLine(text, className = '') {
  const line = document.createElement('div');
  line.className = `terminal-line ${className}`;
  line.textContent = text;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

function clearTerminal() {
  terminal.innerHTML = '';
}

// Progress functions
function setProgress(percent, text) {
  progressFill.style.width = `${percent}%`;
  progressText.textContent = text;
}

function updateProgress(output) {
  // Simple progress detection based on output
  if (output.includes('Parsing')) {
    setProgress(10, 'Parsing document...');
  } else if (output.includes('chunk')) {
    setProgress(30, 'Creating chunks...');
  } else if (output.includes('upload')) {
    setProgress(50, 'Uploading to NotebookLM...');
  } else if (output.includes('studio') || output.includes('Studio')) {
    setProgress(70, 'Generating Studio outputs...');
  } else if (output.includes('completed') || output.includes('done')) {
    setProgress(100, 'Completed!');
  }
}

// Notification
function showNotification(message, type = 'info') {
  // Simple console log for now
  console.log(`[${type}] ${message}`);
}

// Initialize app
init();
