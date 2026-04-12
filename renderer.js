'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let map = null;
let overviewLayers = [];       // faint lines for all drives
let selectedLayers = [];       // highlighted route for selected drive
let drives = [];
let selectedDriveId = null;
let removeOutputListener = null;
let processingStartTime = null;
let cpuCount = 1;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initTabs();
  initProcessingTab();
  initViewDrivesTab();
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

// ─── Processing Tab ───────────────────────────────────────────────────────────
function initProcessingTab() {
  document.getElementById('browse-clips').addEventListener('click', async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) document.getElementById('clips-dir').value = dir;
  });

  document.getElementById('browse-output').addEventListener('click', async () => {
    const file = await window.electronAPI.selectFile({
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (file) document.getElementById('output-path').value = file;
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
  const defaultPath = await window.electronAPI.getDefaultOutputPath();
  document.getElementById('output-path').value = defaultPath;
}

async function startProcessing() {
  const clipsDir = document.getElementById('clips-dir').value.trim();
  const outputPath = document.getElementById('output-path').value.trim();

  if (!clipsDir) { alert('Please select a clips directory.'); return; }
  if (!outputPath) { alert('Please specify an output file path.'); return; }

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

  const result = await window.electronAPI.startProcessing({ clipsDir, outputPath, workerCount });
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
    appendLogLine('✓ Processing complete!', 'success');
    updateProgressBar(100);
  } else if (code === -2) {
    appendLogLine('● Processing stopped by user.', 'warn');
  } else if (code !== null && code !== undefined) {
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
    appendLogLine(line, type === 'stderr' ? 'error' : 'normal');
  }

  const match = text.match(/\((\d+)%\)/);
  if (match) updateProgressBar(parseInt(match[1], 10));
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
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

// ─── View Drives Tab ──────────────────────────────────────────────────────────
function initViewDrivesTab() {
  document.getElementById('btn-load-drives').addEventListener('click', loadDrives);
}

async function loadDrives() {
  const filePath = await window.electronAPI.selectFile({
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!filePath) return;

  const btn = document.getElementById('btn-load-drives');
  btn.textContent = 'Loading…';
  btn.disabled = true;

  try {
    const result = await window.electronAPI.loadAndGroupDrives(filePath);

    if (!result.success) {
      alert(`Failed to load drives:\n${result.error}`);
      return;
    }

    drives = result.drives;
    renderDriveStats(drives, result);
    renderDriveList(drives);
    renderOverviewOnMap(drives);
  } finally {
    btn.textContent = 'Load Drives';
    btn.disabled = false;
  }
}

function renderDriveStats(drives, meta) {
  const totalMi = drives.reduce((s, d) => s + d.distanceMi, 0);
  const totalHrs = drives.reduce((s, d) => s + d.durationMs, 0) / 3_600_000;

  document.getElementById('drives-stats').innerHTML = `
    <div class="stats-grid">
      <div class="stat">
        <span class="stat-val">${drives.length}</span>
        <span class="stat-lbl">Drives</span>
      </div>
      <div class="stat">
        <span class="stat-val">${totalMi.toFixed(0)}</span>
        <span class="stat-lbl">Miles</span>
      </div>
      <div class="stat">
        <span class="stat-val">${totalHrs.toFixed(1)}</span>
        <span class="stat-lbl">Hours</span>
      </div>
      <div class="stat">
        <span class="stat-val">${meta.totalRoutes}</span>
        <span class="stat-lbl">Clips</span>
      </div>
    </div>
  `;
}

function renderDriveList(drives) {
  const list = document.getElementById('drives-list');
  list.innerHTML = '';

  if (drives.length === 0) {
    list.innerHTML = '<div class="empty-state">No drives found in this file.</div>';
    return;
  }

  // Reverse-chronological
  const sorted = [...drives].sort((a, b) => b.startTime.localeCompare(a.startTime));

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
  const durStr = durH > 0 ? `${durH}h ${durM}m` : `${durM}m`;
  const badge = assistedBadge(drive);

  item.innerHTML = `
    <div class="drive-item-header">
      <span class="drive-date">${date}</span>
      <span class="drive-time">${timeStr}</span>
    </div>
    <div class="drive-item-stats">
      <span class="drive-stat">${drive.distanceMi.toFixed(1)} mi</span>
      <span class="drive-sep">·</span>
      <span class="drive-stat">${durStr}</span>
      ${badge ? `<span class="drive-sep">·</span><span class="drive-fsd">${badge}</span>` : ''}
    </div>
  `;

  item.addEventListener('click', () => selectDrive(drive));
  return item;
}

function selectDrive(drive) {
  document.querySelectorAll('.drive-item').forEach((el) => el.classList.remove('selected'));
  document.querySelector(`[data-drive-id="${drive.id}"]`)?.classList.add('selected');
  selectedDriveId = drive.id;
  drawSelectedDrive(drive);
  showDriveInfo(drive);
}

// ─── Map Drawing ──────────────────────────────────────────────────────────────
function clearLayers(arr) {
  arr.forEach((l) => map.removeLayer(l));
  arr.length = 0;
}

function renderOverviewOnMap(drives) {
  clearLayers(overviewLayers);
  clearLayers(selectedLayers);
  hideDriveInfo();
  document.getElementById('map-legend').classList.add('hidden');

  const allLatLngs = [];

  for (const drive of drives) {
    if (!drive.points || drive.points.length < 2) continue;
    const lls = drive.points.map((p) => [p[0], p[1]]);
    allLatLngs.push(...lls);

    const line = L.polyline(lls, {
      color: '#1a3050',
      weight: 1.5,
      opacity: 0.7,
    }).addTo(map);

    line.on('click', () => selectDrive(drive));
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
      if (seg.length >= 2) {
        const line = L.polyline(seg, {
          color: engaged ? '#00ccff' : 'rgba(180,210,240,0.75)',
          weight: engaged ? 4 : 2.5,
          opacity: 0.95,
        }).addTo(map);
        selectedLayers.push(line);
      }
      i = j;
    }
  } else {
    const line = L.polyline(latLngs, {
      color: '#00ccff',
      weight: 3,
      opacity: 0.9,
    }).addTo(map);
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

// ─── Drive Info Overlay ───────────────────────────────────────────────────────
function showDriveInfo(drive) {
  const panel = document.getElementById('drive-info-panel');

  const durH = Math.floor(drive.durationMs / 3_600_000);
  const durM = Math.floor((drive.durationMs % 3_600_000) / 60_000);
  const durStr = durH > 0 ? `${durH}h ${durM}m` : `${durM}m`;
  const date   = drive.startTime.slice(0, 10);
  const startT = drive.startTime.slice(11, 16);
  const endT   = drive.endTime.slice(11, 16);

  // Build per-mode AP rows
  const apRows = [];

  if ((drive.fsdPercent ?? 0) > 0) {
    const evts = [];
    if (drive.fsdDisengagements > 0) evts.push(`${drive.fsdDisengagements} disengage`);
    if (drive.fsdAccelPushes    > 0) evts.push(`${drive.fsdAccelPushes} accel`);
    apRows.push(`
      <div class="ap-row">
        <span class="ap-mode ap-fsd">FSD</span>
        <span class="ap-pct">${drive.fsdPercent}%</span>
        <span class="ap-dist">${drive.fsdDistanceMi.toFixed(1)} mi</span>
        ${evts.length ? `<span class="ap-events">${evts.join(' · ')}</span>` : ''}
      </div>`);
  }

  if ((drive.autosteerPercent ?? 0) > 0) {
    apRows.push(`
      <div class="ap-row">
        <span class="ap-mode ap-autosteer">AP</span>
        <span class="ap-pct">${drive.autosteerPercent}%</span>
        <span class="ap-dist">${drive.autosteerDistanceMi.toFixed(1)} mi</span>
      </div>`);
  }

  if ((drive.taccPercent ?? 0) > 0) {
    apRows.push(`
      <div class="ap-row">
        <span class="ap-mode ap-tacc">TACC</span>
        <span class="ap-pct">${drive.taccPercent}%</span>
        <span class="ap-dist">${drive.taccDistanceMi.toFixed(1)} mi</span>
      </div>`);
  }

  panel.innerHTML = `
    <div class="info-header">
      <span class="info-date">${date}</span>
      <span class="info-time">${startT} – ${endT}</span>
    </div>
    <div class="info-grid">
      <div class="info-stat">
        <span class="info-val">${drive.distanceMi.toFixed(1)}</span>
        <span class="info-unit">miles</span>
      </div>
      <div class="info-stat">
        <span class="info-val">${durStr}</span>
        <span class="info-unit">duration</span>
      </div>
      <div class="info-stat">
        <span class="info-val">${drive.avgSpeedMph.toFixed(0)}</span>
        <span class="info-unit">avg mph</span>
      </div>
      <div class="info-stat">
        <span class="info-val">${drive.maxSpeedMph.toFixed(0)}</span>
        <span class="info-unit">max mph</span>
      </div>
    </div>
    ${apRows.length ? `<div class="info-ap">${apRows.join('')}</div>` : ''}
  `;

  panel.classList.remove('hidden');
}

function hideDriveInfo() {
  document.getElementById('drive-info-panel').classList.add('hidden');
}
