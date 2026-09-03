#!/usr/bin/env bun
// Compare a built BetterWright checkout against this one on the three 1.7.1
// efficiency paths. Both targets run in fresh child processes so module caches
// and peak RSS do not bleed across samples.
//
//   bun run build:harness
//   bun benchmarks/efficiency/run.ts --baseline /path/to/built/1.7.0

import { execFileSync } from "node:child_process";
import path from "node:path";

const argv = process.argv.slice(2);
function flag(name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

const root = path.resolve(import.meta.dirname, "../..");
const baseline = path.resolve(flag("--baseline"));
const candidate = path.resolve(flag("--candidate", root));
const repeats = Math.max(1, Number(flag("--repeats", "3")) || 3);
const turns = Math.max(1, Number(flag("--turns", "2000")) || 2_000);
if (!flag("--baseline"))
  throw new Error("Pass --baseline /path/to/a built BetterWright 1.7.0 checkout.");

const AGENT_PROBE = `
import { pathToFileURL } from "node:url";
const target = process.env.BW_BENCH_TARGET;
const { runAgentTask } = await import(pathToFileURL(target + "/dist/src/agent.js"));
const turns = Number(process.env.BW_BENCH_TURNS);
let step = 0;
const model = {
  async complete() {
    step += 1;
    return step <= turns
      ? { text: "", toolCalls: [{ id: "b" + step, name: "browser", input: { code: "return 1" } }] }
      : { text: "", toolCalls: [{ id: "done", name: "done", input: { answer: "ok" } }] };
  },
};
const browser = {
  vault: null,
  async run() {
    return { ok: true, result: "Example Domain", artifacts: [], durationMs: 7 };
  },
  async close() {},
};
const start = process.hrtime.bigint();
const result = await runAgentTask({
  task: "benchmark",
  model,
  browser,
  liveView: false,
  maxTranscriptChars: 5_000_000,
});
console.log(JSON.stringify({
  ms: Number(process.hrtime.bigint() - start) / 1e6,
  steps: result.steps,
  transcript_chars: JSON.stringify(result.transcript).length,
  max_rss_kib: process.resourceUsage().maxRSS,
}));
`;

const DIFF_PROBE = String.raw`
import { pathToFileURL } from "node:url";
const target = process.env.BW_BENCH_TARGET;
const { diffSnapshots } = await import(pathToFileURL(target + "/dist/src/snapshot.js"));
const count = 3_000;
const before = Array.from({ length: count }, (_, i) => "- a" + i).join("\n");
const afterLines = process.env.BW_BENCH_DIFF === "disjoint"
  ? Array.from({ length: count }, (_, i) => "- b" + i)
  : ["- a2999", ...Array.from({ length: count - 1 }, (_, i) => "- b" + i)];
const start = process.hrtime.bigint();
const result = diffSnapshots(before, afterLines.join("\n"));
console.log(JSON.stringify({
  ms: Number(process.hrtime.bigint() - start) / 1e6,
  additions: result.additions,
  removals: result.removals,
  max_rss_kib: process.resourceUsage().maxRSS,
}));
`;

function probe(target, source, extra = {}) {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env: {
      ...process.env,
      BW_BENCH_TARGET: target,
      BW_BENCH_TURNS: String(turns),
      ...extra,
    },
  });
  return JSON.parse(output.trim());
}

function samples(target) {
  const agent = [];
  const diffDisjoint = [];
  const diffCheckpoint = [];
  for (let i = 0; i < repeats; i += 1) {
    agent.push(probe(target, AGENT_PROBE));
    diffDisjoint.push(probe(target, DIFF_PROBE, { BW_BENCH_DIFF: "disjoint" }));
    diffCheckpoint.push(probe(target, DIFF_PROBE, { BW_BENCH_DIFF: "checkpoint" }));
  }
  return { agent, diff_disjoint: diffDisjoint, diff_checkpoint: diffCheckpoint };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(samplesByName) {
  return Object.fromEntries(
    Object.entries(samplesByName).map(([name, rows]: any) => [
      name,
      {
        median_ms: median(rows.map((row) => row.ms)),
        median_max_rss_kib: median(rows.map((row) => row.max_rss_kib)),
        ...Object.fromEntries(
          Object.entries(rows[0]).filter(([key]) => !["ms", "max_rss_kib"].includes(key)),
        ),
        samples: rows,
      },
    ]),
  );
}

const result = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  repeats,
  turns,
  baseline: { path: baseline, ...summarize(samples(baseline)) },
  candidate: { path: candidate, ...summarize(samples(candidate)) },
};
console.log(JSON.stringify(result, null, 2));
