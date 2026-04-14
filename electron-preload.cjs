'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectDirectory: (opts) => ipcRenderer.invoke('select-directory', opts),
  selectFile: (opts) => ipcRenderer.invoke('select-file', opts),
  findDriveData: (dir) => ipcRenderer.invoke('find-drive-data', dir),
  getDefaultOutputDir: () => ipcRenderer.invoke('get-default-output-dir'),
  checkDriveData: (dir) => ipcRenderer.invoke('check-drive-data', dir),
  getCpuCount: () => ipcRenderer.invoke('get-cpu-count'),
  loadAndGroupDrives: (fp) => ipcRenderer.invoke('load-and-group-drives', fp),
  repairGPS: (fp) => ipcRenderer.invoke('repair-gps', fp),
  startProcessing: (args) => ipcRenderer.invoke('start-processing', args),
  stopProcessing: () => ipcRenderer.invoke('stop-processing'),
  onProcessingOutput: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('processing-output', listener);
    return () => ipcRenderer.off('processing-output', listener);
  },
});
