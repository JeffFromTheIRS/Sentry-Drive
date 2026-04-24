#!/usr/bin/env node
// process.js - Main entry point for drives processing
// Replicates Sentry USB drives processing for Z:\RecentClips
// Uses worker threads for parallel extraction across all CPU cores

import { Worker } from "node:worker_threads";
import { readdir, writeFile, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { groupIntoDrives, encodeByteField } from "./grouper.js";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rawArgs = process.argv.slice(2);
const REPROCESS_ALL = rawArgs.includes("--reprocess-all");
const positional = rawArgs.filter((a) => !a.startsWith("--"));

const CLIPS_DIR = positional[0] || "Z:\\RecentClips";
const OUTPUT_PATH = positional[1] || path.join(__dirname, "..", "..", "drive-data.json");
const NUM_WORKERS = positional[2]
  ? Math.max(1, parseInt(positional[2], 10))
  : Math.max(1, os.cpus().length - 1);

// Only process clips on or after this date (YYYY-MM-DD, inclusive).
const CUTOFF_DATE = "2025-12-01";

async function discoverFrontCameraFiles(clipsDir) {
  // First pass: walk through non-date folders to collect all date directories
  // and any front-camera files sitting at non-date levels.
  const dateEntries = []; // { dirPath, dateDir }
  const rootFiles   = []; // files found outside date directories

  await collectDateEntries(clipsDir, dateEntries, rootFiles, 0);
  dateEntries.sort((a, b) => a.dateDir.localeCompare(b.dateDir));

  const files = [...rootFiles];

  // Second pass: scan each date directory with progress display
  const totalDirs = dateEntries.length;
  for (let i = 0; i < dateEntries.length; i++) {
    process.stdout.write(`\rSCAN ${i + 1}/${totalDirs}`);

    const { dirPath, dateDir } = dateEntries[i];
    let mp4s;
    try {
      mp4s = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const name of mp4s) {
      if (name.endsWith("-front.mp4")) {
        files.push({
          relativePath: path.join(dateDir, name),
          fullPath: path.join(dirPath, name),
          dateDir,
        });
      }
    }
  }
  if (totalDirs > 0) process.stdout.write('\n');

  return files;
}

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

async function collectDateEntries(dir, dateEntries, rootFiles, depth) {
  if (depth > 3) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (depth === 0) {
      console.error(`Failed to read clips directory: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  for (const e of entries) {
    if (e.isDirectory()) {
      if (DATE_PREFIX_RE.test(e.name)) {
        // Date-named directory — add it for the second-pass scan
        if (e.name.slice(0, 10) >= CUTOFF_DATE) {
          dateEntries.push({ dirPath: path.join(dir, e.name), dateDir: e.name });
        }
      } else if (e.name === 'RecentClips') {
        // Only recurse into RecentClips — ignore SavedClips, SentryClips, etc.
        await collectDateEntries(path.join(dir, e.name), dateEntries, rootFiles, depth + 1);
      }
    } else if (e.name.endsWith("-front.mp4")) {
      // Front-camera file sitting outside a date directory
      const dateDir = e.name.slice(0, 10);
      if (dateDir >= CUTOFF_DATE) {
        rootFiles.push({
          relativePath: e.name,
          fullPath: path.join(dir, e.name),
          dateDir,
        });
      }
    }
  }
}

function chunkArray(arr, n) {
  const chunks = Array.from({ length: n }, () => []);
  for (let i = 0; i < arr.length; i++) {
    chunks[i % n].push(arr[i]);
  }
  return chunks.filter((c) => c.length > 0);
}

function runWorker(files, workerId, onResult) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "worker.js"), {
      workerData: { files, workerId },
    });
    worker.on("message", (msg) => {
      if (msg.type === "result") {
        onResult(msg);
      } else if (msg.type === "done") {
        resolve();
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error(`Worker ${workerId} exited with code ${code}`));
    });
  });
}

async function main() {
  const startTime = Date.now();
  console.log(`Drives Processor - Replicating Sentry USB drives processing`);
  console.log(`Clips directory: ${CLIPS_DIR}`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log(`Workers: ${NUM_WORKERS}`);
  console.log(`Cutoff: ${CUTOFF_DATE} (front camera only)`);
  console.log();

  // Load existing data if available (for incremental processing).
  // In --reprocess-all mode we still read the file so user-authored driveTags
  // survive a reprocess, but processedFiles/routes are discarded so every
  // clip is re-extracted.
  let existingData = { processedFiles: [], routes: [], driveTags: {} };
  try {
    const raw = await readFile(OUTPUT_PATH, "utf-8");
    const loaded = JSON.parse(raw);
    if (REPROCESS_ALL) {
      existingData = { processedFiles: [], routes: [], driveTags: loaded.driveTags || {} };
      console.log(`Reprocess-all mode: discarding ${loaded.processedFiles?.length || 0} processed files / ${loaded.routes?.length || 0} routes (preserving ${Object.keys(loaded.driveTags || {}).length} drive tags)`);
    } else {
      existingData = loaded;
      console.log(`Loaded existing data: ${existingData.processedFiles?.length || 0} processed files, ${existingData.routes?.length || 0} routes`);
    }
  } catch {
    // No existing data, start fresh
  }

  const processedSet = new Set();
  if (existingData.processedFiles) {
    for (const f of existingData.processedFiles) {
      processedSet.add(f);
      processedSet.add(f.replace(/\\/g, "/"));
    }
  }

  // Discover files
  console.log("Scanning for front camera clips...");
  const allFiles = await discoverFrontCameraFiles(CLIPS_DIR);
  console.log(`Found ${allFiles.length} front camera clips`);

  // Filter already processed
  const newFiles = allFiles.filter((f) => !processedSet.has(f.relativePath) && !processedSet.has(f.relativePath.replace(/\\/g, "/")));
  console.log(`New files to process: ${newFiles.length}`);

  if (newFiles.length === 0) {
    console.log("\nNo new files to process.");
    if (existingData.routes && existingData.routes.length > 0) {
      const { drives, timeGroupCount } = groupIntoDrives(existingData.routes);
      console.log(`Existing drives: ${drives.length} (from ${timeGroupCount} time groups)`);
    }
    return;
  }

  // Split files across workers
  const chunks = chunkArray(newFiles, NUM_WORKERS);
  console.log(`\nProcessing ${newFiles.length} files across ${chunks.length} workers...\n`);

  // Shared state for incremental result collection
  let filesWithGPS = 0;
  let totalPoints = 0;
  let errors = 0;
  let totalDone = 0;
  let sinceLastCheckpoint = 0;

  const CHECKPOINT_INTERVAL = 100;

  const processedFiles = [...(existingData.processedFiles || [])];
  const routeMap = new Map();

  if (existingData.routes) {
    for (const r of existingData.routes) {
      routeMap.set(r.file.replace(/\\/g, "/"), r);
    }
  }

  const driveTags = existingData.driveTags || {};

  // Called by each worker for every file result
  const onResult = ({ result, count, total }) => {
    totalDone++;
    sinceLastCheckpoint++;

    processedFiles.push(result.relativePath);

    if (result.error) {
      errors++;
    } else if (result.hasGPS) {
      filesWithGPS++;
      totalPoints += result.points.length;
      const norm = result.relativePath.replace(/\\/g, "/");
      routeMap.set(norm, {
        file: result.relativePath,
        date: result.dateDir,
        points: result.points,
        gearStates: result.gearStates,
        autopilotStates: result.autopilotStates,
        speeds: result.speeds,
        accelPositions: result.accelPositions,
        rawParkCount: result.rawParkCount,
        rawFrameCount: result.rawFrameCount,
        gearRuns: result.gearRuns,
      });
    }

    // Progress display
    const pct = Math.round((totalDone / newFiles.length) * 100);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = totalDone > 0 ? (totalDone / ((Date.now() - startTime) / 1000)).toFixed(0) : 0;
    process.stdout.write(`\r  Progress: ${totalDone}/${newFiles.length} (${pct}%) | ${rate} files/sec | ${elapsed}s elapsed`);

    // Checkpoint periodically
    if (sinceLastCheckpoint >= CHECKPOINT_INTERVAL) {
      sinceLastCheckpoint = 0;
      const routes = Array.from(routeMap.values());
      streamWriteJSON(OUTPUT_PATH, processedFiles, routes, driveTags)
        .then(() => console.log(`\n  Checkpoint saved (${totalDone} files)`))
        .catch(() => {});
    }
  };

  // Run workers in parallel
  const workerPromises = chunks.map((chunk, idx) => runWorker(chunk, idx, onResult));
  await Promise.all(workerPromises);

  const routes = Array.from(routeMap.values());

  console.log(`\n\nExtraction complete:`);
  console.log(`  Files processed: ${totalDone}`);
  console.log(`  Files with GPS:  ${filesWithGPS}`);
  console.log(`  Total points:    ${totalPoints}`);
  console.log(`  Errors:          ${errors}`);

  // Group into drives
  console.log("\nGrouping into drives...");
  const { drives, timeGroupCount, droppedCount } = groupIntoDrives(routes);
  console.log(`  Drives found: ${drives.length} (from ${timeGroupCount} time groups, ${routes.length} routes)`);
  if (droppedCount > 0) console.log(`  Routes without timestamps (dropped): ${droppedCount}`);

  // Compute aggregate stats
  let totalDistKm = 0, totalDistMi = 0, totalDurMs = 0;
  let totalFsdMs = 0, totalFsdKm = 0, totalFsdMi = 0;
  let totalDisengagements = 0, totalAccelPushes = 0;

  for (const d of drives) {
    totalDistKm += d.distanceKm;
    totalDistMi += d.distanceMi;
    totalDurMs += d.durationMs;
    totalFsdMs += d.fsdEngagedMs;
    totalFsdKm += d.fsdDistanceKm;
    totalFsdMi += d.fsdDistanceMi;
    totalDisengagements += d.fsdDisengagements;
    totalAccelPushes += d.fsdAccelPushes;
  }

  console.log(`\nAggregate Statistics:`);
  console.log(`  Total drives:       ${drives.length}`);
  console.log(`  Total routes:       ${routes.length}`);
  console.log(`  Total distance:     ${totalDistMi.toFixed(1)} mi / ${totalDistKm.toFixed(1)} km`);
  console.log(`  Total duration:     ${(totalDurMs / 3600000).toFixed(1)} hours`);
  console.log(`  FSD engaged:        ${(totalFsdMs / 3600000).toFixed(1)} hours`);
  console.log(`  FSD distance:       ${totalFsdMi.toFixed(1)} mi / ${totalFsdKm.toFixed(1)} km`);
  console.log(`  FSD %:              ${totalDistKm > 0 ? (totalFsdKm / totalDistKm * 100).toFixed(1) : 0}%`);
  console.log(`  Disengagements:     ${totalDisengagements}`);
  console.log(`  Accel pushes:       ${totalAccelPushes}`);

  // Save drive-data.json (same format as Sentry USB)
  // Stream JSON to disk to avoid exceeding Node's max string length on large datasets
  console.log(`\nSaving to ${OUTPUT_PATH}...`);
  await streamWriteJSON(OUTPUT_PATH, processedFiles, routes, driveTags);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);

  // Also copy to Sentry USB location so it can be loaded
  const sentryDataPath = path.join(
    "C:", "Users", "scott", "Documents", "Sentry-Six-Assets", "Sentry-USB",
    "drive-data.json"
  );
  try {
    await streamWriteJSON(sentryDataPath, processedFiles, routes, driveTags);
    console.log(`Also saved to ${sentryDataPath}`);
  } catch {
    // Not critical
  }
}

function routeForDisk(r) {
  return {
    ...r,
    autopilotStates: encodeByteField(r.autopilotStates),
    gearStates: encodeByteField(r.gearStates),
  };
}

function streamWriteJSON(filePath, processedFiles, routes, driveTags) {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(filePath);
    ws.on('error', reject);

    ws.write('{"processedFiles":');
    ws.write(JSON.stringify(processedFiles));

    ws.write(',"routes":[');
    for (let i = 0; i < routes.length; i++) {
      if (i > 0) ws.write(',');
      ws.write(JSON.stringify(routeForDisk(routes[i])));
    }
    ws.write(']');

    ws.write(',"driveTags":');
    ws.write(JSON.stringify(driveTags));

    ws.write('}');
    ws.end(() => resolve());
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
