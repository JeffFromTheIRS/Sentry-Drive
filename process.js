#!/usr/bin/env node
// process.js - Main entry point for drives processing
// Replicates Sentry USB drives processing for Z:\RecentClips
// Uses worker threads for parallel extraction across all CPU cores

import { Worker } from "node:worker_threads";
import { readdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { groupIntoDrives } from "./grouper.js";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLIPS_DIR = process.argv[2] || "Z:\\RecentClips";
const OUTPUT_PATH = process.argv[3] || path.join(__dirname, "drive-data.json");
const NUM_WORKERS = process.argv[4]
  ? Math.max(1, parseInt(process.argv[4], 10))
  : Math.max(1, os.cpus().length - 1);

async function discoverFrontCameraFiles(clipsDir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(clipsDir, { withFileTypes: true });
  } catch (err) {
    console.error(`Failed to read clips directory: ${err.message}`);
    process.exit(1);
  }

  const dateDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const dateDir of dateDirs) {
    const dirPath = path.join(clipsDir, dateDir);
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

  return files;
}

function chunkArray(arr, n) {
  const chunks = Array.from({ length: n }, () => []);
  for (let i = 0; i < arr.length; i++) {
    chunks[i % n].push(arr[i]);
  }
  return chunks.filter((c) => c.length > 0);
}

function runWorker(files, workerId, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "worker.js"), {
      workerData: { files, workerId },
    });
    worker.on("message", (msg) => {
      if (msg.type === "progress") {
        onProgress(msg.workerId, msg.count, msg.total);
      } else if (msg.type === "done") {
        resolve(msg.results);
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
  console.log();

  // Load existing data if available (for incremental processing)
  let existingData = { processedFiles: [], routes: [], driveTags: {} };
  try {
    const raw = await readFile(OUTPUT_PATH, "utf-8");
    existingData = JSON.parse(raw);
    console.log(`Loaded existing data: ${existingData.processedFiles?.length || 0} processed files, ${existingData.routes?.length || 0} routes`);
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
      const drives = groupIntoDrives(existingData.routes);
      console.log(`Existing drives: ${drives.length}`);
    }
    return;
  }

  // Split files across workers
  const chunks = chunkArray(newFiles, NUM_WORKERS);
  console.log(`\nProcessing ${newFiles.length} files across ${chunks.length} workers...\n`);

  // Track per-worker progress
  const workerProgress = new Array(chunks.length).fill(0);
  const workerTotals = chunks.map((c) => c.length);

  const onProgress = (workerId, count) => {
    workerProgress[workerId] = count;
    const totalDone = workerProgress.reduce((a, b) => a + b, 0);
    const pct = Math.round((totalDone / newFiles.length) * 100);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = totalDone > 0 ? (totalDone / ((Date.now() - startTime) / 1000)).toFixed(0) : 0;
    process.stdout.write(`\r  Progress: ${totalDone}/${newFiles.length} (${pct}%) | ${rate} files/sec | ${elapsed}s elapsed`);
  };

  // Run workers in parallel
  const workerPromises = chunks.map((chunk, idx) => runWorker(chunk, idx, onProgress));
  const workerResults = await Promise.all(workerPromises);

  // Collect results
  const allResults = workerResults.flat();

  let filesWithGPS = 0;
  let totalPoints = 0;
  let errors = 0;

  const processedFiles = [...(existingData.processedFiles || [])];
  const routeMap = new Map();

  if (existingData.routes) {
    for (const r of existingData.routes) {
      routeMap.set(r.file.replace(/\\/g, "/"), r);
    }
  }

  for (const result of allResults) {
    processedFiles.push(result.relativePath);

    if (result.error) {
      errors++;
      continue;
    }

    if (result.hasGPS) {
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
  }

  const routes = Array.from(routeMap.values());

  console.log(`\n\nExtraction complete:`);
  console.log(`  Files processed: ${allResults.length}`);
  console.log(`  Files with GPS:  ${filesWithGPS}`);
  console.log(`  Total points:    ${totalPoints}`);
  console.log(`  Errors:          ${errors}`);

  // Group into drives
  console.log("\nGrouping into drives...");
  const drives = groupIntoDrives(routes);
  console.log(`  Drives found: ${drives.length}`);

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
  console.log(`\nSaving to ${OUTPUT_PATH}...`);
  const storeData = {
    processedFiles,
    routes,
    driveTags: existingData.driveTags || {},
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(storeData, null, 2) + "\n");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);

  // Also copy to Sentry USB location so it can be loaded
  const sentryDataPath = path.join(
    "C:", "Users", "scott", "Documents", "Sentry-Six-Assets", "Sentry-USB",
    "drive-data.json"
  );
  try {
    await writeFile(sentryDataPath, JSON.stringify(storeData, null, 2) + "\n");
    console.log(`Also saved to ${sentryDataPath}`);
  } catch {
    // Not critical
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
