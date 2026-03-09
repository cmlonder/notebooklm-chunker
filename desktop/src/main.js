const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let pythonProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    titleBarStyle: 'hiddenInset', backgroundColor: '#1e1e1e'
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  if (process.argv.includes('--dev')) { mainWindow.webContents.openDevTools(); }
  mainWindow.on('closed', () => { mainWindow = null; if (pythonProcess) pythonProcess.kill(); });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// IPC Handlers
ipcMain.handle('select-pdf', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'PDF Files', extensions: ['pdf'] }] });
  if (!result.canceled && result.filePaths.length > 0) return { success: true, path: result.filePaths[0], name: path.basename(result.filePaths[0]) };
  return { success: false };
});

ipcMain.handle('dir-exists', async (event, path) => {
  return fs.existsSync(path);
});

ipcMain.handle('get-app-paths', () => {
  return {
    userData: app.getPath('userData'),
    documents: app.getPath('documents'),
    projects: path.join(app.getPath('documents'), 'NotebookLM-Chunker')
  };
});

ipcMain.handle('list-projects', async (event, rootPath) => {
  if (!fs.existsSync(rootPath)) return [];
  const dirs = fs.readdirSync(rootPath, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && dirent.name.includes('-chunks'))
    .map(dirent => ({
      name: dirent.name.replace(/-chunks(-\d+)?$/, ''),
      path: path.join(rootPath, dirent.name),
      rawName: dirent.name // Versiyonu ayırt etmek için orijinal adı da tutalım
    }));
  return dirs;
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
