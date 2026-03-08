const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  selectPDF: () => ipcRenderer.invoke('select-pdf'),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  
  // CLI operations
  checkNBLM: () => ipcRenderer.invoke('check-nblm'),
  runNBLM: (options) => ipcRenderer.invoke('run-nblm', options),
  stopNBLM: () => ipcRenderer.invoke('stop-nblm'),
  
  // App info
  getVersion: () => ipcRenderer.invoke('get-version'),
  
  // Listen to output
  onNBLMOutput: (callback) => {
    ipcRenderer.on('nblm-output', (event, data) => callback(data));
  },
  
  // Remove listener
  removeNBLMOutputListener: () => {
    ipcRenderer.removeAllListeners('nblm-output');
  }
});
