#!/usr/bin/env bun
// Candidate-vs-baseline browser process benchmark. The controller starts only
// loopback fixtures and runs each sample in a fresh Node process/profile.

import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const has = (name: string) => argv.includes(name);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n: number | null, digits = 2) =>
  n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** digits) / 10 ** digits;

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function summarize(values: Array<number | null>) {
  const clean = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (!clean.length) return null;
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  return {
    count: clean.length,
    median: round(median(clean)),
    mean: round(mean),
    min: round(Math.min(...clean)),
    max: round(Math.max(...clean)),
  };
}

// What the probe child reports over IPC. Every message except `result` is a
// telemetry cue the controller acknowledges with a `continue` reply.
interface ProbeResult {
  cold_startup_ms: number | null;
  warm_startup_ms: number | null;
  browser_user_agent: string | null;
  navigation_ms: Array<number | null>;
}
type ProbeMessage =
  | { type: "capture" | "monitor_start" | "monitor_stop"; name: string }
  | { type: "cpu"; name: string; duration_ms: number }
  | { type: "result"; result: ProbeResult };

async function probe() {
  const target = path.resolve(process.env.BW_BENCH_TARGET || "");
  const origin = process.env.BW_BENCH_ORIGIN || "";
  const longTurns = Number(process.env.BW_BENCH_LONG_TURNS || 100);
  const idleMs = Number(process.env.BW_BENCH_IDLE_MS || 1500);
  const activeMs = Number(process.env.BW_BENCH_ACTIVE_MS || 1500);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-browser-process-"));
  const { BetterWright, NetworkPolicy } = await import(
    pathToFileURL(path.join(target, "dist/src/index.js")).href
  );
  let bw: any = null;
  const send = (message: ProbeMessage) => process.send?.(message);
  async function chromiumRun(code: string, phase?: string) {
    if (phase) {
      const acknowledgement = once(process, "message");
      send({ type: "monitor_start", name: phase });
      await acknowledgement;
    }
    const started = performance.now();
    const result = await bw.run(code);
    const elapsed = performance.now() - started;
    if (phase) {
      const acknowledgement = once(process, "message");
      send({ type: "monitor_stop", name: phase });
      await acknowledgement;
    }
    return { result, elapsed };
  }
  async function open(label: string) {
    bw = new BetterWright({ home, policy: new NetworkPolicy(), headless: true, vault: false });
    const { result, elapsed } = await chromiumRun(
      `await page.goto(${JSON.stringify(`${origin}/quiet`)}, { waitUntil: "load" }); const userAgent = await page.evaluate(() => navigator.userAgent); await screenshot({ kind: "debug", name: ${JSON.stringify(`${label}.png`)} }); return { title: await page.title(), userAgent }`,
      `${label}_startup`,
    );
    if (!result?.ok) throw new Error(`${label} startup failed: ${result?.error || "unknown"}`);
    return { elapsed_ms: elapsed, user_agent: result.result?.userAgent || null };
  }
  try {
    const coldStartup = await open("cold");
    let acknowledgement = once(process, "message");
    send({ type: "capture", name: "cold_ready" });
    await acknowledgement;
    await bw.close();
    bw = null;

    const warmStartup = await open("warm");
    const navigationMs: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const { result, elapsed } = await chromiumRun(
        `await page.goto(${JSON.stringify(`${origin}/page?i=`)} + ${i}, { waitUntil: "load" }); await screenshot({ kind: "debug", name: "navigation.png" }); return page.title()`,
      );
      if (!result?.ok) throw new Error(`navigation failed: ${result?.error || "unknown"}`);
      if (i >= 2) navigationMs.push(elapsed);
    }

    acknowledgement = once(process, "message");
    send({ type: "cpu", name: "idle", duration_ms: idleMs });
    await sleep(idleMs);
    await acknowledgement;

    acknowledgement = once(process, "message");
    send({ type: "cpu", name: "active", duration_ms: activeMs });
    const activeUntil = performance.now() + activeMs;
    while (performance.now() < activeUntil) {
      const result = await bw.run('await screenshot({ kind: "debug", name: "active.png" }); return page.title()');
      if (!result?.ok) throw new Error(`active workload failed: ${result?.error || "unknown"}`);
    }
    await acknowledgement;

    acknowledgement = once(process, "message");
    send({ type: "capture", name: "session_start" });
    await acknowledgement;
    for (let i = 0; i < longTurns; i += 1) {
      const route = i % 10 === 0 ? `/page?turn=${i}` : "/quiet";
      const result = await bw.run(
        `await page.goto(${JSON.stringify(origin)} + ${JSON.stringify(route)}, { waitUntil: "load" }); await screenshot({ kind: "debug", name: "long-session.png" }); return page.title()`,
      );
      if (!result?.ok) throw new Error(`long-session turn ${i} failed: ${result?.error || "unknown"}`);
    }
    acknowledgement = once(process, "message");
    send({ type: "capture", name: "session_end" });
    await acknowledgement;
    send({
      type: "result",
      result: {
        cold_startup_ms: round(coldStartup.elapsed_ms),
        warm_startup_ms: round(warmStartup.elapsed_ms),
        browser_user_agent: warmStartup.user_agent || coldStartup.user_agent,
        navigation_ms: navigationMs.map((value) => round(value)),
      },
    });
  } finally {
    await bw?.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

type ProcessRow = { pid: number; ppid: number; rss_kib: number; cpu_seconds: number; command: string };
function processRows(): ProcessRow[] {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+((?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => !!match)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rss_kib: Number(match[3]),
      cpu_seconds:
        Number(match[5] || 0) * 86400 + Number(match[6] || 0) * 3600 +
        Number(match[7] || 0) * 60 + Number(match[8]),
      command: match[9],
    }));
}
function tree(rootPid: number, rows = processRows()) {
  const wanted = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (wanted.has(row.ppid) && !wanted.has(row.pid)) {
      wanted.add(row.pid);
      changed = true;
    }
  }
  return rows.filter((row) => wanted.has(row.pid));
}
function linuxPssKib(pid: number) {
  if (process.platform !== "linux") return null;
  try {
    const match = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+) kB$/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
type Capture = { process_count: number; renderer_count: number; rss_kib: number; pss_kib: number | null };
function capture(rootPid: number): Capture {
  const rows = tree(rootPid);
  const pss = rows.map((row) => linuxPssKib(row.pid));
  return {
    process_count: rows.length,
    renderer_count: rows.filter((row) => /(?:^|\s)--type=renderer(?:\s|$)/.test(row.command)).length,
    rss_kib: rows.reduce((sum, row) => sum + row.rss_kib, 0),
    pss_kib: pss.every((value) => value != null) ? pss.reduce((sum, value) => sum + (value || 0), 0) : null,
  };
}
function maxCapture(current: Capture | null, next: Capture): Capture {
  if (!current) return next;
  return {
    process_count: Math.max(current.process_count, next.process_count),
    renderer_count: Math.max(current.renderer_count, next.renderer_count),
    rss_kib: Math.max(current.rss_kib, next.rss_kib),
    pss_kib: current.pss_kib == null || next.pss_kib == null ? null : Math.max(current.pss_kib, next.pss_kib),
  };
}
async function cpuSample(rootPid: number, durationMs: number) {
  const before = tree(rootPid);
  const start = new Map(before.map((row) => [row.pid, row.cpu_seconds]));
  const began = performance.now();
  let peak: Capture | null = null;
  while (performance.now() - began < durationMs) {
    peak = maxCapture(peak, capture(rootPid));
    await sleep(Math.min(100, Math.max(1, durationMs - (performance.now() - began))));
  }
  const elapsed = performance.now() - began;
  const after = tree(rootPid);
  const cpuSeconds = after.reduce(
    (sum, row) => sum + Math.max(0, row.cpu_seconds - (start.get(row.pid) || 0)), 0,
  );
  return { cpu_percent_one_core: round((cpuSeconds * 100000) / elapsed), duration_ms: round(elapsed), peak };
}

async function startFixture() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/quiet") {
      response.end("<!doctype html><title>quiet</title><main>local fixture</main>");
    } else if (url.pathname === "/page") {
      response.end(`<!doctype html><title>page ${url.searchParams.get("i") || url.searchParams.get("turn") || "0"}</title><main>${"content ".repeat(200)}</main>`);
    } else {
      response.statusCode = 404;
      response.end("not found");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: the server just emitted "listening" on a TCP bind, so address()
  // returns an AddressInfo object, never null or a pipe name string.
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function targetMetadata(target: string) {
  const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
  const git = (args: string[]) => {
    try { return execFileSync("git", args, { cwd: target, encoding: "utf8" }).trim(); }
    catch { return null; }
  };
  return {
    path: target,
    version: pkg.version || null,
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: !!git(["status", "--porcelain"]),
    dist_index_mtime: fs.statSync(path.join(target, "dist/src/index.js")).mtime.toISOString(),
  };
}

type CpuSample = {
  cpu_percent_one_core: number | null;
  duration_ms: number | null;
  peak: Capture | null;
};
// Every phase name the probe can announce; captures and monitored peaks store
// a Capture, `cpu` cues store the sampled interval.
interface Telemetry {
  cold_ready?: Capture;
  cold_startup?: Capture;
  warm_startup?: Capture;
  session_start?: Capture;
  session_end?: Capture;
  idle_cpu?: CpuSample;
  active_cpu?: CpuSample;
}

async function runSample(target: string, origin: string, config: { longTurns: number; idleMs: number; activeMs: number }) {
  const child = fork(new URL(import.meta.url), ["--probe"], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      BW_BENCH_TARGET: target,
      BW_BENCH_ORIGIN: origin,
      BW_BENCH_LONG_TURNS: String(config.longTurns),
      BW_BENCH_IDLE_MS: String(config.idleMs),
      BW_BENCH_ACTIVE_MS: String(config.activeMs),
    },
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const metrics: Telemetry = {};
  const rootPid = child.pid;
  if (rootPid == null) throw new Error("probe process did not receive a PID");
  let result: any = null;
  let monitor: NodeJS.Timeout | null = null;
  let monitoredPeak: Capture | null = null;
  const done = new Promise<void>((resolve, reject) => {
    child.on("message", (message: any) => {
      void (async () => {
        if (message.type === "capture") metrics[message.name] = capture(rootPid);
        else if (message.type === "cpu") metrics[`${message.name}_cpu`] = await cpuSample(rootPid, message.duration_ms);
        else if (message.type === "monitor_start") {
          monitoredPeak = capture(rootPid);
          monitor = setInterval(() => { monitoredPeak = maxCapture(monitoredPeak, capture(rootPid)); }, 25);
        } else if (message.type === "monitor_stop") {
          if (monitor) clearInterval(monitor);
          monitor = null;
          metrics[message.name] = maxCapture(monitoredPeak, capture(rootPid));
          monitoredPeak = null;
        } else if (message.type === "result") result = message.result;
        if (message.type !== "result") child.send({ type: "continue" });
      })().catch(reject);
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`probe exited ${code}: ${stderr.trim()}`)));
  });
  await done;
  if (!result) throw new Error("probe exited without a result");
  return {
    ...result,
    telemetry: metrics,
    long_session_growth: {
      rss_kib: metrics.session_end.rss_kib - metrics.session_start.rss_kib,
      pss_kib: metrics.session_end.pss_kib == null || metrics.session_start.pss_kib == null
        ? null : metrics.session_end.pss_kib - metrics.session_start.pss_kib,
      process_count: metrics.session_end.process_count - metrics.session_start.process_count,
      renderer_count: metrics.session_end.renderer_count - metrics.session_start.renderer_count,
    },
  };
}

// One runSample() record per repeat, keyed by which checkout produced it.
interface SamplesByTarget {
  baseline: any[];
  candidate: any[];
}

function targetSummary(samples: any[]) {
  const field = (getter: (sample: any) => number | null) => summarize(samples.map(getter));
  return {
    cold_startup_ms: field((sample) => sample.cold_startup_ms),
    warm_startup_ms: field((sample) => sample.warm_startup_ms),
    navigation_ms: summarize(samples.flatMap((sample) => sample.navigation_ms)),
    cold_startup_peak_rss_kib: field((sample) => sample.telemetry.cold_startup.rss_kib),
    cold_startup_peak_pss_kib: field((sample) => sample.telemetry.cold_startup.pss_kib),
    warm_startup_peak_rss_kib: field((sample) => sample.telemetry.warm_startup.rss_kib),
    warm_startup_peak_pss_kib: field((sample) => sample.telemetry.warm_startup.pss_kib),
    active_peak_renderer_count: field((sample) => sample.telemetry.active_cpu.peak?.renderer_count ?? null),
    idle_cpu_percent_one_core: field((sample) => sample.telemetry.idle_cpu.cpu_percent_one_core),
    active_cpu_percent_one_core: field((sample) => sample.telemetry.active_cpu.cpu_percent_one_core),
    long_session_rss_growth_kib: field((sample) => sample.long_session_growth.rss_kib),
    long_session_pss_growth_kib: field((sample) => sample.long_session_growth.pss_kib),
    samples,
  };
}

async function main() {
  if (has("--probe")) return probe();
  if (has("--help")) {
    console.log("Usage: bun benchmarks/browser-process/run.ts --baseline PATH [--candidate PATH] [--repeats 5] [--long-turns 100] [--output FILE] [--quick]");
    return;
  }
  if (!flag("--baseline")) throw new Error("Pass --baseline /path/to/a built BetterWright checkout");
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error(`Unsupported platform ${process.platform}; this harness supports macOS and Linux`);
  const root = path.resolve(import.meta.dirname, "../..");
  const baseline = path.resolve(flag("--baseline"));
  const candidate = path.resolve(flag("--candidate", root));
  const quick = has("--quick");
  const repeats = Math.max(3, Number(flag("--repeats", quick ? "3" : "7")) || 7);
  const config = {
    longTurns: Math.max(10, Number(flag("--long-turns", quick ? "20" : "100")) || 100),
    idleMs: Math.max(500, Number(flag("--idle-ms", quick ? "750" : "2000")) || 2000),
    activeMs: Math.max(500, Number(flag("--active-ms", quick ? "750" : "2000")) || 2000),
  };
  for (const target of [baseline, candidate]) {
    for (const required of ["package.json", "dist/src/index.js"])
      if (!fs.existsSync(path.join(target, required))) throw new Error(`${target} is not built: missing ${required}`);
  }
  const fixture = await startFixture();
  const samples: SamplesByTarget = { baseline: [], candidate: [] };
  try {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      // Alternate order to reduce thermal/background drift bias.
      const order = repeat % 2 ? [["candidate", candidate], ["baseline", baseline]] : [["baseline", baseline], ["candidate", candidate]];
      for (const [name, target] of order) {
        process.stderr.write(`[${repeat + 1}/${repeats}] ${name}\n`);
        samples[name].push(await runSample(target, fixture.origin, config));
      }
    }
  } finally {
    await fixture.close();
  }
  const payload = {
    schema_version: "betterwright-browser-process-v1",
    created_at: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      os_release: os.release(),
      node: process.version,
      cpu_model: os.cpus()[0]?.model || null,
      logical_cpus: os.cpus().length,
      total_memory_bytes: os.totalmem(),
    },
    metric_support: {
      rss: { supported: true, source: "ps summed over the probe process tree" },
      pss: process.platform === "linux"
        ? { supported: true, source: "/proc/<pid>/smaps_rollup; null if any process is unreadable" }
        : { supported: false, reason: "macOS does not expose Linux-style proportional set size" },
      cpu: { supported: true, source: "delta of ps cumulative CPU time over a fixed wall interval; 100% equals one core" },
      renderer_count: { supported: true, source: "peak process-tree command lines sampled every 25-100 ms during Chromium-backed work" },
    },
    config: { repeats, navigation_warmups: 2, navigation_samples_per_repeat: 5, ...config, fixture: "loopback HTTP only" },
    targets: { baseline: targetMetadata(baseline), candidate: targetMetadata(candidate) },
    baseline: targetSummary(samples.baseline),
    candidate: targetSummary(samples.candidate),
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const output = flag("--output");
  if (output) fs.writeFileSync(path.resolve(output), json);
  process.stdout.write(json);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
