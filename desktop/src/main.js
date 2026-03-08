const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let pythonProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e1e'
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (pythonProcess) {
      pythonProcess.kill();
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC Handlers

// Select PDF file
ipcMain.handle('select-pdf', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'PDF Files', extensions: ['pdf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return {
      success: true,
      path: result.filePaths[0],
      name: path.basename(result.filePaths[0])
    };
  }

  return { success: false };
});

// Select output directory
ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return {
      success: true,
      path: result.filePaths[0]
    };
  }

  return { success: false };
});

// Check if nblm CLI is available
ipcMain.handle('check-nblm', async () => {
  return new Promise((resolve) => {
    const process = spawn('nblm', ['--version']);
    
    process.on('error', () => {
      resolve({ available: false, error: 'nblm CLI not found' });
    });

    process.on('close', (code) => {
      if (code === 0) {
        resolve({ available: true });
      } else {
        resolve({ available: false, error: 'nblm CLI error' });
      }
    });
  });
});

// Run nblm command
ipcMain.handle('run-nblm', async (event, { command, args, config }) => {
  return new Promise((resolve, reject) => {
    // Create temporary config file
    const tempConfigPath = path.join(app.getPath('temp'), 'nblm-temp.toml');
    fs.writeFileSync(tempConfigPath, config);

    // Spawn nblm process
    pythonProcess = spawn('nblm', [command, '--config', tempConfigPath, ...args]);

    let output = '';
    let errorOutput = '';

    pythonProcess.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      
      // Send progress updates to renderer
      mainWindow.webContents.send('nblm-output', {
        type: 'stdout',
        data: text
      });
    });

    pythonProcess.stderr.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;
      
      mainWindow.webContents.send('nblm-output', {
        type: 'stderr',
        data: text
      });
    });

    pythonProcess.on('close', (code) => {
      // Clean up temp config
      try {
        fs.unlinkSync(tempConfigPath);
      } catch (e) {
        // Ignore cleanup errors
      }

      pythonProcess = null;

      if (code === 0) {
        resolve({
          success: true,
          output: output,
          exitCode: code
        });
      } else {
        reject({
          success: false,
          error: errorOutput || output,
          exitCode: code
        });
      }
    });

    pythonProcess.on('error', (error) => {
      reject({
        success: false,
        error: error.message
      });
    });
  });
});

// Stop running process
ipcMain.handle('stop-nblm', async () => {
  if (pythonProcess) {
    pythonProcess.kill();
    pythonProcess = null;
    return { success: true };
  }
  return { success: false, error: 'No process running' };
});

// Get app version
ipcMain.handle('get-version', async () => {
  return app.getVersion();
});
