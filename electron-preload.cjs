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
  getDriveTags: (fp) => ipcRenderer.invoke('get-drive-tags', fp),
  setDriveTags: (args) => ipcRenderer.invoke('set-drive-tags', args),
  getAllTagNames: (fp) => ipcRenderer.invoke('get-all-tag-names', fp),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  setAllowPrerelease: (allow) => ipcRenderer.invoke('set-allow-prerelease', allow),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.off('update-status', listener);
  },
  startProcessing: (args) => ipcRenderer.invoke('start-processing', args),
  stopProcessing: () => ipcRenderer.invoke('stop-processing'),
  onProcessingOutput: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('processing-output', listener);
    return () => ipcRenderer.off('processing-output', listener);
  },
});
