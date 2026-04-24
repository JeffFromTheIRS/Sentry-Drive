'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let activeChild = null;

// ─── Window State Persistence ────────────────────────────────────────────────
const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');
const DEFAULT_WINDOW_STATE = { width: 1440, height: 900, isMaximized: false, isFullScreen: false };

function loadWindowState() {
  try {
    const raw = fs.readFileSync(WINDOW_STATE_FILE(), 'utf-8');
    return { ...DEFAULT_WINDOW_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

function saveWindowState() {
  if (!mainWindow) return;
  try {
    const isMaximized = mainWindow.isMaximized();
    const isFullScreen = mainWindow.isFullScreen();
    // When maximized/fullscreen, getBounds() returns the fullscreen rect, which
    // isn't useful as a restore size. Prefer getNormalBounds() (Electron ≥ 12).
    const bounds = isMaximized || isFullScreen
      ? (mainWindow.getNormalBounds?.() ?? mainWindow.getBounds())
      : mainWindow.getBounds();
    fs.writeFileSync(
      WINDOW_STATE_FILE(),
      JSON.stringify({ ...bounds, isMaximized, isFullScreen }, null, 2),
    );
  } catch {
    // Best-effort; losing the file on next launch just reverts to defaults.
  }
}

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
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
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

  if (state.isMaximized) mainWindow.maximize();
  if (state.isFullScreen) mainWindow.setFullScreen(true);

  mainWindow.on('close', saveWindowState);

  // DevTools shortcuts (application menu is disabled, so wire them here).
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key?.toLowerCase();
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      mainWindow.webContents.toggleDevTools();
    } else if ((input.control || input.meta) && key === 'r') {
      mainWindow.webContents.reload();
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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

ipcMain.handle('get-default-output-dir', () => path.join(__dirname, '..', '..'));

ipcMain.handle('check-drive-data', (_e, dir) =>
  fs.existsSync(path.join(dir, 'drive-data.json'))
);

ipcMain.handle('get-cpu-count', () => require('os').cpus().length);

ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('set-allow-prerelease', (_e, allow) => {
  autoUpdater.allowPrerelease = allow;
});

ipcMain.handle('remove-drive', async (_e, { filePath, driveStartTime }) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives } = groupIntoDrives(data.routes ?? []);
    const target = drives.find((d) => d.startTime === driveStartTime);
    if (!target) return { success: false, error: 'Drive not found' };

    const removeSet = new Set(target.routeFiles.map((f) => f.replace(/\\/g, '/')));
    data.routes = (data.routes ?? []).filter((r) => !removeSet.has(r.file.replace(/\\/g, '/')));
    data.processedFiles = (data.processedFiles ?? []).filter((f) => !removeSet.has(f.replace(/\\/g, '/')));
    if (data.driveTags) delete data.driveTags[driveStartTime];

    data.routes = await routesToWireFormat(data.routes);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('revert-to-stable', () => {
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = true;
  return autoUpdater.checkForUpdates().catch(() => {});
});

ipcMain.handle('check-for-update', () => autoUpdater.checkForUpdates().catch(() => {}));

ipcMain.handle('download-update', () => autoUpdater.downloadUpdate().catch(() => {}));

ipcMain.handle('install-update', () => autoUpdater.quitAndInstall(false, true));

ipcMain.handle('fetch-remote-changelog', () => {
  const url = 'https://raw.githubusercontent.com/JeffFromTheIRS/Sentry-Drive/main/changelog.json';
  return new Promise((resolve) => {
    const req = require('https').get(
      url,
      { timeout: 5000, headers: { 'User-Agent': 'Sentry-Drive' } },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve({ success: false, status: res.statusCode }); return; }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve({ success: true, versions: json.versions ?? [] });
          } catch (err) { resolve({ success: false, error: err.message }); }
        });
      }
    );
    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
  });
});

ipcMain.handle('get-changelog', () => {
  try {
    const filePath = path.join(app.getAppPath(), 'changelog.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return { success: true, versions: data.versions ?? [] };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('load-and-group-drives', async (_e, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives, timeGroupCount, routeCount, droppedCount } = groupIntoDrives(data.routes ?? []);
    // Attach tags to drives
    const driveTags = data.driveTags ?? {};
    for (const d of drives) {
      d.tags = driveTags[d.startTime] ?? [];
    }

    // Extract lightweight route points for overview map (one polyline per clip)
    const overviewRoutes = [];
    for (const r of (data.routes ?? [])) {
      if (r.points && r.points.length > 1) {
        overviewRoutes.push(r.points);
      }
    }

    return {
      success: true,
      drives,
      overviewRoutes,
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

ipcMain.handle('start-processing', async (_e, { clipsDir, outputDir, workerCount, reprocessAll }) => {
  if (activeChild) return { success: false, error: 'Processing already running' };

  const scriptPath = path.join(__dirname, '..', 'processing', 'process.js');
  const outputPath = path.join(outputDir, 'drive-data.json');
  const args = [scriptPath, clipsDir, outputPath];
  if (workerCount && workerCount > 0) args.push(String(workerCount));
  if (reprocessAll) args.push('--reprocess-all');

  try {
    activeChild = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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

// ─── drive-data.json wire format ─────────────────────────────────────────────
// gearStates / autopilotStates are written as base64 strings to match
// Sentry-USB's []uint8 JSON encoding. Codec lives in the ESM grouper module;
// memoize the dynamic import so we pay it once per process.
let _byteFieldCodec;
async function getByteFieldCodec() {
  if (!_byteFieldCodec) {
    const mod = await import('../processing/grouper.js');
    _byteFieldCodec = { encode: mod.encodeByteField, decode: mod.decodeByteField };
  }
  return _byteFieldCodec;
}

async function routesToWireFormat(routes) {
  if (!Array.isArray(routes)) return routes;
  const { encode } = await getByteFieldCodec();
  return routes.map((r) => ({
    ...r,
    autopilotStates: encode(r.autopilotStates),
    gearStates: encode(r.gearStates),
  }));
}

async function decodeRoutesByteFields(routes) {
  if (!Array.isArray(routes)) return routes;
  const { decode } = await getByteFieldCodec();
  return routes.map((r) => ({
    ...r,
    autopilotStates: decode(r.autopilotStates),
    gearStates: decode(r.gearStates),
  }));
}

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

ipcMain.handle('set-drive-tags', async (_e, { filePath, driveKey, tags }) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.driveTags) data.driveTags = {};

    if (tags.length === 0) {
      delete data.driveTags[driveKey];
    } else {
      data.driveTags[driveKey] = tags;
    }

    data.routes = await routesToWireFormat(data.routes);
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

ipcMain.handle('revert-gps', (_e, filePath) => {
  try {
    const bakPath = filePath + '.bak';
    if (!fs.existsSync(bakPath)) return { success: false, error: 'No backup file found.' };
    fs.copyFileSync(bakPath, filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('has-gps-backup', (_e, filePath) => {
  return fs.existsSync(filePath + '.bak');
});

ipcMain.handle('check-online', async () => {
  try {
    await new Promise((resolve, reject) => {
      const req = require('https').get('https://router.project-osrm.org/health', { timeout: 5000 }, (res) => {
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    return true;
  } catch {
    return false;
  }
});

async function fetchOSRMRoute(startLat, startLng, endLat, endLng) {
  const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
  return new Promise((resolve, reject) => {
    require('https').get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 'Ok' && json.routes && json.routes.length > 0) {
            const coords = json.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]);
            resolve(coords);
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

function sendRepairProgress(phase, current, total, etaSec) {
  mainWindow?.webContents.send('repair-progress', { phase, current, total, etaSec });
}

ipcMain.handle('repair-gps', async (_e, { filePath, useRouting }) => {
  try {
    sendRepairProgress('Reading…', 0, 1);
    const raw = fs.readFileSync(filePath, 'utf-8');
    fs.copyFileSync(filePath, filePath + '.bak');
    const data = JSON.parse(raw);
    let routes = await decodeRoutesByteFields(data.routes ?? []);
    let bridgedGaps = 0;
    let routedGaps = 0;

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

    // --- Phase 0: Remove existing bridge routes so they can be re-bridged ---
    const beforeCount = routes.length;
    routes = routes.filter((r) => !r.file.includes('-front-bridge.mp4'));
    data.routes = routes;
    if (data.processedFiles) {
      data.processedFiles = data.processedFiles.filter((f) => !f.includes('-front-bridge.mp4'));
    }
    const removedBridges = beforeCount - routes.length;

    // --- Bridge gaps ---
    // Only bridge gaps > 60s (normal clip boundaries are ~60s and don't need bridging)
    const GEAR_PARK = 0;
    const MIN_BRIDGE_MS = 60 * 1000;
    const MAX_BRIDGE_MS = 5 * 60 * 1000;
    const timedRoutes = routes
      .map((r, idx) => ({ idx, ts: parseTs(r.file), route: r }))
      .filter((r) => r.ts !== null)
      .sort((a, b) => a.ts - b.ts);

    // First pass: quickly identify gaps that need bridging
    sendRepairProgress('Scanning for gaps…', 0, 1);
    const gaps = [];
    for (let i = 0; i < timedRoutes.length - 1; i++) {
      const cur = timedRoutes[i];
      const next = timedRoutes[i + 1];
      const curR = cur.route;
      const nextR = next.route;

      const curEnd = new Date(cur.ts.getTime() + 60000);
      const gapMs = next.ts - curEnd;
      if (gapMs <= MIN_BRIDGE_MS || gapMs > MAX_BRIDGE_MS) continue;
      if (!curR.points || curR.points.length === 0) continue;
      if (!nextR.points || nextR.points.length === 0) continue;

      const curLastGear = curR.gearRuns && curR.gearRuns.length > 0
        ? curR.gearRuns[curR.gearRuns.length - 1].gear
        : (curR.gearStates && curR.gearStates.length > 0 ? curR.gearStates[curR.gearStates.length - 1] : null);
      const nextFirstGear = nextR.gearRuns && nextR.gearRuns.length > 0
        ? nextR.gearRuns[0].gear
        : (nextR.gearStates && nextR.gearStates.length > 0 ? nextR.gearStates[0] : null);

      if (curLastGear === GEAR_PARK || nextFirstGear === GEAR_PARK) continue;
      if (curR.date !== nextR.date) continue;

      gaps.push({
        lastPt: curR.points[curR.points.length - 1],
        firstPt: nextR.points[0],
        curEnd,
        gapMs,
        curLastGear,
        date: curR.date,
      });
    }

    // Second pass: bridge each gap with progress
    const bridgeRoutes = [];
    const bridgeStartMs = Date.now();
    for (let g = 0; g < gaps.length; g++) {
      const elapsedMs = Date.now() - bridgeStartMs;
      const etaSec = g > 0 ? Math.round((elapsedMs / g) * (gaps.length - g) / 1000) : 0;
      sendRepairProgress('Bridging…', g + 1, gaps.length, etaSec);
      const { lastPt, firstPt, curEnd, gapMs, curLastGear, date } = gaps[g];

      let interpPoints;

      // Try OSRM routing if online
      if (useRouting) {
        try {
          const routed = await fetchOSRMRoute(lastPt[0], lastPt[1], firstPt[0], firstPt[1]);
          if (routed && routed.length >= 2) {
            interpPoints = routed;
            routedGaps++;
          }
        } catch {
          // Fall back to straight line
        }
      }

      // Fallback: straight-line interpolation
      if (!interpPoints) {
        const nSteps = Math.max(2, Math.round(gapMs / 1000));
        interpPoints = [];
        for (let s = 1; s < nSteps; s++) {
          const t = s / nSteps;
          interpPoints.push([
            lastPt[0] + (firstPt[0] - lastPt[0]) * t,
            lastPt[1] + (firstPt[1] - lastPt[1]) * t,
          ]);
        }
      }

      const nPts = interpPoints.length;
      const distM = haversineM(lastPt[0], lastPt[1], firstPt[0], firstPt[1]);
      const avgSpeed = distM / (gapMs / 1000);

      const bridgeTs = new Date(curEnd.getTime());
      const pad = (n) => String(n).padStart(2, '0');
      const synthFile = `${date}/${date}_${pad(bridgeTs.getHours())}-${pad(bridgeTs.getMinutes())}-${pad(bridgeTs.getSeconds())}-front-bridge.mp4`;

      bridgeRoutes.push({
        file: synthFile,
        date,
        points: interpPoints,
        gearStates: new Array(nPts).fill(curLastGear ?? 1),
        autopilotStates: new Array(nPts).fill(0),
        speeds: new Array(nPts).fill(avgSpeed),
        accelPositions: new Array(nPts).fill(0),
        rawParkCount: 0,
        rawFrameCount: nPts,
        gearRuns: [{ gear: curLastGear ?? 1, frames: nPts }],
      });
      bridgedGaps++;
    }

    for (const br of bridgeRoutes) {
      routes.push(br);
      if (!data.processedFiles) data.processedFiles = [];
      data.processedFiles.push(br.file);
    }

    data.routes = await routesToWireFormat(routes);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    return { success: true, bridgedGaps, routedGaps, removedBridges };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
