const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let pythonProcess = null;
const STUDIO_QUEUE_BASENAME = '.desktop-studio-queue.json';
const DESKTOP_STUDIO_MAX_PARALLEL = 3;
const studioQueueWorkers = new Map();
// Auto-resume timers for quota-blocked studio types, keyed by
// `${projectPath}::${studioName}` so a blocked `report` never touches `quiz`.
const studioQuotaResumeTimers = new Map();
// Projects whose queue has had a job actually spawn and has not yet drained.
// Used to fire a single "queue finished" notification per batch.
const studioQueueActiveProjects = new Set();
// setTimeout tops out around 24.8 days; a quota block is ~24h out, but if the
// machine sleeps we re-check on wake, so clamp the wait and re-arm if needed.
const STUDIO_QUOTA_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
let resolvedShellPath = process.env.PATH || '';

function resolveShellPath() {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    const proc = spawn(shell, ['-ilc', 'echo __PATH__=$PATH'], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.on('close', () => {
      const match = stdout.match(/__PATH__=(.+)/);
      if (match) {
        resolvedShellPath = match[1].trim();
      }
      resolve(resolvedShellPath);
    });
    proc.on('error', () => resolve(resolvedShellPath));
    setTimeout(() => { try { proc.kill(); } catch (e) {} resolve(resolvedShellPath); }, 5000);
  });
}

function projectsRoot() {
  const projectsPath = path.join(app.getPath('documents'), 'NotebookLM-Chunker');
  if (!fs.existsSync(projectsPath)) {
    fs.mkdirSync(projectsPath, { recursive: true });
  }
  return projectsPath;
}

function queueFilePath(projectPath) {
  return path.join(projectPath, STUDIO_QUEUE_BASENAME);
}

function nowIso() {
  return new Date().toISOString();
}

// --- Native notifications -------------------------------------------------

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showNativeNotification(title, body) {
  try {
    if (!Notification || !Notification.isSupported || !Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    notification.on('click', focusMainWindow);
    notification.show();
  } catch (error) {
    // Notifications are best-effort; never let them break the queue.
  }
}

// --- Quota block helpers --------------------------------------------------

function studioTypeLabel(studioName) {
  return String(studioName || 'studio').replace(/_/g, ' ');
}

function formatRetryClock(iso) {
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return 'later';
  try {
    return new Date(target).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (error) {
    return iso;
  }
}

function studioBlockActive(iso) {
  const target = Date.parse(iso);
  return Number.isFinite(target) && target > Date.now();
}

// The `nblm studios` CLI emits the reset time inline on quota exhaustion, e.g.
//   `studio: quota exhausted report [001-intro.md] -> 2026-07-18T09:00:00Z`
//   `studio: suspending remaining report jobs until 2026-07-18T09:00:00Z`
// and, at run end, `... quota appears exhausted ... after <ISO>`.
function parseStudioBlockedUntil(output) {
  const text = String(output || '');
  const patterns = [
    /studio:\s*quota exhausted[^\n]*->\s*([0-9][0-9T:.+\-]*Z?)/i,
    /studio:\s*suspending remaining[^\n]*until\s+([0-9][0-9T:.+\-]*Z?)/i,
    /quota appears exhausted[^\n]*?(?:after|until)\s+([0-9][0-9T:.+\-]*Z?)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && Number.isFinite(Date.parse(match[1]))) {
      return match[1];
    }
  }
  return null;
}

function quotaTimerKey(projectPath, studioName) {
  return `${projectPath}::${studioName}`;
}

function cancelStudioQuotaTimer(projectPath, studioName) {
  const key = quotaTimerKey(projectPath, studioName);
  const timer = studioQuotaResumeTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    studioQuotaResumeTimers.delete(key);
  }
}

function scheduleQuotaResume(projectPath, studioName, blockedUntil) {
  cancelStudioQuotaTimer(projectPath, studioName);
  const target = Date.parse(blockedUntil);
  if (!Number.isFinite(target)) return;
  // Wake a few seconds after the block is expected to lift, and re-check.
  let delay = target + 3000 - Date.now();
  if (delay < 0) delay = 0;
  const wait = Math.min(delay, STUDIO_QUOTA_MAX_WAIT_MS);
  const timer = setTimeout(() => {
    studioQuotaResumeTimers.delete(quotaTimerKey(projectPath, studioName));
    onQuotaResumeWake(projectPath, studioName);
  }, wait);
  if (typeof timer.unref === 'function') timer.unref();
  studioQuotaResumeTimers.set(quotaTimerKey(projectPath, studioName), timer);
}

function onQuotaResumeWake(projectPath, studioName) {
  const state = readStudioQueueState(projectPath);
  const blockedUntil = state.quotaBlocks ? state.quotaBlocks[studioName] : null;
  if (blockedUntil && studioBlockActive(blockedUntil)) {
    // Woke early (clock skew or the max-wait clamp) — re-arm for the remainder.
    scheduleQuotaResume(projectPath, studioName, blockedUntil);
    return;
  }
  clearStudioQuotaBlock(projectPath, studioName, 'Quota window elapsed — retrying');
}

// Lift the block for a studio type and re-queue its blocked jobs.
function clearStudioQuotaBlock(projectPath, studioName, message) {
  cancelStudioQuotaTimer(projectPath, studioName);
  const state = readStudioQueueState(projectPath);
  if (state.quotaBlocks && state.quotaBlocks[studioName]) {
    delete state.quotaBlocks[studioName];
  }
  let changed = false;
  state.jobs = state.jobs.map((job) => {
    if (job.studioName === studioName && job.status === 'blocked') {
      changed = true;
      return {
        ...job,
        status: 'queued',
        progress: 8,
        blockedUntil: null,
        message: message || 'Queued for retry',
        updatedAt: nowIso(),
      };
    }
    return job;
  });
  writeStudioQueueState(projectPath, state);
  if (changed) {
    for (let index = 0; index < DESKTOP_STUDIO_MAX_PARALLEL; index += 1) {
      runNextStudioJob(projectPath);
    }
  }
}

// Record a fresh quota block hit by a job: persist the reset time, park the job
// in the `blocked` state, schedule auto-resume, and notify on the first hit.
function recordStudioQuotaBlock(projectPath, jobId, studioName, blockedUntil) {
  const state = readStudioQueueState(projectPath);
  const alreadyBlocked = Boolean(
    state.quotaBlocks &&
      state.quotaBlocks[studioName] &&
      studioBlockActive(state.quotaBlocks[studioName]),
  );
  state.quotaBlocks = { ...(state.quotaBlocks || {}), [studioName]: blockedUntil };
  state.jobs = state.jobs.map((job) => {
    if (job.id !== jobId) return job;
    return {
      ...job,
      status: 'blocked',
      progress: 100,
      blockedUntil,
      message: `Quota exhausted — auto-retry after ${formatRetryClock(blockedUntil)}`,
      updatedAt: nowIso(),
    };
  });
  writeStudioQueueState(projectPath, state);
  scheduleQuotaResume(projectPath, studioName, blockedUntil);
  if (!alreadyBlocked) {
    showNativeNotification(
      'Studio quota reached',
      `${studioTypeLabel(studioName)} is paused. Auto-retry after ${formatRetryClock(blockedUntil)}.`,
    );
  }
}

function notifyStudioJobFailed(job, detail) {
  const label = job.displayLabel || job.label || studioTypeLabel(job.studioName);
  showNativeNotification('Studio job failed', detail ? `${label} — ${detail}` : label);
}

// Fire a single summary notification once a project's queue fully drains.
function maybeNotifyQueueDrained(projectPath) {
  if (activeStudioWorkers(projectPath) > 0) return;
  const state = readStudioQueueState(projectPath);
  const hasPending = state.jobs.some(
    (job) => job.status === 'queued' || job.status === 'running' || job.status === 'blocked',
  );
  if (hasPending) return;
  if (!studioQueueActiveProjects.has(projectPath)) return;
  studioQueueActiveProjects.delete(projectPath);
  const submitted = state.jobs.filter((job) => job.status === 'submitted').length;
  const failed = state.jobs.filter((job) => job.status === 'failed').length;
  const parts = [];
  if (submitted) parts.push(`${submitted} submitted`);
  if (failed) parts.push(`${failed} failed`);
  showNativeNotification(
    'Studio queue finished',
    parts.length ? parts.join(', ') : 'All Studio jobs processed.',
  );
}

function defaultStudioQueueState() {
  return { version: 1, updatedAt: nowIso(), jobs: [], quotaBlocks: {} };
}

function readStudioQueueState(projectPath) {
  const filePath = queueFilePath(projectPath);
  if (!fs.existsSync(filePath)) return defaultStudioQueueState();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const jobs = Array.isArray(parsed.jobs)
      ? parsed.jobs.map((job) => {
          if (job && (job.status === 'submitted' || job.status === 'processing' || job.status === 'completed')) {
            return {
              ...job,
              status: 'submitted',
              progress: 100,
              message: 'Submitted to NotebookLM. Track completion from the Studios tab.',
            };
          }
          return job;
        })
      : [];
    return {
      version: 1,
      updatedAt: parsed.updatedAt || nowIso(),
      jobs,
      quotaBlocks:
        parsed.quotaBlocks && typeof parsed.quotaBlocks === 'object' ? parsed.quotaBlocks : {},
    };
  } catch (error) {
    return defaultStudioQueueState();
  }
}

function writeStudioQueueState(projectPath, state) {
  const next = {
    version: 1,
    updatedAt: nowIso(),
    jobs: Array.isArray(state.jobs) ? state.jobs : [],
    quotaBlocks:
      state.quotaBlocks && typeof state.quotaBlocks === 'object' ? state.quotaBlocks : {},
  };
  fs.writeFileSync(queueFilePath(projectPath), `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('studio-queue-update', { projectPath, queue: next });
  }
  return next;
}

function updateStudioQueueJob(projectPath, jobId, updates) {
  const state = readStudioQueueState(projectPath);
  state.jobs = state.jobs.map((job) => job.id === jobId ? { ...job, ...updates, updatedAt: nowIso() } : job);
  return writeStudioQueueState(projectPath, state);
}

function appendStudioQueueLog(projectPath, jobId, channel, text) {
  const state = readStudioQueueState(projectPath);
  state.jobs = state.jobs.map((job) => {
    if (job.id !== jobId) return job;
    const existing = Array.isArray(job.logs) ? job.logs : [];
    const lines = String(text || '')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => ({
        at: nowIso(),
        channel,
        line,
      }));
    return {
      ...job,
      logs: [...existing, ...lines].slice(-30),
      updatedAt: nowIso(),
    };
  });
  return writeStudioQueueState(projectPath, state);
}

// The account/profile the whole app operates on. Set from the renderer so
// every `nblm` spawn (login, sync, studios, listings) targets one account and
// they never cross-contaminate.
let activeProfile = null;

function buildNblmEnv() {
  const projectRoot = path.resolve(__dirname, '../..');
  const venvBin = path.join(projectRoot, '.venv/bin');
  const basePath = resolvedShellPath || process.env.PATH || '';
  const pathParts = fs.existsSync(venvBin) ? [venvBin, basePath] : [basePath];
  const env = {
    ...process.env,
    PYTHONPATH: projectRoot,
    PATH: pathParts.join(path.delimiter),
  };
  if (activeProfile) {
    env.NOTEBOOKLM_PROFILE = activeProfile;
  } else {
    delete env.NOTEBOOKLM_PROFILE;
  }
  return env;
}

let cachedNblmBinary = null;

// Prefer the bundled PyInstaller sidecar so end users do not need a Python
// install; fall back to `nblm` on PATH (dev setups, power users).
function nblmBinary() {
  if (cachedNblmBinary) return cachedNblmBinary;
  const exeName = process.platform === 'win32' ? 'nblm.exe' : 'nblm';
  const candidates = [
    // onedir layout: sidecar/nblm/<exe> next to its _internal directory
    path.join(process.resourcesPath || '', 'sidecar', 'nblm', exeName),
    path.resolve(__dirname, '../sidecar/dist/nblm', exeName),
    // legacy onefile layout
    path.join(process.resourcesPath || '', 'sidecar', exeName),
    path.resolve(__dirname, '../sidecar/dist', exeName),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        cachedNblmBinary = candidate;
        return cachedNblmBinary;
      }
    } catch (e) {}
  }
  cachedNblmBinary = 'nblm';
  return cachedNblmBinary;
}

function activeStudioWorkers(projectPath) {
  return studioQueueWorkers.get(projectPath) || 0;
}

function setActiveStudioWorkers(projectPath, count) {
  if (count <= 0) {
    studioQueueWorkers.delete(projectPath);
    return;
  }
  studioQueueWorkers.set(projectPath, count);
}

function runNextStudioJob(projectPath) {
  if (activeStudioWorkers(projectPath) >= DESKTOP_STUDIO_MAX_PARALLEL) return;
  const state = readStudioQueueState(projectPath);
  const quotaBlocks = state.quotaBlocks || {};
  // Park any queued job whose studio type is still quota-blocked so we do not
  // hammer NotebookLM and immediately re-fail. It shows a countdown instead and
  // auto-resumes once the block lifts. Other studio types keep flowing.
  let parked = false;
  const parkedTypes = new Set();
  state.jobs = state.jobs.map((job) => {
    if (job.status !== 'queued') return job;
    const iso = quotaBlocks[job.studioName];
    if (iso && studioBlockActive(iso)) {
      parked = true;
      parkedTypes.add(job.studioName);
      return {
        ...job,
        status: 'blocked',
        progress: 100,
        blockedUntil: iso,
        message: `Quota exhausted — auto-retry after ${formatRetryClock(iso)}`,
        updatedAt: nowIso(),
      };
    }
    return job;
  });
  if (parked) {
    writeStudioQueueState(projectPath, state);
    for (const studioName of parkedTypes) {
      scheduleQuotaResume(projectPath, studioName, quotaBlocks[studioName]);
    }
  }
  const nextJob = state.jobs.find((job) => job.status === 'queued');
  if (!nextJob) return;
  setActiveStudioWorkers(projectPath, activeStudioWorkers(projectPath) + 1);
  studioQueueActiveProjects.add(projectPath);
  const tempConfigPath = path.join(app.getPath('temp'), `nblm-studio-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.toml`);
  fs.writeFileSync(tempConfigPath, nextJob.configToml, 'utf-8');
  const proc = spawn(nblmBinary(), ['studios', ...nextJob.args, '--config', tempConfigPath], {
    env: buildNblmEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  updateStudioQueueJob(projectPath, nextJob.id, {
    status: 'running',
    progress: 12,
    message: 'Studio generation started',
  });

  const handleOutput = (channel) => (chunk) => {
    const text = chunk.toString();
    appendStudioQueueLog(projectPath, nextJob.id, channel, text);
    const prefix = `[studio queue ${nextJob.displayLabel || nextJob.label || nextJob.id} ${channel}] `;
    if (channel === 'stderr') {
      process.stderr.write(`${prefix}${text}`);
    } else {
      process.stdout.write(`${prefix}${text}`);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('nblm-output', { type: channel, data: `${prefix}${text}` });
    }
    const lines = text.trim().split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1] || 'Running';
    const progress = lastLine.includes('studio: start')
      ? 24
      : lastLine.includes('studio: pending')
      ? 48
      : lastLine.includes('studio: done')
      ? 96
      : undefined;
    updateStudioQueueJob(projectPath, nextJob.id, {
      message: lastLine,
      ...(typeof progress === 'number' ? { progress } : {}),
    });
  };

  let combinedOutput = '';
  const captureAndHandle = (channel) => (chunk) => {
    combinedOutput += chunk.toString();
    handleOutput(channel)(chunk);
  };
  proc.stdout.on('data', captureAndHandle('stdout'));
  proc.stderr.on('data', captureAndHandle('stderr'));
  proc.on('close', (code) => {
    try {
      if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
    } catch (error) {}
    setActiveStudioWorkers(projectPath, activeStudioWorkers(projectPath) - 1);
    const quotaExhausted = /quota.exhausted/i.test(combinedOutput) || /quota appears exhausted/i.test(combinedOutput);
    const zeroGenerated = /Generated studios:\s*0/i.test(combinedOutput);
    const blockedUntil = quotaExhausted ? parseStudioBlockedUntil(combinedOutput) : null;
    if (code === 0 && quotaExhausted && blockedUntil && studioBlockActive(blockedUntil)) {
      // Known reset time: park + auto-resume (with a live countdown in the UI).
      recordStudioQuotaBlock(projectPath, nextJob.id, nextJob.studioName, blockedUntil);
    } else if (code === 0 && (quotaExhausted || zeroGenerated)) {
      // No usable reset time — fall back to the manual "Retry" behavior.
      const reason = quotaExhausted ? 'Quota exhausted' : 'No studios generated';
      updateStudioQueueJob(projectPath, nextJob.id, {
        status: 'failed',
        progress: 100,
        message: `${reason} — retry later`,
      });
      notifyStudioJobFailed(nextJob, reason);
    } else if (code === 0) {
      updateStudioQueueJob(projectPath, nextJob.id, {
        status: 'submitted',
        progress: 100,
        message: 'Submitted to NotebookLM. Track completion from the Studios tab.',
      });
    } else {
      updateStudioQueueJob(projectPath, nextJob.id, {
        status: 'failed',
        progress: 100,
        message: `Failed (exit ${code})`,
      });
      notifyStudioJobFailed(nextJob, `Exited with code ${code}`);
    }
    runNextStudioJob(projectPath);
    runNextStudioJob(projectPath);
    maybeNotifyQueueDrained(projectPath);
  });
  proc.on('error', (error) => {
    try {
      if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
    } catch (cleanupError) {}
    setActiveStudioWorkers(projectPath, activeStudioWorkers(projectPath) - 1);
    updateStudioQueueJob(projectPath, nextJob.id, {
      status: 'failed',
      progress: 100,
      message: error.message,
    });
    notifyStudioJobFailed(nextJob, error.message);
    runNextStudioJob(projectPath);
    runNextStudioJob(projectPath);
    maybeNotifyQueueDrained(projectPath);
  });
}

function enqueueStudioJobs(projectPath, jobs) {
  const state = readStudioQueueState(projectPath);
  const stamped = jobs.map((job) => ({
    ...job,
    status: 'queued',
    progress: 8,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    message: 'Queued',
  }));
  state.jobs.push(...stamped);
  const nextState = writeStudioQueueState(projectPath, state);
  for (let index = 0; index < DESKTOP_STUDIO_MAX_PARALLEL; index += 1) {
    runNextStudioJob(projectPath);
  }
  return nextState;
}

function resumeStudioQueues() {
  const root = projectsRoot();
  const items = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const item of items) {
    const projectPath = path.join(root, item.name);
    const state = readStudioQueueState(projectPath);
    let changed = false;
    state.jobs = state.jobs.map((job) => {
      if (job.status === 'running') {
        changed = true;
        return { ...job, status: 'queued', progress: 8, message: 'Resumed after app restart', updatedAt: nowIso() };
      }
      return job;
    });
    if (changed) {
      writeStudioQueueState(projectPath, state);
    }
    // Re-arm auto-resume for quota blocks persisted before the restart. Any
    // block whose reset time already elapsed while the app was closed is lifted
    // immediately (which re-queues its blocked jobs).
    const blocks = state.quotaBlocks || {};
    for (const [studioName, iso] of Object.entries(blocks)) {
      if (studioBlockActive(iso)) {
        scheduleQuotaResume(projectPath, studioName, iso);
      } else {
        clearStudioQuotaBlock(projectPath, studioName, 'Quota window elapsed — retrying');
      }
    }
    for (let index = 0; index < DESKTOP_STUDIO_MAX_PARALLEL; index += 1) {
      runNextStudioJob(projectPath);
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    icon: path.join(__dirname, '../build/icon.png'),
    titleBarStyle: 'hiddenInset', backgroundColor: '#1e1e1e'
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  if (process.argv.includes('--dev')) { mainWindow.webContents.openDevTools(); }
  mainWindow.on('closed', () => { mainWindow = null; if (pythonProcess) pythonProcess.kill(); });
}

app.whenReady().then(async () => {
  await resolveShellPath();
  if (process.platform === 'darwin') {
    const iconPath = path.join(__dirname, '../build/icon.png');
    if (fs.existsSync(iconPath)) {
      const { nativeImage } = require('electron');
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }
  }
  createWindow();
  resumeStudioQueues();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// IPC Handlers
ipcMain.handle('select-pdf', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'PDF Files', extensions: ['pdf'] }] });
  if (!result.canceled && result.filePaths.length > 0) return { success: true, path: result.filePaths[0], name: path.basename(result.filePaths[0]) };
  return { success: false };
});

ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (!result.canceled && result.filePaths.length > 0) {
    return { success: true, path: result.filePaths[0] };
  }
  return { success: false };
});

ipcMain.handle('dir-exists', async (event, path) => {
  return fs.existsSync(path);
});

ipcMain.handle('get-app-paths', () => {
  const projectsPath = projectsRoot();
  return {
    userData: app.getPath('userData'),
    documents: app.getPath('documents'),
    projects: projectsPath,
    appRoot: path.resolve(__dirname, '../..')
  };
});

ipcMain.handle('check-nblm', async () => {
  return new Promise((resolve) => {
    const env = buildNblmEnv();
    const proc = spawn(nblmBinary(), ['--version'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', (data) => { errorOutput += data.toString(); });
    proc.on('close', (code) => resolve({ success: code === 0, output, error: errorOutput, exitCode: code }));
    proc.on('error', (error) => resolve({ success: false, error: error.message }));
  });
});

ipcMain.handle('list-projects', async (event, rootPath) => {
  if (!fs.existsSync(rootPath)) return [];
  const items = fs.readdirSync(rootPath, { withFileTypes: true });
  
  const projects = items
    .filter(dirent => dirent.isDirectory() && dirent.name.includes('-chunks'))
    .filter(dirent => {
      // Draft projects may only have metadata.json before chunking starts.
      const manifestPath = path.join(rootPath, dirent.name, 'manifest.json');
      const metadataPath = path.join(rootPath, dirent.name, 'metadata.json');
      return fs.existsSync(manifestPath) || fs.existsSync(metadataPath);
    })
    .map(dirent => {
      const projectPath = path.join(rootPath, dirent.name);
      const stats = fs.statSync(projectPath);
      return {
        name: dirent.name.replace(/-chunks(-\d+)?$/, ''),
        path: projectPath,
        rawName: dirent.name,
        modified: stats.mtime // Son değişiklik tarihi
      };
    });
    
  return projects.sort((a, b) => b.modified - a.modified); // En yeni en üstte
});

ipcMain.handle('get-studio-queue', async (event, projectPath) => {
  try {
    return { success: true, queue: readStudioQueueState(projectPath) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('enqueue-studio-jobs', async (event, { projectPath, jobs }) => {
  try {
    return { success: true, queue: enqueueStudioJobs(projectPath, Array.isArray(jobs) ? jobs : []) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


ipcMain.handle('retry-studio-job', async (event, { projectPath, jobId }) => {
  try {
    const state = readStudioQueueState(projectPath);
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) return { success: false, error: 'Job not found' };
    if (job.status !== 'failed' && job.status !== 'blocked') {
      return { success: false, error: 'Only failed or blocked jobs can be retried' };
    }
    if (job.status === 'blocked') {
      // "Retry now" overrides the quota window for the whole studio type: cancel
      // the auto-resume timer, drop the block, and re-queue every blocked job of
      // that type so the countdown does not immediately re-park it.
      cancelStudioQuotaTimer(projectPath, job.studioName);
      if (state.quotaBlocks) delete state.quotaBlocks[job.studioName];
      state.jobs = state.jobs.map((j) =>
        j.studioName === job.studioName && j.status === 'blocked'
          ? { ...j, status: 'queued', progress: 8, blockedUntil: null, message: 'Queued for retry', logs: [], updatedAt: nowIso() }
          : j,
      );
    } else {
      job.status = 'queued';
      job.progress = 8;
      job.message = 'Queued for retry';
      job.updatedAt = nowIso();
      job.logs = [];
    }
    writeStudioQueueState(projectPath, state);
    for (let index = 0; index < DESKTOP_STUDIO_MAX_PARALLEL; index += 1) {
      runNextStudioJob(projectPath);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('remove-studio-job', async (event, { projectPath, jobId }) => {
  try {
    const state = readStudioQueueState(projectPath);
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) return { success: false, error: 'Job not found' };
    if (job.status === 'running') return { success: false, error: 'Cannot remove a running job' };
    state.jobs = state.jobs.filter((j) => j.id !== jobId);
    writeStudioQueueState(projectPath, state);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clear-submitted-studio-jobs', async (event, { projectPath }) => {
  try {
    const state = readStudioQueueState(projectPath);
    const before = state.jobs.length;
    state.jobs = state.jobs.filter((j) => j.status !== 'submitted');
    const removed = before - state.jobs.length;
    if (removed === 0) return { success: false, error: 'No submitted jobs to clear' };
    writeStudioQueueState(projectPath, state);
    return { success: true, removed };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('retry-all-failed-studio-jobs', async (event, { projectPath }) => {
  try {
    const state = readStudioQueueState(projectPath);
    let retried = 0;
    for (const job of state.jobs) {
      if (job.status === 'failed') {
        job.status = 'queued';
        job.progress = 8;
        job.message = 'Queued for retry';
        job.updatedAt = nowIso();
        job.logs = [];
        retried += 1;
      }
    }
    if (retried === 0) return { success: false, error: 'No failed jobs to retry' };
    writeStudioQueueState(projectPath, state);
    for (let index = 0; index < DESKTOP_STUDIO_MAX_PARALLEL; index += 1) {
      runNextStudioJob(projectPath);
    }
    return { success: true, retried };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-project', async (event, projectPath) => {
  try {
    if (fs.existsSync(projectPath)) {
      fs.rmSync(projectPath, { recursive: true, force: true });
      return { success: true };
    }
    return { success: false, error: 'Directory not found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('run-nblm', async (event, { command, args = [], config }) => {
  if (pythonProcess) { pythonProcess.kill(); pythonProcess = null; await new Promise(r => setTimeout(r, 200)); }
  return new Promise((resolve, reject) => {
    let tempConfigPath = null;
    let spawnArgs = [command, ...args];
    if (config) {
      tempConfigPath = path.join(app.getPath('temp'), `nblm-temp-${Date.now()}.toml`);
      fs.writeFileSync(tempConfigPath, config);
      spawnArgs.push('--config', tempConfigPath);
    }
    const env = buildNblmEnv();
    pythonProcess = spawn(nblmBinary(), spawnArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errorOutput = '';
    pythonProcess.stdout.on('data', (data) => {
      const text = data.toString(); output += text;
      process.stdout.write(`[nblm STDOUT] ${text}`);
      mainWindow.webContents.send('nblm-output', { type: 'stdout', data: text });
    });
    pythonProcess.stderr.on('data', (data) => {
      const text = data.toString(); errorOutput += text;
      process.stderr.write(`[nblm STDERR] ${text}`);
      mainWindow.webContents.send('nblm-output', { type: 'stderr', data: text });
    });
    pythonProcess.on('close', (code) => {
      if (tempConfigPath && fs.existsSync(tempConfigPath)) { try { fs.unlinkSync(tempConfigPath); } catch (e) {} }
      pythonProcess = null;
      resolve({ success: code === 0, output: output, error: errorOutput, exitCode: code });
    });
    pythonProcess.on('error', (error) => { pythonProcess = null; resolve({ success: false, error: error.message }); });
  });
});

ipcMain.handle('send-nblm-input', async (event, input) => {
  if (pythonProcess && pythonProcess.stdin) { pythonProcess.stdin.write(input); return { success: true }; }
  return { success: false, error: 'No process' };
});

ipcMain.handle('set-active-profile', async (event, name) => {
  activeProfile = (typeof name === 'string' && name.trim()) ? name.trim() : null;
  return { success: true, activeProfile };
});
ipcMain.handle('get-version', async () => app.getVersion());
ipcMain.handle('read-file', async (event, filePath) => { try { return { success: true, content: fs.readFileSync(filePath, 'utf-8') }; } catch (err) { return { success: false, error: err.message }; } });
ipcMain.handle('write-file', async (event, filePath, content) => { try { fs.writeFileSync(filePath, content, 'utf-8'); return { success: true }; } catch (err) { return { success: false, error: err.message }; } });
ipcMain.handle('read-dir', async (event, dirPath) => { try { return { success: true, files: fs.readdirSync(dirPath) }; } catch (err) { return { success: false, error: err.message }; } });
ipcMain.handle('stop-nblm', async () => { if (pythonProcess) { pythonProcess.kill(); pythonProcess = null; } return { success: true }; });
ipcMain.handle('open-external', async (event, url) => {
  const { shell } = require('electron');
  await shell.openExternal(url);
  return { success: true };
});
