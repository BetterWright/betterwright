#!/usr/bin/env bun
// Timing lever for CLI startup. Compare `node` vs `bun` on the built CLI.
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const cli = path.join(root, "dist", "bin", "betterwright.js");
const runtime = process.argv[2];
const mode = process.argv[3] || "cli-help";
if (!runtime) {
  console.error("usage: bun scripts/bench-runtime.ts <node|bun> <cli-help|cli-version>");
  process.exit(2);
}

const args = mode === "cli-version" ? [cli, "--version"] : [cli, "--help"];
const warmup = spawnSync(runtime, args, { cwd: root, encoding: "utf8" });
if (warmup.status !== 0) {
  console.error(warmup.stderr || warmup.stdout);
  process.exit(warmup.status ?? 1);
}
const n = Number(process.env.BENCH_ITERS || 20);
const samples = [];
for (let i = 0; i < n; i++) {
  const start = process.hrtime.bigint();
  const result = spawnSync(runtime, args, { cwd: root, encoding: "utf8" });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (result.status !== 0) process.exit(result.status ?? 1);
  samples.push(ms);
}
samples.sort((a, b) => a - b);
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
const median = samples[Math.floor(samples.length / 2)];
console.log(JSON.stringify({ runtime, mode, n, min: samples[0], median, mean }));
