'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let activeChild = null;

// ─── Auto-Updater Setup ─────────────────────────────────────────────────────
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function sendUpdateStatus(status, data = {}) {
  mainWindow?.webContents.send('update-status', { status, ...data });
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdateStatus('up-to-date'));
autoUpdater.on('download-progress', (progress) => sendUpdateStatus('downloading', { percent: Math.round(progress.percent) }));
autoUpdater.on('update-downloaded', () => sendUpdateStatus('ready'));
autoUpdater.on('error', (err) => sendUpdateStatus('error', { message: err.message }));

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

Menu.setApplicationMenu(null);

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('select-directory', async (_e, options) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: options?.defaultPath ?? undefined,
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('select-file', async (_e, options) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options?.filters ?? [{ name: 'JSON', extensions: ['json'] }],
    defaultPath: options?.defaultPath ?? undefined,
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('find-drive-data', async (_e, dir) => {
  const filePath = path.join(dir, 'drive-data.json');
  return fs.existsSync(filePath) ? filePath : null;
});

ipcMain.handle('get-default-output-dir', () => __dirname);

ipcMain.handle('check-drive-data', (_e, dir) =>
  fs.existsSync(path.join(dir, 'drive-data.json'))
);

ipcMain.handle('get-cpu-count', () => require('os').cpus().length);

ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('set-allow-prerelease', (_e, allow) => {
  autoUpdater.allowPrerelease = allow;
});

ipcMain.handle('check-for-update', () => autoUpdater.checkForUpdates().catch(() => {}));

ipcMain.handle('download-update', () => autoUpdater.downloadUpdate().catch(() => {}));

ipcMain.handle('install-update', () => autoUpdater.quitAndInstall(false, true));

ipcMain.handle('load-and-group-drives', async (_e, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const { groupIntoDrives } = await import('./grouper.js');
    const { drives, timeGroupCount, routeCount, droppedCount } = groupIntoDrives(data.routes ?? []);
    // Attach tags to drives
    const driveTags = data.driveTags ?? {};
    for (const d of drives) {
      d.tags = driveTags[d.startTime] ?? [];
    }

    return {
      success: true,
      drives,
      driveTags,
      totalRoutes: (data.routes ?? []).length,
      processedFileCount: (data.processedFiles ?? []).length,
      timeGroupCount,
      routeCount,
      droppedCount,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-processing', async (_e, { clipsDir, outputDir, workerCount }) => {
  if (activeChild) return { success: false, error: 'Processing already running' };

  const scriptPath = path.join(__dirname, 'process.js');
  const outputPath = path.join(outputDir, 'drive-data.json');
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

// ─── Drive Tags ──────────────────────────────────────────────────────────────

ipcMain.handle('get-drive-tags', (_e, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return { success: true, driveTags: data.driveTags ?? {} };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('set-drive-tags', (_e, { filePath, driveKey, tags }) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.driveTags) data.driveTags = {};

    if (tags.length === 0) {
      delete data.driveTags[driveKey];
    } else {
      data.driveTags[driveKey] = tags;
    }

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-all-tag-names', (_e, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const driveTags = data.driveTags ?? {};
    const set = new Set();
    for (const tags of Object.values(driveTags)) {
      for (const t of tags) set.add(t);
    }
    return { success: true, tags: [...set].sort() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('repair-gps', async (_e, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    fs.copyFileSync(filePath, filePath + '.bak');
    const data = JSON.parse(raw);
    const routes = data.routes ?? [];
    let removedPoints = 0;
    let removedRoutes = 0;
    let bridgedGaps = 0;

    const toRad = (d) => (d * Math.PI) / 180;
    const haversineM = (lat1, lon1, lat2, lon2) => {
      const R = 6371000;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    const FILE_TS_RE = /(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/;
    const parseTs = (file) => {
      const m = FILE_TS_RE.exec(file);
      if (!m) return null;
      const t = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`);
      return isNaN(t.getTime()) ? null : t;
    };

    // --- Phase 1: Clean invalid coordinates ---
    for (let r = routes.length - 1; r >= 0; r--) {
      const pts = routes[r].points;
      if (!pts || pts.length === 0) continue;

      // Remove null/near-zero coordinates
      for (let i = pts.length - 1; i >= 0; i--) {
        const lat = pts[i][0], lng = pts[i][1];
        if ((Math.abs(lat) < 1 && Math.abs(lng) < 1) || lat == null || lng == null) {
          pts.splice(i, 1);
          removedPoints++;
        }
      }

      // Remove points far from the median cluster (GPS pre-lock junk)
      if (pts.length > 4) {
        const q1 = Math.floor(pts.length * 0.25);
        const q3 = Math.floor(pts.length * 0.75);
        let mLat = 0, mLng = 0, cnt = 0;
        for (let i = q1; i <= q3; i++) { mLat += pts[i][0]; mLng += pts[i][1]; cnt++; }
        mLat /= cnt; mLng /= cnt;
        for (let i = pts.length - 1; i >= 0; i--) {
          if (haversineM(pts[i][0], pts[i][1], mLat, mLng) > 1000000) { // 1,000 km
            pts.splice(i, 1);
            removedPoints++;
          }
        }
      }

      if (pts.length === 0) {
        routes.splice(r, 1);
        removedRoutes++;
      }
    }

    // --- Phase 2: Bridge gaps between consecutive non-parked clips ---
    // Sort routes by timestamp
    const GEAR_PARK = 0;
    const MAX_BRIDGE_MS = 5 * 60 * 1000; // 5 minutes
    const timedRoutes = routes
      .map((r, idx) => ({ idx, ts: parseTs(r.file), route: r }))
      .filter((r) => r.ts !== null)
      .sort((a, b) => a.ts - b.ts);

    const bridgeRoutes = [];
    for (let i = 0; i < timedRoutes.length - 1; i++) {
      const cur = timedRoutes[i];
      const next = timedRoutes[i + 1];
      const curR = cur.route;
      const nextR = next.route;

      // Check time gap: clip duration is ~60s, so expected next = cur.ts + 60s
      const curEnd = new Date(cur.ts.getTime() + 60000);
      const gapMs = next.ts - curEnd;
      if (gapMs <= 0 || gapMs > MAX_BRIDGE_MS) continue;

      // Both clips must have points
      if (!curR.points || curR.points.length === 0) continue;
      if (!nextR.points || nextR.points.length === 0) continue;

      // Check gear: last gear of current clip must not be park
      const curLastGear = curR.gearRuns && curR.gearRuns.length > 0
        ? curR.gearRuns[curR.gearRuns.length - 1].gear
        : (curR.gearStates && curR.gearStates.length > 0 ? curR.gearStates[curR.gearStates.length - 1] : null);
      const nextFirstGear = nextR.gearRuns && nextR.gearRuns.length > 0
        ? nextR.gearRuns[0].gear
        : (nextR.gearStates && nextR.gearStates.length > 0 ? nextR.gearStates[0] : null);

      if (curLastGear === GEAR_PARK || nextFirstGear === GEAR_PARK) continue;

      // Same date
      if (curR.date !== nextR.date) continue;

      // Interpolate between last point of cur and first point of next
      const lastPt = curR.points[curR.points.length - 1];
      const firstPt = nextR.points[0];
      const nSteps = Math.max(2, Math.round(gapMs / 1000)); // ~1 point per second
      const interpPoints = [];
      const interpGears = [];
      const interpAP = [];
      const interpSpeeds = [];
      const interpAccel = [];

      for (let s = 1; s < nSteps; s++) {
        const t = s / nSteps;
        interpPoints.push([
          lastPt[0] + (firstPt[0] - lastPt[0]) * t,
          lastPt[1] + (firstPt[1] - lastPt[1]) * t,
        ]);
        interpGears.push(curLastGear ?? 1);
        interpAP.push(0);
        // Estimate speed from distance/time
        const distM = haversineM(lastPt[0], lastPt[1], firstPt[0], firstPt[1]);
        interpSpeeds.push(distM / (gapMs / 1000));
        interpAccel.push(0);
      }

      // Build a synthetic bridge route
      const bridgeTs = new Date(curEnd.getTime());
      const pad = (n) => String(n).padStart(2, '0');
      const synthFile = `${curR.date}/${curR.date}_${pad(bridgeTs.getHours())}-${pad(bridgeTs.getMinutes())}-${pad(bridgeTs.getSeconds())}-front-bridge.mp4`;

      bridgeRoutes.push({
        file: synthFile,
        date: curR.date,
        points: interpPoints,
        gearStates: interpGears,
        autopilotStates: interpAP,
        speeds: interpSpeeds,
        accelPositions: interpAccel,
        rawParkCount: 0,
        rawFrameCount: interpPoints.length,
        gearRuns: [{ gear: curLastGear ?? 1, frames: interpPoints.length }],
      });
      bridgedGaps++;
    }

    // Add bridge routes and mark them as processed
    for (const br of bridgeRoutes) {
      routes.push(br);
      if (!data.processedFiles) data.processedFiles = [];
      data.processedFiles.push(br.file);
    }

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    return { success: true, removedPoints, removedRoutes, bridgedGaps };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
