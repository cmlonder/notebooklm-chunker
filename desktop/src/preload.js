const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  selectPDF: () => ipcRenderer.invoke('select-pdf'),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  readDir: (path) => ipcRenderer.invoke('read-dir', path),
  dirExists: (path) => ipcRenderer.invoke('dir-exists', path),
  listProjects: (rootPath) => ipcRenderer.invoke('list-projects', rootPath),
  getAppPaths: () => ipcRenderer.invoke('get-app-paths'),
  
  // CLI operations
  checkNBLM: () => ipcRenderer.invoke('check-nblm'),
  runNBLM: (options) => ipcRenderer.invoke('run-nblm', options),
  sendNBLMInput: (input) => ipcRenderer.invoke('send-nblm-input', input),
  stopNBLM: () => ipcRenderer.invoke('stop-nblm'),
  
  // App info
  getVersion: () => ipcRenderer.invoke('get-version'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  
  // Listen to output
  onNBLMOutput: (callback) => {
    ipcRenderer.on('nblm-output', (event, data) => callback(data));
  },
  
  // Remove listener
  removeNBLMOutputListener: () => {
    ipcRenderer.removeAllListeners('nblm-output');
  }
});
