const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let pythonProcess = null;
const STUDIO_QUEUE_BASENAME = '.desktop-studio-queue.json';
const DESKTOP_STUDIO_MAX_PARALLEL = 3;
const studioQueueWorkers = new Map();

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

function defaultStudioQueueState() {
  return { version: 1, updatedAt: nowIso(), jobs: [] };
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

function buildStudioEnv() {
  const projectRoot = path.resolve(__dirname, '../..');
  return {
    ...process.env,
    PYTHONPATH: projectRoot,
    PATH: `${path.join(projectRoot, '.venv/bin')}${path.delimiter}${process.env.PATH}`,
  };
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
  const nextJob = state.jobs.find((job) => job.status === 'queued');
  if (!nextJob) return;
  setActiveStudioWorkers(projectPath, activeStudioWorkers(projectPath) + 1);
  const tempConfigPath = path.join(app.getPath('temp'), `nblm-studio-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.toml`);
  fs.writeFileSync(tempConfigPath, nextJob.configToml, 'utf-8');
  const proc = spawn('nblm', ['studios', ...nextJob.args, '--config', tempConfigPath], {
    env: buildStudioEnv(),
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

  proc.stdout.on('data', handleOutput('stdout'));
  proc.stderr.on('data', handleOutput('stderr'));
  proc.on('close', (code) => {
    try {
      if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
    } catch (error) {}
    setActiveStudioWorkers(projectPath, activeStudioWorkers(projectPath) - 1);
    if (code === 0) {
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
    }
    runNextStudioJob(projectPath);
    runNextStudioJob(projectPath);
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
    runNextStudioJob(projectPath);
    runNextStudioJob(projectPath);
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
    for (let index = 0; index < DESKTOP_STUDIO_MAX_PARALLEL; index += 1) {
      runNextStudioJob(projectPath);
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    icon: path.join(__dirname, '../renderer/chunker-mark.svg'),
    titleBarStyle: 'hiddenInset', backgroundColor: '#1e1e1e'
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  if (process.argv.includes('--dev')) { mainWindow.webContents.openDevTools(); }
  mainWindow.on('closed', () => { mainWindow = null; if (pythonProcess) pythonProcess.kill(); });
}

app.whenReady().then(() => {
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
    const projectRoot = path.resolve(__dirname, '../..');
    const env = {
      ...process.env,
      PYTHONPATH: projectRoot,
      PATH: `${path.join(projectRoot, '.venv/bin')}${path.delimiter}${process.env.PATH}`
    };
    const proc = spawn('nblm', ['--version'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (job.status !== 'failed') return { success: false, error: 'Only failed jobs can be retried' };
    job.status = 'queued';
    job.progress = 8;
    job.message = 'Queued for retry';
    job.updatedAt = nowIso();
    job.logs = [];
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
    if (command === 'internal-write-file') {
      try { fs.writeFileSync(args[0], args[1], 'utf-8'); return resolve({ success: true }); }
      catch (err) { return resolve({ success: false, error: err.message }); }
    }
    const projectRoot = path.resolve(__dirname, '../..');
    const env = { ...process.env, PYTHONPATH: projectRoot, PATH: `${path.join(projectRoot, '.venv/bin')}${path.delimiter}${process.env.PATH}` };
    pythonProcess = spawn('nblm', spawnArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] });
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

ipcMain.handle('get-version', async () => app.getVersion());
ipcMain.handle('read-file', async (event, filePath) => { try { return { success: true, content: fs.readFileSync(filePath, 'utf-8') }; } catch (err) { return { success: false, error: err.message }; } });
ipcMain.handle('read-dir', async (event, dirPath) => { try { return { success: true, files: fs.readdirSync(dirPath) }; } catch (err) { return { success: false, error: err.message }; } });
ipcMain.handle('stop-nblm', async () => { if (pythonProcess) { pythonProcess.kill(); pythonProcess = null; } return { success: true }; });
ipcMain.handle('open-external', async (event, url) => {
  const { shell } = require('electron');
  await shell.openExternal(url);
  return { success: true };
});
