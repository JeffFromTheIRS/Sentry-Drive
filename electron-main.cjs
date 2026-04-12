'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let activeChild = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1050,
    minHeight: 650,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('select-directory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('select-file', async (_e, options) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options?.filters ?? [{ name: 'JSON', extensions: ['json'] }],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('get-default-output-path', () =>
  path.join(__dirname, 'drive-data.json')
);

ipcMain.handle('get-cpu-count', () => require('os').cpus().length);

ipcMain.handle('load-and-group-drives', async (_e, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const { groupIntoDrives } = await import('./grouper.js');
    const drives = groupIntoDrives(data.routes ?? []);
    return {
      success: true,
      drives,
      totalRoutes: (data.routes ?? []).length,
      processedFileCount: (data.processedFiles ?? []).length,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-processing', async (_e, { clipsDir, outputPath, workerCount }) => {
  if (activeChild) return { success: false, error: 'Processing already running' };

  const scriptPath = path.join(__dirname, 'process.js');
  const args = [scriptPath, clipsDir, outputPath];
  if (workerCount && workerCount > 0) args.push(String(workerCount));

  try {
    activeChild = spawn('node', args, {
      env: { ...process.env },
    });
  } catch (err) {
    return { success: false, error: `spawn failed: ${err.message}` };
  }

  activeChild.stdout.on('data', (chunk) => {
    mainWindow?.webContents.send('processing-output', { type: 'stdout', text: chunk.toString() });
  });

  activeChild.stderr.on('data', (chunk) => {
    mainWindow?.webContents.send('processing-output', { type: 'stderr', text: chunk.toString() });
  });

  return new Promise((resolve) => {
    activeChild.on('close', (code) => {
      activeChild = null;
      mainWindow?.webContents.send('processing-output', { type: 'done', code });
      resolve({ success: true, exitCode: code });
    });
    activeChild.on('error', (err) => {
      activeChild = null;
      mainWindow?.webContents.send('processing-output', { type: 'error', text: err.message });
      resolve({ success: false, error: err.message });
    });
  });
});

ipcMain.handle('stop-processing', () => {
  if (!activeChild) return { success: false, error: 'No process running' };
  activeChild.kill('SIGTERM');
  activeChild = null;
  return { success: true };
});
