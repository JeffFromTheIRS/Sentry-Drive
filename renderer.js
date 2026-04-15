'use strict';

const fmt = (n) => Number(n).toLocaleString('en-US');

// ─── State ────────────────────────────────────────────────────────────────────
let map = null;
let overviewLayers = [];       // faint lines for all drives
let selectedLayers = [];       // highlighted route for selected drive
let drives = [];
let loadedFilePath = null;
let selectedDriveId = null;
let removeOutputListener = null;
let processingStartTime = null;
let cpuCount = 1;
let allTags = [];          // deduplicated, sorted list of all tag names
let activeTagFilter = '';  // currently active tag filter (empty = show all)

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
  return Math.max(1, base * (zoom / 10));
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
    refreshAllTags(result.driveTags ?? {});
    renderTagFilter();
    renderDriveStats(drives, result);
    renderDriveList(drives);
    renderOverviewOnMap(drives);
    document.getElementById('btn-repair-gps').disabled = false;

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
}

async function repairGPS() {
  if (!loadedFilePath) return;

  const btn = document.getElementById('btn-repair-gps');
  btn.textContent = 'Checking…';
  btn.disabled = true;

  try {
    const result = await window.electronAPI.repairGPS(loadedFilePath);
    if (!result.success) {
      alert(`Failed to repair GPS data:\n${result.error}`);
      return;
    }

    const msgs = [];
    if (result.removedPoints > 0) msgs.push(`Removed ${result.removedPoints} invalid point(s)`);
    if (result.removedRoutes > 0) msgs.push(`Removed ${result.removedRoutes} empty route(s)`);
    if (result.bridgedGaps > 0) msgs.push(`Bridged ${result.bridgedGaps} gap(s) with interpolated paths`);
    alert(msgs.length > 0 ? `Repair complete:\n${msgs.join('\n')}` : 'No issues found.');

    // Reload the repaired file
    showLoading();
    const reloaded = await window.electronAPI.loadAndGroupDrives(loadedFilePath);
    if (reloaded.success) {
      drives = reloaded.drives;
      refreshAllTags(reloaded.driveTags ?? {});
      renderTagFilter();
      renderDriveStats(drives, reloaded);
      renderDriveList(drives);
      renderOverviewOnMap(drives);
    }
    hideLoading();
  } finally {
    btn.textContent = 'Check Drives';
    btn.disabled = false;
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
    refreshAllTags(result.driveTags ?? {});
    renderTagFilter();
    renderDriveStats(drives, result);
    renderDriveList(drives);
    renderOverviewOnMap(drives);
    document.getElementById('btn-repair-gps').disabled = false;
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

  for (const drive of sorted) {
    list.appendChild(buildDriveItem(drive));
  }
}

function assistedBadge(drive) {
  const fsd      = drive.fsdPercent      ?? 0;
  const ap       = drive.autosteerPercent ?? 0;
  const tacc     = drive.taccPercent      ?? 0;
  const assisted = drive.assistedPercent  ?? 0;
  if (!assisted) return '';
  const modeCount = (fsd > 0) + (ap > 0) + (tacc > 0);
  if (modeCount > 1) return `Assisted ${assisted}%`;
  if (fsd)  return `FSD ${fsd}%`;
  if (ap)   return `AP ${ap}%`;
  if (tacc) return `TACC ${tacc}%`;
  return '';
}

function buildDriveItem(drive) {
  const item = document.createElement('div');
  item.className = 'drive-item';
  item.dataset.driveId = String(drive.id);

  const date = drive.startTime.slice(0, 10);
  const timeStr = drive.startTime.slice(11, 16);
  const durH = Math.floor(drive.durationMs / 3_600_000);
  const durM = Math.floor((drive.durationMs % 3_600_000) / 60_000);
  const durStr = durH > 0 ? `${durH}H ${durM}M` : `${durM}M`;
  const badge = assistedBadge(drive);

  const tagPills = (drive.tags ?? []).map((t) =>
    `<span class="tag-pill">${t}</span>`
  ).join('');

  item.innerHTML = `
    <div class="drive-item-header">
      <span class="drive-date">${date}</span>
      <span class="drive-time">${timeStr}</span>
    </div>
    <div class="drive-item-stats">
      <span class="drive-stat">${fmt(drive.distanceMi.toFixed(1))} mi</span>
      <span class="drive-sep">·</span>
      <span class="drive-stat">${durStr}</span>
      ${badge ? `<span class="drive-sep">·</span><span class="drive-fsd">${badge}</span>` : ''}
    </div>
    ${tagPills ? `<div class="drive-item-tags">${tagPills}</div>` : ''}
  `;

  item.addEventListener('click', () => selectDrive(drive));
  return item;
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

  // Grey out overview lines
  for (const layer of overviewLayers) {
    if (layer.setStyle) layer.setStyle({ color: '#8888a0', opacity: 1 });
  }

  document.getElementById('btn-back-overview').classList.remove('hidden');
  drawSelectedDrive(drive);
  showDriveInfo(drive);
}

function deselectDrive() {
  selectedDriveId = null;
  document.querySelectorAll('.drive-item').forEach((el) => el.classList.remove('selected'));
  clearLayers(selectedLayers);
  hideDriveInfo();
  document.getElementById('map-legend').classList.add('hidden');
  document.getElementById('btn-back-overview').classList.add('hidden');

  // Restore overview line colors
  for (const layer of overviewLayers) {
    if (layer.setStyle) layer.setStyle({ color: '#2266cc', opacity: 0.7 });
  }

  // Fit map to all drives
  const allLatLngs = [];
  for (const drive of drives) {
    if (!drive.points || drive.points.length < 2) continue;
    for (const p of drive.points) allLatLngs.push([p[0], p[1]]);
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

function renderOverviewOnMap(drives) {
  clearLayers(overviewLayers);
  clearLayers(selectedLayers);
  selectedDriveId = null;
  hideDriveInfo();
  document.getElementById('map-legend').classList.add('hidden');

  const allLatLngs = [];

  for (const drive of drives) {
    if (!drive.points || drive.points.length < 2) continue;
    const lls = drive.points.map((p) => [p[0], p[1]]);
    allLatLngs.push(...lls);

    const line = L.polyline(lls, {
      color: '#2266cc',
      weight: getWeight(2.5),
      opacity: 0.7,
    }).addTo(map);
    line._baseWeight = 2.5;

    line.on('click', (e) => { L.DomEvent.stopPropagation(e); selectDrive(drive); });
    overviewLayers.push(line);
  }

  if (allLatLngs.length > 0) {
    map.fitBounds(L.latLngBounds(allLatLngs), { padding: [30, 30] });
  }
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
    if (drive.fsdDisengagements > 0) evts.push(`${drive.fsdDisengagements} disengage`);
    if (drive.fsdAccelPushes > 0) evts.push(`${drive.fsdAccelPushes} accel`);
    apRows.push(`<div class="ap-row"><span class="ap-mode ap-fsd">FSD</span><span class="ap-pct">${drive.fsdPercent}%</span><span class="ap-dist">${fmt(drive.fsdDistanceMi.toFixed(1))} mi</span>${evts.length ? `<span class="ap-events">${evts.join(' · ')}</span>` : ''}</div>`);
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
