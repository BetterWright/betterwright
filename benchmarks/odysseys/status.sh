#!/usr/bin/env bash
#
# Point-in-time summary of an Odysseys campaign run directory.
#
# Reads only files the harness has already written — progress.jsonl,
# submission/*/result.json, submission/*/rubric-verdict.json and
# score-summary.json — so it is safe to run while a campaign is in progress and
# it reports nothing about host processes.
#
# Usage:
#   benchmarks/odysseys/status.sh [RUN_DIR] [MANIFEST]
#
#   RUN_DIR    campaign output directory (--output of exec-runner.js).
#              Default: $ODYSSEYS_RUN_DIR, else benchmarks/odysseys/runs/full-200
#   MANIFEST   task manifest, used only for the denominator.
#              Default: $ODYSSEYS_MANIFEST, else benchmarks/odysseys/full-200.json

set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"

RUN_DIR="${1:-${ODYSSEYS_RUN_DIR:-$REPO_ROOT/benchmarks/odysseys/runs/full-200}}"
MANIFEST="${2:-${ODYSSEYS_MANIFEST:-$REPO_ROOT/benchmarks/odysseys/full-200.json}}"

if [ ! -d "$RUN_DIR" ]; then
  echo "status.sh: no such run directory: $RUN_DIR" >&2
  echo "Pass one as the first argument or set ODYSSEYS_RUN_DIR." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "status.sh: node is required" >&2
  exit 1
fi

RUN_DIR="$RUN_DIR" MANIFEST="$MANIFEST" node -e '
const fs = require("node:fs");
const path = require("node:path");

const runDir = process.env.RUN_DIR;
const manifestPath = process.env.MANIFEST;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const listDirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
};

const manifest = readJson(manifestPath);
const total = manifest?.tasks?.length ?? null;
const denominator = total === null ? "?" : String(total);

console.log("Odysseys campaign status");
console.log(`  run:       ${runDir}`);
console.log(`  manifest:  ${manifestPath}${total === null ? " (unreadable)" : ` (${total} tasks)`}`);
console.log(`  as of:     ${new Date().toISOString()}`);

// --- agent progress -------------------------------------------------------
const progressFile = path.join(runDir, "progress.jsonl");
let rows = [];
if (fs.existsSync(progressFile)) {
  rows = fs
    .readFileSync(progressFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

console.log("");
console.log(`progress:    ${rows.length} / ${denominator} tasks recorded`);
if (rows.length) {
  const statuses = {};
  for (const row of rows) statuses[row.status] = (statuses[row.status] || 0) + 1;
  const parts = Object.entries(statuses).map(([k, v]) => `${k}=${v}`);
  console.log(`  statuses:  ${parts.join(", ")}`);

  const durations = rows.map((r) => r.duration_ms).filter((d) => typeof d === "number" && d > 0);
  if (durations.length) {
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    const m = (ms) => `${(ms / 60000).toFixed(1)}m`;
    console.log(`  duration:  mean ${m(mean)} (min ${m(min)}, max ${m(max)})`);
  }
  const last = rows[rows.length - 1];
  console.log(`  last:      ${String(last.task_id).slice(0, 12)}… ${last.status} at ${last.ts ?? "?"}`);
}

// --- submissions and verdicts --------------------------------------------
const submissionDir = path.join(runDir, "submission");
let submissions = 0;
let judged = 0;
for (const entry of listDirs(submissionDir)) {
  const taskDir = path.join(submissionDir, entry.name);
  if (fs.existsSync(path.join(taskDir, "result.json"))) submissions += 1;
  const verdict = readJson(path.join(taskDir, "rubric-verdict.json"));
  if (verdict?.status === "judged") judged += 1;
}
console.log("");
console.log(`submissions: ${submissions} / ${denominator}`);
console.log(`judged:      ${judged} / ${submissions || denominator}`);

// --- scores ---------------------------------------------------------------
const scores = readJson(path.join(runDir, "score-summary.json"));
console.log("");
if (!scores) {
  console.log("scores:      none yet (run judge.js to produce score-summary.json)");
} else {
  const pct = (v) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "?");
  console.log(`scores:      judged=${scores.judged ?? "?"} perfect=${pct(scores.perfect_rate)} rubric_avg=${pct(scores.rubric_average)}`);
  for (const [level, stats] of Object.entries(scores.by_level ?? {})) {
    console.log(`  ${level.padEnd(9)}n=${stats.count ?? "?"} perfect=${pct(stats.perfect_rate)} rubric_avg=${pct(stats.rubric_average)}`);
  }
  console.log("");
  console.log("score-summary.json is written by judge.js and can lag verdicts on disk;");
  console.log("re-run judge.js to refresh it.");
}
'
