'use strict';

const fmt = (n) => Number(n).toLocaleString('en-US');

// ─── State ────────────────────────────────────────────────────────────────────
let map = null;
let overviewLayers = [];       // faint lines for all drives
let selectedLayers = [];       // highlighted route for selected drive
let drives = [];
let overviewRoutes = [];   // raw route points for overview map (one per clip)
let loadedFilePath = null;
let selectedDriveId = null;
let removeOutputListener = null;
let processingStartTime = null;
let cpuCount = 1;
let allTags = [];          // deduplicated, sorted list of all tag names
let activeTagFilter = '';  // currently active tag filter (empty = show all)
let hideOtherDrives = false;

// Replay state
let replayMarker = null;
let replayInterval = null;
let replayPlaying = false;
let replayIdx = 0;
let replayDrive = null;
let replaySpeed = 1;        // 1x, 2x, 5x, 10x
const REPLAY_BASE_MS = 100; // base interval per point at 1x

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initTabs();
  initProcessingTab();
  initViewDrivesTab();
  initFooter();
  loadDefaultPaths();
});

// ─── Map ──────────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [39.5, -98.35],
    zoom: 4,
    preferCanvas: true,
    zoomControl: true,
  });

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> ' +
        'contributors &copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }
  ).addTo(map);

  window.addEventListener('resize', () => map.invalidateSize());

  map.on('zoomend', updateLineWeights);
  map.on('click', () => { if (selectedDriveId !== null) deselectDrive(); });

  document.getElementById('btn-back-overview').addEventListener('click', (e) => {
    e.stopPropagation();
    deselectDrive();
  });
}

function getWeight(base) {
  const zoom = map.getZoom();
  return Math.max(2, base * (zoom / 10));
}

function updateLineWeights() {
  for (const layer of [...overviewLayers, ...selectedLayers]) {
    if (layer._baseWeight && layer.setStyle) {
      layer.setStyle({ weight: getWeight(layer._baseWeight) });
    }
  }
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
      setTimeout(() => map.invalidateSize(), 50);
    });
  });
}

// ─── Footer & Settings ───────────────────────────────────────────────────────
let updateState = 'idle'; // idle | checking | available | downloading | ready | error
let updateSkipped = false; // true after user dismisses the update modal this session
let pendingVersion = '';   // version string from the 'available' event

function initFooter() {
  // GitHub link opens in external browser
  document.getElementById('link-github').addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal('https://github.com/JeffFromTheIRS/Sentry-Drive');
  });

  // Settings modal
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('settings-overlay').classList.remove('hidden');
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-overlay').classList.add('hidden');
  });
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      document.getElementById('settings-overlay').classList.add('hidden');
    }
  });

  // Version display
  window.electronAPI.getAppVersion().then((v) => {
    document.getElementById('settings-version-number').textContent = `v${v}`;
    document.querySelector('.footer-version').textContent = `v${v}`;
  });

  // Listen for update events from main process
  window.electronAPI.onUpdateStatus(onUpdateStatus);

  // Settings "Check for Update" button
  document.getElementById('btn-check-update').addEventListener('click', () => {
    if (updateState === 'available') {
      window.electronAPI.downloadUpdate();
    } else if (updateState === 'ready') {
      window.electronAPI.installUpdate();
    } else if (updateState === 'idle' || updateState === 'error') {
      window.electronAPI.checkForUpdate();
    }
  });

  // Update modal buttons
  document.getElementById('btn-update-now').addEventListener('click', () => {
    document.getElementById('update-overlay').classList.add('hidden');
    window.electronAPI.downloadUpdate();
  });
  document.getElementById('btn-update-skip').addEventListener('click', () => {
    updateSkipped = true;
    document.getElementById('update-overlay').classList.add('hidden');
  });

  // Footer download button
  document.getElementById('btn-footer-update').addEventListener('click', () => {
    if (updateState === 'available') {
      window.electronAPI.downloadUpdate();
    } else if (updateState === 'ready') {
      window.electronAPI.installUpdate();
    }
  });

  // Beta checkbox
  const betaCheckbox = document.getElementById('chk-beta');
  const betaWarning = document.getElementById('beta-warning');
  const savedBeta = localStorage.getItem('enrollBeta') === 'true';
  betaCheckbox.checked = savedBeta;
  if (savedBeta) betaWarning.classList.remove('hidden');
  window.electronAPI.setAllowPrerelease(savedBeta);

  betaCheckbox.addEventListener('change', () => {
    const enrolled = betaCheckbox.checked;
    localStorage.setItem('enrollBeta', String(enrolled));
    window.electronAPI.setAllowPrerelease(enrolled);

    if (enrolled) {
      betaWarning.classList.remove('hidden');
    } else {
      betaWarning.classList.add('hidden');
    }

    // Re-check for updates with new prerelease setting
    window.electronAPI.checkForUpdate();
  });

  // Hide other drives setting
  const hideChk = document.getElementById('chk-hide-other-drives');
  hideOtherDrives = localStorage.getItem('hideOtherDrives') === 'true';
  hideChk.checked = hideOtherDrives;
  hideChk.addEventListener('change', () => {
    hideOtherDrives = hideChk.checked;
    localStorage.setItem('hideOtherDrives', String(hideOtherDrives));
  });

  // Auto-check on launch
  window.electronAPI.checkForUpdate();
}

function onUpdateStatus({ status, version, percent, message }) {
  const btn = document.getElementById('btn-check-update');
  const msg = document.getElementById('settings-update-msg');
  const footerBtn = document.getElementById('btn-footer-update');

  updateState = status;

  switch (status) {
    case 'checking':
      btn.textContent = 'Checking…';
      btn.disabled = true;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = '';
      msg.className = 'settings-update-msg hidden';
      break;

    case 'available':
      pendingVersion = version;

      // Settings panel
      btn.textContent = 'Update';
      btn.disabled = false;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = `New update available (v${version})`;
      msg.className = 'settings-update-msg update-available';

      // Show update modal if user hasn't skipped this session
      if (!updateSkipped) {
        document.getElementById('update-modal-msg').textContent =
          `Version ${version} is ready to install.`;
        document.getElementById('update-overlay').classList.remove('hidden');
      }

      // Show footer download button
      footerBtn.classList.remove('hidden');
      footerBtn.disabled = false;
      footerBtn.title = `Download v${version}`;
      footerBtn.querySelector('.material-icons').textContent = 'download';
      break;

    case 'up-to-date':
      updateState = 'idle';
      btn.textContent = 'Check for Update';
      btn.disabled = false;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = 'You are up to date.';
      msg.className = 'settings-update-msg update-current';

      footerBtn.classList.add('hidden');
      break;

    case 'downloading':
      btn.textContent = `Downloading… ${percent}%`;
      btn.disabled = true;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = `Downloading update…`;
      msg.className = 'settings-update-msg update-available';

      footerBtn.disabled = true;
      footerBtn.title = `Downloading… ${percent}%`;
      break;

    case 'ready':
      btn.textContent = 'Restart to Update';
      btn.disabled = false;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = 'Update downloaded. Restart to apply.';
      msg.className = 'settings-update-msg update-available';

      footerBtn.disabled = false;
      footerBtn.title = 'Restart to Update';
      footerBtn.querySelector('.material-icons').textContent = 'restart_alt';
      break;

    case 'error':
      updateState = 'error';
      btn.textContent = 'Retry';
      btn.disabled = false;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = 'Update check failed.';
      msg.className = 'settings-update-msg update-error';

      footerBtn.classList.add('hidden');
      break;
  }
}

// ─── Loading Overlay ─────────────────────────────────────────────────────────
function showLoading(msg = 'Loading drive data...') {
  document.getElementById('loading-overlay').querySelector('.loading-text').textContent = msg;
  document.getElementById('loading-overlay').classList.remove('hidden');
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

// ─── Processing Tab ───────────────────────────────────────────────────────────
function initProcessingTab() {
  const clipsDirInput = document.getElementById('clips-dir');

  // Restore last used folders
  const savedClipsDir = localStorage.getItem('lastClipsDir');
  if (savedClipsDir) clipsDirInput.value = savedClipsDir;

  const savedOutputDir = localStorage.getItem('lastOutputDir');
  if (savedOutputDir) document.getElementById('output-path').value = savedOutputDir;

  document.getElementById('browse-clips').addEventListener('click', async () => {
    const dir = await window.electronAPI.selectDirectory({
      defaultPath: clipsDirInput.value || undefined,
    });
    if (dir) {
      clipsDirInput.value = dir;
      localStorage.setItem('lastClipsDir', dir);
    }
  });

  document.getElementById('browse-output').addEventListener('click', async () => {
    const outputInput = document.getElementById('output-path');
    const dir = await window.electronAPI.selectDirectory({
      defaultPath: outputInput.value || undefined,
    });
    if (dir) {
      outputInput.value = dir;
      localStorage.setItem('lastOutputDir', dir);
    }
  });

  document.getElementById('btn-start').addEventListener('click', startProcessing);
  document.getElementById('btn-stop').addEventListener('click', stopProcessing);

  // Worker slider
  const slider = document.getElementById('worker-count');
  const display = document.getElementById('worker-count-display');
  slider.addEventListener('input', () => { display.textContent = slider.value; });
  document.getElementById('btn-auto-workers').addEventListener('click', () => {
    const optimal = Math.max(1, cpuCount - 1);
    slider.value = optimal;
    display.textContent = optimal;
  });

  // Load CPU count and set slider defaults
  window.electronAPI.getCpuCount().then((n) => {
    cpuCount = n;
    const optimal = Math.max(1, n - 1);
    slider.max = n;
    slider.value = optimal;
    display.textContent = optimal;
  });
}

async function loadDefaultPaths() {
  const outputInput = document.getElementById('output-path');
  if (!outputInput.value) {
    const defaultDir = await window.electronAPI.getDefaultOutputDir();
    outputInput.value = defaultDir;
  }

  // Auto-load drive-data if we have a saved path or can find one in the output dir
  const savedDriveData = localStorage.getItem('lastDriveDataPath');
  if (savedDriveData) {
    await autoLoadDriveData(savedDriveData);
  } else {
    const clipsDir = document.getElementById('clips-dir').value;
    if (clipsDir) {
      const found = await window.electronAPI.findDriveData(clipsDir);
      if (found) await autoLoadDriveData(found);
    }
  }
}

async function autoLoadDriveData(filePath) {
  showLoading();
  try {
    const result = await window.electronAPI.loadAndGroupDrives(filePath);
    if (!result.success) { hideLoading(); return; }

    loadedFilePath = filePath;
    localStorage.setItem('lastDriveDataPath', filePath);
    drives = result.drives;
    overviewRoutes = result.overviewRoutes ?? [];
    refreshAllTags(result.driveTags ?? {});
    renderTagFilter();
    renderDriveStats(drives, result);
    renderDriveList(drives);
    renderOverviewOnMap();
    document.getElementById('btn-repair-gps').disabled = false;
    updateRevertButton();

    // Switch to drives tab
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    document.querySelector('[data-tab="drives"]').classList.add('active');
    document.getElementById('tab-drives').classList.add('active');
    setTimeout(() => map.invalidateSize(), 50);
  } catch {
    // File may no longer exist — clear saved path
    localStorage.removeItem('lastDriveDataPath');
  }
  hideLoading();
}

async function startProcessing() {
  const clipsDir   = document.getElementById('clips-dir').value.trim();
  const outputDir  = document.getElementById('output-path').value.trim();

  if (!clipsDir)  { alert('Please select a clips directory.'); return; }
  if (!outputDir) { alert('Please select an output directory.'); return; }
  localStorage.setItem('lastClipsDir', clipsDir);
  localStorage.setItem('lastOutputDir', outputDir);

  // Check whether drive-data.json already exists in the output directory
  const exists = await window.electronAPI.checkDriveData(outputDir);
  if (exists) {
    appendLogLine('Found existing drive-data.json — new clips will be added incrementally.', 'warn');
  } else {
    appendLogLine('No existing drive-data.json — starting fresh.', 'normal');
  }

  const workerCount = parseInt(document.getElementById('worker-count').value, 10);

  // Reset UI
  document.getElementById('log-output').innerHTML = '';
  document.getElementById('progress-section').classList.remove('hidden');
  document.getElementById('eta-label').textContent = '';
  updateProgressBar(0);
  setProcessingButtons(true);
  processingStartTime = Date.now();

  if (removeOutputListener) removeOutputListener();

  removeOutputListener = window.electronAPI.onProcessingOutput((data) => {
    if (data.type === 'done') {
      onProcessingDone(data.code);
    } else if (data.type === 'error') {
      appendLogLine(`Error: ${data.text}`, 'error');
    } else {
      appendOutput(data);
    }
  });

  const result = await window.electronAPI.startProcessing({ clipsDir, outputDir, workerCount });
  if (!result.success && result.error) {
    appendLogLine(`Failed to start: ${result.error}`, 'error');
    onProcessingDone(-1);
  }
}

async function stopProcessing() {
  await window.electronAPI.stopProcessing();
  onProcessingDone(-2);
}

function onProcessingDone(code) {
  if (removeOutputListener) { removeOutputListener(); removeOutputListener = null; }
  setProcessingButtons(false);
  processingStartTime = null;
  document.getElementById('eta-label').textContent = '';

  if (code === 0) {
    document.getElementById('progress-phase').textContent = 'Complete!';
    appendLogLine('✓ Processing complete!', 'success');
    updateProgressBar(100);
  } else if (code === -2) {
    document.getElementById('progress-phase').textContent = 'Stopped';
    appendLogLine('● Processing stopped by user.', 'warn');
  } else if (code !== null && code !== undefined) {
    document.getElementById('progress-phase').textContent = 'Error';
    appendLogLine(`✗ Process exited with code ${code}.`, 'error');
  }
}

function setProcessingButtons(running) {
  document.getElementById('btn-start').disabled = running;
  document.getElementById('btn-stop').disabled = !running;
}

function appendOutput({ type, text }) {
  if (!text) return;

  // Simulate terminal \r: take last segment after each \r per line
  const lines = text
    .split('\n')
    .map((seg) => seg.split('\r').pop())
    .filter((l) => l.trim() !== '');

  for (const line of lines) {
    if (/^SCAN \d+\/\d+$/.test(line.trim())) continue;
    appendLogLine(line, type === 'stderr' ? 'error' : 'normal');
  }

  // Phase 1 — directory scan: "SCAN N/M" → 0–100%
  const scanMatch = text.match(/SCAN (\d+)\/(\d+)/);
  if (scanMatch) {
    const pct = Math.round((parseInt(scanMatch[1], 10) / parseInt(scanMatch[2], 10)) * 100);
    document.getElementById('progress-phase').textContent = 'Scanning…';
    updateProgressBar(pct);
  }

  // Phase 2 — GPS extraction: "(N%)" → 0–100% (resets bar)
  const extractMatch = text.match(/\((\d+)%\)/);
  if (extractMatch) {
    document.getElementById('progress-phase').textContent = 'Processing…';
    updateProgressBar(parseInt(extractMatch[1], 10));
  }
}

function appendLogLine(text, cls = 'normal') {
  const log = document.getElementById('log-output');
  const el = document.createElement('div');
  el.className = `log-line log-${cls}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function updateProgressBar(pct) {
  document.getElementById('progress-bar').style.width = `${pct}%`;
  document.getElementById('progress-label').textContent = `${pct}%`;

  if (pct > 0 && pct < 100 && processingStartTime) {
    const elapsedSec = (Date.now() - processingStartTime) / 1000;
    const remainingSec = (elapsedSec / pct) * (100 - pct);
    document.getElementById('eta-label').textContent = `ETA ${fmtDuration(remainingSec)}`;
  }
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}H ${m}M ${s}S`;
  return `${m}M ${s}S`;
}

// ─── View Drives Tab ──────────────────────────────────────────────────────────
function initViewDrivesTab() {
  document.getElementById('btn-load-drives').addEventListener('click', loadDrives);
  document.getElementById('btn-repair-gps').addEventListener('click', repairGPS);
  document.getElementById('btn-revert-gps').addEventListener('click', revertGPS);
}

async function updateRevertButton() {
  const btn = document.getElementById('btn-revert-gps');
  if (loadedFilePath) {
    const hasBackup = await window.electronAPI.hasGPSBackup(loadedFilePath);
    btn.disabled = !hasBackup;
  } else {
    btn.disabled = true;
  }
}

async function revertGPS() {
  if (!loadedFilePath) return;

  const confirmed = confirm('Revert drive data to the backup created before the last Check Drives?\n\nThis will undo any GPS repairs and bridge routes.');
  if (!confirmed) return;

  const result = await window.electronAPI.revertGPS(loadedFilePath);
  if (!result.success) {
    alert(`Failed to revert:\n${result.error}`);
    return;
  }

  // Reload
  showLoading();
  const reloaded = await window.electronAPI.loadAndGroupDrives(loadedFilePath);
  if (reloaded.success) {
    drives = reloaded.drives;
    overviewRoutes = reloaded.overviewRoutes ?? [];
    refreshAllTags(reloaded.driveTags ?? {});
    renderTagFilter();
    renderDriveStats(drives, reloaded);
    renderDriveList(drives);
    renderOverviewOnMap();
  }
  hideLoading();
  alert('Reverted to backup successfully.');
}

async function repairGPS() {
  if (!loadedFilePath) return;

  const btn = document.getElementById('btn-repair-gps');
  btn.textContent = 'Checking…';
  btn.disabled = true;

  const progressEl = document.getElementById('repair-progress');
  const phaseEl = document.getElementById('repair-phase');
  const pctEl = document.getElementById('repair-pct');
  const barEl = document.getElementById('repair-bar');

  try {
    // Check connectivity for road-snapped bridging
    const isOnline = await window.electronAPI.checkOnline();
    let useRouting = isOnline;

    if (!isOnline) {
      const proceed = confirm(
        'You are offline. Gap bridging will use straight lines instead of road-following routes.\n\n' +
        'You can re-run Check Drives later when online to replace straight lines with road routes.\n\n' +
        'Continue?'
      );
      if (!proceed) return;
    }

    // Show progress bar
    progressEl.classList.remove('hidden');
    phaseEl.textContent = 'Starting…';
    pctEl.textContent = '';
    document.getElementById('repair-eta').textContent = '';
    barEl.style.width = '0%';

    const etaEl = document.getElementById('repair-eta');
    const removeProgressListener = window.electronAPI.onRepairProgress(({ phase, current, total, etaSec }) => {
      phaseEl.textContent = phase;
      if (total > 0) {
        const pct = Math.round((current / total) * 100);
        pctEl.textContent = `${pct}%`;
        barEl.style.width = `${pct}%`;
        if (etaSec > 0) {
          const m = Math.floor(etaSec / 60);
          const s = etaSec % 60;
          etaEl.textContent = m > 0 ? `${m}m ${s}s left` : `${s}s left`;
        } else {
          etaEl.textContent = '';
        }
      }
    });

    btn.textContent = useRouting ? 'Routing…' : 'Checking…';

    const result = await window.electronAPI.repairGPS({ filePath: loadedFilePath, useRouting });
    removeProgressListener();

    if (!result.success) {
      alert(`Failed to repair GPS data:\n${result.error}`);
      return;
    }

    const msgs = [];
    if (result.removedBridges > 0) msgs.push(`Removed ${result.removedBridges} old bridge route(s)`);
    if (result.routedGaps > 0) msgs.push(`Bridged ${result.routedGaps} gap(s) with road routes`);
    const straightGaps = result.bridgedGaps - (result.routedGaps ?? 0);
    if (straightGaps > 0) msgs.push(`Bridged ${straightGaps} gap(s) with straight lines`);
    alert(msgs.length > 0 ? `Repair complete:\n${msgs.join('\n')}` : 'No issues found.');

    // Reload the repaired file
    showLoading();
    const reloaded = await window.electronAPI.loadAndGroupDrives(loadedFilePath);
    if (reloaded.success) {
      drives = reloaded.drives;
      overviewRoutes = reloaded.overviewRoutes ?? [];
      refreshAllTags(reloaded.driveTags ?? {});
      renderTagFilter();
      renderDriveStats(drives, reloaded);
      renderDriveList(drives);
      renderOverviewOnMap();
    }
    hideLoading();
  } finally {
    btn.textContent = 'Check Drives';
    btn.disabled = false;
    progressEl.classList.add('hidden');
    updateRevertButton();
  }
}

async function loadDrives() {
  const lastPath = localStorage.getItem('lastDriveDataPath');
  const filePath = await window.electronAPI.selectFile({
    filters: [{ name: 'JSON', extensions: ['json'] }],
    defaultPath: lastPath || undefined,
  });
  if (!filePath) return;

  const btn = document.getElementById('btn-load-drives');
  btn.textContent = 'Loading…';
  btn.disabled = true;
  showLoading();

  try {
    const result = await window.electronAPI.loadAndGroupDrives(filePath);

    if (!result.success) {
      alert(`Failed to load drives:\n${result.error}`);
      return;
    }

    loadedFilePath = filePath;
    localStorage.setItem('lastDriveDataPath', filePath);
    drives = result.drives;
    overviewRoutes = result.overviewRoutes ?? [];
    refreshAllTags(result.driveTags ?? {});
    renderTagFilter();
    renderDriveStats(drives, result);
    renderDriveList(drives);
    renderOverviewOnMap();
    document.getElementById('btn-repair-gps').disabled = false;
    updateRevertButton();
  } finally {
    btn.textContent = 'Load Drives';
    btn.disabled = false;
    hideLoading();
  }
}

function renderDriveStats(drives, meta) {
  const totalMi = drives.reduce((s, d) => s + d.distanceMi, 0);
  const totalMs = drives.reduce((s, d) => s + d.durationMs, 0);
  const totalHrs = Math.floor(totalMs / 3_600_000);
  const totalMin = Math.floor((totalMs % 3_600_000) / 60_000);
  const durStr = totalHrs > 0 ? `${totalHrs}H ${totalMin}M` : `${totalMin}M`;
  const clips = meta.routeCount ?? meta.totalRoutes;

  const totalDistM = drives.reduce((s, d) => s + (d.distanceKm ?? d.distanceMi * 1.60934) * 1000, 0);
  const fsdDistM = drives.reduce((s, d) => s + (d.fsdDistanceKm ?? d.fsdDistanceMi * 1.60934) * 1000, 0);
  const apDistM = drives.reduce((s, d) => s + (d.autosteerDistanceKm ?? (d.autosteerDistanceMi ?? 0) * 1.60934) * 1000, 0);
  const fsdPct = totalDistM > 0 ? Math.round((fsdDistM / totalDistM) * 100) : 0;
  const apPct = totalDistM > 0 ? Math.round((apDistM / totalDistM) * 100) : 0;

  let html = `
    <div class="map-stat"><span class="map-stat-val">${fmt(drives.length)}</span><span class="map-stat-lbl">Drives</span></div>
    <div class="map-stat"><span class="map-stat-val">${fmt(clips)}</span><span class="map-stat-lbl">Clips</span></div>
    <div class="map-stat"><span class="map-stat-val">${fmt(totalMi.toFixed(0))}</span><span class="map-stat-lbl">Miles</span></div>
    <div class="map-stat"><span class="map-stat-val">${durStr}</span><span class="map-stat-lbl">Driven</span></div>
  `;
  if (fsdPct > 0) html += `<div class="map-stat"><span class="map-stat-val">${fsdPct}%</span><span class="map-stat-lbl">Full Self-Driving</span></div>`;
  if (apPct > 0) html += `<div class="map-stat"><span class="map-stat-val">${apPct}%</span><span class="map-stat-lbl">Autopilot</span></div>`;

  const panel = document.getElementById('map-stats');
  panel.innerHTML = html;
  panel.classList.remove('hidden');
}

function renderDriveList(drives) {
  const list = document.getElementById('drives-list');
  list.innerHTML = '';

  if (drives.length === 0) {
    list.innerHTML = '<div class="empty-state">No drives found in this file.</div>';
    return;
  }

  // Reverse-chronological, filtered by active tag
  let sorted = [...drives].sort((a, b) => b.startTime.localeCompare(a.startTime));
  if (activeTagFilter) {
    sorted = sorted.filter((d) => (d.tags ?? []).includes(activeTagFilter));
  }

  if (sorted.length === 0) {
    list.innerHTML = '<div class="empty-state">No drives match the selected filter.</div>';
    return;
  }

  let currentDate = '';
  for (const drive of sorted) {
    const driveDate = drive.startTime.slice(0, 10);
    if (driveDate !== currentDate) {
      currentDate = driveDate;
      const header = document.createElement('div');
      header.className = 'drive-date-header';
      header.textContent = formatDateHeader(driveDate);
      list.appendChild(header);
    }
    list.appendChild(buildDriveItem(drive));
  }
}

function formatDateHeader(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
}

function formatTime12h(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

function assistedBadge(drive) {
  const fsd      = drive.fsdPercent      ?? 0;
  const ap       = drive.autosteerPercent ?? 0;
  const tacc     = drive.taccPercent      ?? 0;
  const assisted = drive.assistedPercent  ?? 0;
  if (!assisted) return null;
  const modeCount = (fsd > 0) + (ap > 0) + (tacc > 0);
  let label, pct;
  if (modeCount > 1) { label = 'Assisted'; pct = assisted; }
  else if (fsd)  { label = 'FSD'; pct = fsd; }
  else if (ap)   { label = 'AP'; pct = ap; }
  else if (tacc) { label = 'TACC'; pct = tacc; }
  else return null;

  let cls;
  if (fsd >= 95) cls = 'badge-green';
  else if (fsd >= 50) cls = 'badge-blue';
  else cls = 'badge-gray';

  return `<span class="drive-badge ${cls}">${pct}% ${label}</span>`;
}

function buildDriveItem(drive) {
  const item = document.createElement('div');
  item.className = 'drive-item';
  item.dataset.driveId = String(drive.id);

  const startTime = formatTime12h(drive.startTime);
  const endTime = formatTime12h(drive.endTime);
  const durStr = formatDuration(drive.durationMs);
  const badge = assistedBadge(drive);

  const disengagements = drive.fsdDisengagements ?? 0;
  const disengageHtml = disengagements > 0
    ? `<div class="drive-disengagements">${disengagements} disengagement${disengagements !== 1 ? 's' : ''}</div>`
    : '';

  const tagPills = (drive.tags ?? []).map((t) =>
    `<span class="tag-pill tag-removable" data-tag="${t}">${t}<button class="tag-remove" data-tag="${t}">&times;</button></span>`
  ).join('');

  item.innerHTML = `
    <div class="drive-item-header">
      <span class="drive-time-range">${startTime} — ${endTime}</span>
      ${badge ?? ''}
    </div>
    <div class="drive-item-stats">
      <span>${drive.distanceMi.toFixed(1)} mi</span>
      <span>${durStr}</span>
      <span>${drive.avgSpeedMph.toFixed(0)} mph</span>
    </div>
    ${disengageHtml}
    <div class="drive-item-tags">
      ${tagPills}
      <button class="tag-add-btn list-tag-add" title="Add tag">+</button>
    </div>
    <div class="list-tag-input-row hidden">
      <input type="text" class="tag-input list-tag-input" placeholder="New tag…" />
      <div class="tag-suggestions list-tag-suggestions hidden"></div>
    </div>
  `;

  // Tag remove buttons
  item.querySelectorAll('.tag-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTag(drive, btn.dataset.tag);
    });
  });

  // Tag add button
  item.querySelector('.list-tag-add').addEventListener('click', (e) => {
    e.stopPropagation();
    const row = item.querySelector('.list-tag-input-row');
    row.classList.toggle('hidden');
    if (!row.classList.contains('hidden')) {
      const input = item.querySelector('.list-tag-input');
      input.value = '';
      input.focus();
    }
  });

  // Tag input
  const tagInput = item.querySelector('.list-tag-input');
  tagInput.addEventListener('click', (e) => e.stopPropagation());
  tagInput.addEventListener('input', () => {
    showListTagSuggestions(drive, item, tagInput.value);
  });
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const val = tagInput.value.trim();
      if (val) addTag(drive, val);
      item.querySelector('.list-tag-input-row').classList.add('hidden');
    } else if (e.key === 'Escape') {
      item.querySelector('.list-tag-input-row').classList.add('hidden');
    }
  });

  item.addEventListener('click', () => selectDrive(drive));
  return item;
}

function showListTagSuggestions(drive, item, query) {
  const container = item.querySelector('.list-tag-suggestions');
  const existing = drive.tags ?? [];
  const filtered = allTags.filter((t) => !existing.includes(t) && t.toLowerCase().includes(query.toLowerCase()));

  if (filtered.length === 0 || !query) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = filtered.map((t) => `<div class="tag-suggestion" data-tag="${t}">${t}</div>`).join('');

  container.querySelectorAll('.tag-suggestion').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      addTag(drive, el.dataset.tag);
      item.querySelector('.list-tag-input-row').classList.add('hidden');
    });
  });
}

function selectDrive(drive) {
  // Toggle: clicking the same drive deselects it
  if (selectedDriveId === drive.id) {
    deselectDrive();
    return;
  }

  document.querySelectorAll('.drive-item').forEach((el) => el.classList.remove('selected'));
  const selectedEl = document.querySelector(`[data-drive-id="${drive.id}"]`);
  if (selectedEl) {
    selectedEl.classList.add('selected');
    selectedEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  selectedDriveId = drive.id;

  // Handle other drive lines based on setting
  for (const layer of overviewLayers) {
    if (layer._driveId === drive.id) {
      map.removeLayer(layer);
    } else if (hideOtherDrives) {
      map.removeLayer(layer);
    } else if (layer.setStyle) {
      layer.setStyle({ color: '#555566', opacity: 1 });
    }
  }

  document.getElementById('btn-back-overview').classList.remove('hidden');
  drawSelectedDrive(drive);
  showDriveInfo(drive);
}

function deselectDrive() {
  cleanupReplay();
  selectedDriveId = null;
  document.querySelectorAll('.drive-item').forEach((el) => el.classList.remove('selected'));
  clearLayers(selectedLayers);
  hideDriveInfo();
  document.getElementById('map-legend').classList.add('hidden');
  document.getElementById('btn-back-overview').classList.add('hidden');

  // Restore overview lines to original style
  for (const layer of overviewLayers) {
    if (!map.hasLayer(layer)) layer.addTo(map);
    if (layer.setStyle) layer.setStyle({ color: '#3b82f6', opacity: 0.5 });
  }

  // Fit map to all drives
  const allLatLngs = [];
  for (const drive of drives) {
    if (!drive.points || drive.points.length < 2) continue;
    allLatLngs.push([drive.points[0][0], drive.points[0][1]]);
    allLatLngs.push([drive.points[drive.points.length - 1][0], drive.points[drive.points.length - 1][1]]);
  }
  if (allLatLngs.length > 0) {
    map.fitBounds(L.latLngBounds(allLatLngs), { padding: [30, 30] });
  }
}

// ─── Map Drawing ──────────────────────────────────────────────────────────────
function clearLayers(arr) {
  arr.forEach((l) => map.removeLayer(l));
  arr.length = 0;
}

function renderOverviewOnMap() {
  clearLayers(overviewLayers);
  clearLayers(selectedLayers);
  selectedDriveId = null;
  hideDriveInfo();
  document.getElementById('map-legend').classList.add('hidden');

  const allLatLngs = [];

  // Draw one polyline per drive with downsampled points for performance
  for (const drive of drives) {
    if (!drive.points || drive.points.length < 2) continue;
    const lls = downsample(drive.points, 200).map((p) => [p[0], p[1]]);
    allLatLngs.push(...lls);

    const line = L.polyline(lls, {
      color: '#3b82f6',
      weight: getWeight(2.5),
      opacity: 0.5,
      smoothFactor: 1.5,
    }).addTo(map);
    line._baseWeight = 2.5;
    line._driveId = drive.id;

    line.on('click', (e) => { L.DomEvent.stopPropagation(e); selectDrive(drive); });
    overviewLayers.push(line);
  }

  if (allLatLngs.length > 0) {
    map.fitBounds(L.latLngBounds(allLatLngs), { padding: [30, 30] });
  }
}

function downsample(points, maxPoints) {
  // First pass: remove outlier points that jump >50km from both neighbors
  const clean = [];
  for (let i = 0; i < points.length; i++) {
    const lat = points[i][0], lng = points[i][1];
    if (Math.abs(lat) < 1 && Math.abs(lng) < 1) continue; // null island
    if (i === 0 || i === points.length - 1) { clean.push(points[i]); continue; }
    const prev = points[i - 1], next = points[i + 1];
    const dPrev = Math.abs(lat - prev[0]) + Math.abs(lng - prev[1]);
    const dNext = Math.abs(lat - next[0]) + Math.abs(lng - next[1]);
    // ~0.5 degrees ≈ 50km — if far from both neighbors, skip it
    if (dPrev > 0.5 && dNext > 0.5) continue;
    clean.push(points[i]);
  }
  if (clean.length <= maxPoints) return clean;
  // Second pass: evenly sample
  const step = (clean.length - 1) / (maxPoints - 1);
  const result = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    result.push(clean[Math.round(i * step)]);
  }
  result.push(clean[clean.length - 1]);
  return result;
}

function drawSelectedDrive(drive) {
  clearLayers(selectedLayers);

  const pts = drive.points;
  if (!pts || pts.length < 2) return;

  const fsd = drive.fsdStates;
  const hasFSD = Array.isArray(fsd) && fsd.length === pts.length;
  const latLngs = pts.map((p) => [p[0], p[1]]);

  if (hasFSD) {
    // Split into segments by FSD engagement
    let i = 0;
    while (i < pts.length) {
      const engaged = fsd[i] !== 0;
      let j = i + 1;
      while (j < pts.length && (fsd[j] !== 0) === engaged) j++;

      const seg = latLngs.slice(i, Math.min(j + 1, pts.length));
      const baseW = 5;
      if (seg.length >= 2) {
        const line = L.polyline(seg, {
          color: engaged ? '#22cc55' : '#2266cc',
          weight: getWeight(baseW),
          opacity: 0.95,
        }).addTo(map);
        line._baseWeight = baseW;
        selectedLayers.push(line);
      }
      i = j;
    }
  } else {
    const line = L.polyline(latLngs, {
      color: '#2266cc',
      weight: getWeight(4),
      opacity: 0.9,
    }).addTo(map);
    line._baseWeight = 4;
    selectedLayers.push(line);
  }

  // Start marker
  const startM = L.circleMarker(latLngs[0], {
    radius: 7,
    fillColor: '#22cc55',
    color: '#fff',
    weight: 2,
    fillOpacity: 1,
    opacity: 1,
  }).bindTooltip('Start').addTo(map);
  selectedLayers.push(startM);

  // End marker
  const endM = L.circleMarker(latLngs[latLngs.length - 1], {
    radius: 7,
    fillColor: '#ff3344',
    color: '#fff',
    weight: 2,
    fillOpacity: 1,
    opacity: 1,
  }).bindTooltip('End').addTo(map);
  selectedLayers.push(endM);

  // FSD event markers
  if (Array.isArray(drive.fsdEvents)) {
    for (const ev of drive.fsdEvents) {
      const disengage = ev.type === 'disengagement';
      const m = L.circleMarker([ev.lat, ev.lng], {
        radius: 5,
        fillColor: disengage ? '#ff8c00' : '#ffdd00',
        color: '#fff',
        weight: 1,
        fillOpacity: 0.9,
        opacity: 1,
      })
        .bindTooltip(disengage ? 'FSD Disengagement' : 'Accel Override')
        .addTo(map);
      selectedLayers.push(m);
    }
  }

  // Fit map to selected drive
  map.fitBounds(L.latLngBounds(latLngs), { padding: [50, 50] });

  // Show legend if FSD data present
  if (hasFSD) {
    document.getElementById('map-legend').classList.remove('hidden');
  } else {
    document.getElementById('map-legend').classList.add('hidden');
  }

  // Add replay marker at start (navigation arrow, rotatable)
  let initBearing = drive.points.length >= 2 ? smoothBearing(drive.points, 0, 5) : 0;
  // If starting in reverse, flip bearing so arrow faces front of car
  if (drive.gearStates && drive.gearStates[0] === 2) initBearing = (initBearing + 180) % 360;
  replayMarker = L.marker(latLngs[0], {
    icon: L.divIcon({
      className: '',
      html: `<img id="replay-arrow" src="../../assets/arrow.png" style="width:128px;height:128px;transform:rotate(${initBearing}deg);transition:transform 0.1s linear;filter:drop-shadow(0 0 4px rgba(0,0,0,0.5));" />`,
      iconSize: [128, 128],
      iconAnchor: [64, 64],
    }),
    zIndexOffset: 1000,
  }).addTo(map);
  selectedLayers.push(replayMarker);

  // Initialize replay
  initReplay(drive);
}

// ─── Drive Replay ────────────────────────────────────────────────────────────
const GEAR_LABELS = { 0: 'P', 1: 'D', 2: 'R', 3: 'N' };
const GEAR_CLASSES = { 0: 'gear-p', 1: 'gear-d', 2: 'gear-r', 3: 'gear-n' };
const SPEED_FACTORS = [1, 2, 5, 10];
let replayCurrentBearing = 0;

function initReplay(drive) {
  replayDrive = drive;
  replayIdx = 0;
  replaySpeed = 1;
  replayPlaying = false;
  // Initialize bearing to actual starting direction (flip if starting in reverse)
  if (drive.points.length >= 2) {
    replayCurrentBearing = smoothBearing(drive.points, 0, 5);
    if (drive.gearStates && drive.gearStates[0] === 2) replayCurrentBearing = (replayCurrentBearing + 180) % 360;
  } else {
    replayCurrentBearing = 0;
  }

  const slider = document.getElementById('replay-slider');
  slider.max = String(drive.points.length - 1);
  slider.value = '0';

  document.getElementById('replay-play-icon').textContent = 'play_arrow';
  document.getElementById('btn-replay-speed').textContent = '1x';

  // Set start/end times
  if (drive.points.length > 0) {
    document.getElementById('replay-time-start').textContent = formatReplayTime(drive.points[0][2]);
    document.getElementById('replay-time-end').textContent = formatReplayTime(drive.points[drive.points.length - 1][2]);
  }

  updateReplayData(0);
  document.getElementById('replay-bar').classList.remove('hidden');

  // Wire events
  slider.oninput = (e) => {
    if (replayPlaying) stopReplay();
    replayIdx = parseInt(e.target.value);
    updateReplayPosition(replayIdx);
  };

  document.getElementById('btn-replay-play').onclick = toggleReplay;
  document.getElementById('btn-replay-speed').onclick = cycleReplaySpeed;
}

function formatReplayTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function toggleReplay() {
  if (replayPlaying) {
    stopReplay();
  } else {
    startReplay();
  }
}

function startReplay() {
  if (!replayDrive) return;

  // If at end, restart from beginning
  if (replayIdx >= replayDrive.points.length - 1) {
    replayIdx = 0;
    updateReplayPosition(0);
  }

  replayPlaying = true;
  document.getElementById('replay-play-icon').textContent = 'pause';

  replayInterval = setInterval(() => {
    if (!replayDrive) { stopReplay(); return; }

    const next = replayIdx + 1;
    if (next >= replayDrive.points.length) {
      stopReplay();
      return;
    }

    replayIdx = next;
    updateReplayPosition(next);
  }, REPLAY_BASE_MS / replaySpeed);
}

function stopReplay() {
  replayPlaying = false;
  if (replayInterval) { clearInterval(replayInterval); replayInterval = null; }
  document.getElementById('replay-play-icon').textContent = 'play_arrow';
}

function cycleReplaySpeed() {
  const curIdx = SPEED_FACTORS.indexOf(replaySpeed);
  replaySpeed = SPEED_FACTORS[(curIdx + 1) % SPEED_FACTORS.length];
  document.getElementById('btn-replay-speed').textContent = `${replaySpeed}x`;

  // Restart interval at new speed if playing
  if (replayPlaying) {
    clearInterval(replayInterval);
    replayInterval = setInterval(() => {
      if (!replayDrive) { stopReplay(); return; }
      const next = replayIdx + 1;
      if (next >= replayDrive.points.length) { stopReplay(); return; }
      replayIdx = next;
      updateReplayPosition(next);
    }, REPLAY_BASE_MS / replaySpeed);
  }
}

function updateReplayPosition(idx) {
  if (!replayDrive) return;
  const pts = replayDrive.points;
  const pt = pts[idx];

  // Move marker with smooth transition on the Leaflet container
  if (replayMarker) {
    const el = replayMarker.getElement();
    if (el && replayPlaying) {
      el.style.transition = `transform ${REPLAY_BASE_MS / replaySpeed}ms linear`;
    } else if (el) {
      el.style.transition = 'none';
    }
    replayMarker.setLatLng([pt[0], pt[1]]);
  }

  // Rotate arrow to face the direction the front of the car points
  const arrow = document.getElementById('replay-arrow');
  if (arrow) {
    let targetBearing = smoothBearing(pts, idx, 5);

    // When reversing, the car moves backward — flip bearing so arrow
    // points where the front of the car faces, not the direction of travel
    const isReversing = replayDrive.gearStates && replayDrive.gearStates[idx] === 2;
    if (isReversing) targetBearing = (targetBearing + 180) % 360;

    // Shortest rotation path (avoid 359→1 spinning backwards)
    let diff = targetBearing - replayCurrentBearing;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    // Lerp toward target to further dampen jitter
    replayCurrentBearing += diff * 0.4;

    arrow.style.transform = `rotate(${replayCurrentBearing}deg)`;
  }

  // Update slider
  document.getElementById('replay-slider').value = String(idx);

  // Update data display
  updateReplayData(idx);
}

function calcBearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function smoothBearing(pts, idx, window) {
  // Average bearing over nearby point pairs to prevent jitter
  const start = Math.max(0, idx - Math.floor(window / 2));
  const end = Math.min(pts.length - 1, idx + Math.ceil(window / 2));
  let sinSum = 0, cosSum = 0, count = 0;
  for (let i = start; i < end; i++) {
    const b = calcBearing(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    const rad = (b * Math.PI) / 180;
    sinSum += Math.sin(rad);
    cosSum += Math.cos(rad);
    count++;
  }
  if (count === 0) return 0;
  return ((Math.atan2(sinSum / count, cosSum / count) * 180) / Math.PI + 360) % 360;
}

function updateReplayData(idx) {
  if (!replayDrive) return;
  const drive = replayDrive;
  const pt = drive.points[idx];

  // Speed (pt[3] is m/s)
  const speedMph = (pt[3] * 2.23694).toFixed(0);
  document.getElementById('replay-speed-val').textContent = `${speedMph} mph`;

  // FSD
  const fsdEl = document.getElementById('replay-fsd-val');
  const fsdSpan = document.getElementById('replay-fsd-span');
  if (drive.fsdStates && drive.fsdStates[idx] !== undefined) {
    fsdSpan.style.display = '';
    const engaged = drive.fsdStates[idx] !== 0;
    fsdEl.textContent = engaged ? 'Active' : 'Off';
    fsdEl.className = engaged ? 'fsd-on' : 'fsd-off';
  } else {
    fsdSpan.style.display = 'none';
  }
}

function cleanupReplay() {
  stopReplay();
  replayDrive = null;
  replayMarker = null;
  document.getElementById('replay-bar').classList.add('hidden');
}

// ─── Drive Info Panel ─────────────────────────────────────────────────────────
function showDriveInfo(drive) {
  const panel = document.getElementById('drive-info-panel');

  const durH = Math.floor(drive.durationMs / 3_600_000);
  const durM = Math.floor((drive.durationMs % 3_600_000) / 60_000);
  const durStr = durH > 0 ? `${durH}H ${durM}M` : `${durM}M`;
  const date   = drive.startTime.slice(0, 10);
  const startT = drive.startTime.slice(11, 16);
  const endT   = drive.endTime.slice(11, 16);

  let html = `
    <div class="info-header">
      <span class="info-date">${date}</span>
      <span class="info-time">${startT} – ${endT}</span>
    </div>
    <div class="info-grid">
      <div class="info-stat"><span class="info-val">${fmt(drive.distanceMi.toFixed(1))}</span><span class="info-unit">Miles</span></div>
      <div class="info-stat"><span class="info-val">${durStr}</span><span class="info-unit">Duration</span></div>
      <div class="info-stat"><span class="info-val">${drive.avgSpeedMph.toFixed(0)}</span><span class="info-unit">Avg MPH</span></div>
      <div class="info-stat"><span class="info-val">${drive.maxSpeedMph.toFixed(0)}</span><span class="info-unit">Max MPH</span></div>
    </div>
  `;

  const apRows = [];
  if ((drive.fsdPercent ?? 0) > 0) {
    const evts = [];
    if (drive.fsdDisengagements > 0) evts.push(`<span class="ap-evt-disengage">${drive.fsdDisengagements} disengagement${drive.fsdDisengagements !== 1 ? 's' : ''}</span>`);
    if (drive.fsdAccelPushes > 0) evts.push(`<span class="ap-evt-accel">${drive.fsdAccelPushes} accelerator press${drive.fsdAccelPushes !== 1 ? 'es' : ''}</span>`);
    apRows.push(`<div class="ap-row"><span class="ap-mode ap-fsd">FSD</span><span class="ap-pct">${drive.fsdPercent}%</span><span class="ap-dist">${fmt(drive.fsdDistanceMi.toFixed(1))} mi</span>${evts.length ? `<div class="ap-events">${evts.join('')}</div>` : ''}</div>`);
  }
  if ((drive.autosteerPercent ?? 0) > 0) {
    apRows.push(`<div class="ap-row"><span class="ap-mode ap-autosteer">AP</span><span class="ap-pct">${drive.autosteerPercent}%</span><span class="ap-dist">${fmt(drive.autosteerDistanceMi.toFixed(1))} mi</span></div>`);
  }
  if ((drive.taccPercent ?? 0) > 0) {
    apRows.push(`<div class="ap-row"><span class="ap-mode ap-tacc">TACC</span><span class="ap-pct">${drive.taccPercent}%</span><span class="ap-dist">${fmt(drive.taccDistanceMi.toFixed(1))} mi</span></div>`);
  }
  if (apRows.length) html += `<div class="info-ap">${apRows.join('')}</div>`;

  // Tags section
  const driveTags = drive.tags ?? [];
  html += `<div class="info-tags">`;
  html += `<div class="info-tags-label">Tags</div>`;
  html += `<div class="info-tags-list" id="info-tags-list">`;
  for (const t of driveTags) {
    html += `<span class="tag-pill tag-removable" data-tag="${t}">${t}<button class="tag-remove" data-tag="${t}">&times;</button></span>`;
  }
  html += `<button class="tag-add-btn" id="btn-add-tag">+</button>`;
  html += `</div>`;
  html += `<div class="tag-input-row hidden" id="tag-input-row">`;
  html += `<input type="text" class="tag-input" id="tag-input" placeholder="New tag…" />`;
  html += `<div class="tag-suggestions hidden" id="tag-suggestions"></div>`;
  html += `</div>`;
  html += `</div>`;

  panel.innerHTML = html;
  panel.classList.remove('hidden');

  // Wire up tag interactions
  panel.querySelectorAll('.tag-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTag(drive, btn.dataset.tag);
    });
  });

  document.getElementById('btn-add-tag').addEventListener('click', (e) => {
    e.stopPropagation();
    const row = document.getElementById('tag-input-row');
    row.classList.toggle('hidden');
    if (!row.classList.contains('hidden')) {
      document.getElementById('tag-input').focus();
    }
  });

  const tagInput = document.getElementById('tag-input');
  tagInput.addEventListener('input', () => showTagSuggestions(drive, tagInput.value));
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = tagInput.value.trim();
      if (val) addTag(drive, val);
    } else if (e.key === 'Escape') {
      document.getElementById('tag-input-row').classList.add('hidden');
    }
  });
}

function hideDriveInfo() {
  document.getElementById('drive-info-panel').classList.add('hidden');
}

// ─── Drive Tags ──────────────────────────────────────────────────────────────

function refreshAllTags(driveTags) {
  const set = new Set();
  for (const tags of Object.values(driveTags)) {
    for (const t of tags) set.add(t);
  }
  allTags = [...set].sort();
}

function renderTagFilter() {
  const container = document.getElementById('tag-filter');
  if (allTags.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  let html = `<button class="tag-filter-btn${activeTagFilter === '' ? ' active' : ''}" data-tag="">All</button>`;
  for (const t of allTags) {
    html += `<button class="tag-filter-btn${activeTagFilter === t ? ' active' : ''}" data-tag="${t}">${t}</button>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('.tag-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      activeTagFilter = (activeTagFilter === tag && tag !== '') ? '' : tag;
      renderTagFilter();
      renderDriveList(drives);
    });
  });
}

async function addTag(drive, tagName) {
  if (!loadedFilePath) return;
  const tags = [...(drive.tags ?? [])];
  if (tags.includes(tagName)) return;
  tags.push(tagName);

  drive.tags = tags;
  await window.electronAPI.setDriveTags({ filePath: loadedFilePath, driveKey: drive.startTime, tags });

  // Update global tag list
  if (!allTags.includes(tagName)) {
    allTags.push(tagName);
    allTags.sort();
    renderTagFilter();
  }

  // Refresh UI
  showDriveInfo(drive);
  renderDriveList(drives);
}

async function removeTag(drive, tagName) {
  if (!loadedFilePath) return;
  const tags = (drive.tags ?? []).filter((t) => t !== tagName);

  drive.tags = tags;
  await window.electronAPI.setDriveTags({ filePath: loadedFilePath, driveKey: drive.startTime, tags });

  // Rebuild global tag list (tag may no longer be used by any drive)
  const set = new Set();
  for (const d of drives) {
    for (const t of (d.tags ?? [])) set.add(t);
  }
  allTags = [...set].sort();

  // If the removed tag was the active filter and no longer exists, clear filter
  if (activeTagFilter === tagName && !allTags.includes(tagName)) {
    activeTagFilter = '';
  }

  renderTagFilter();
  showDriveInfo(drive);
  renderDriveList(drives);
}

function showTagSuggestions(drive, query) {
  const container = document.getElementById('tag-suggestions');
  const existing = drive.tags ?? [];
  const filtered = allTags.filter((t) => !existing.includes(t) && t.toLowerCase().includes(query.toLowerCase()));

  if (filtered.length === 0 || !query) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = filtered.map((t) => `<div class="tag-suggestion" data-tag="${t}">${t}</div>`).join('');

  container.querySelectorAll('.tag-suggestion').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      addTag(drive, el.dataset.tag);
    });
  });
}
