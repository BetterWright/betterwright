#!/usr/bin/env node
// BetterWright round-trip benchmark. Measures the three costs the perf plan
// (docs: "eliminate per-request IPC and per-action CDP round-trips") targets,
// against a purely LOCAL http fixture so the numbers describe BetterWright's
// own overhead rather than the internet:
//
//   A. per-action latency  — `run()` of a trivial snippet on a loaded static
//      page. This is the floor every agent action pays: client→worker stdio
//      RPC, sandbox realm + compile, execute, challenge scan, envelope build.
//      Measured TWICE — once at the start of the session and once between the
//      two iframe benchmarks — so per-session drift is quantified rather than
//      silently charged to the iframes.
//   B. page-load wall time + guard RPC count — one page pulling ~50
//      subresources across 4 distinct `127.0.0.1:<port>` origins. Distinct
//      ports mean distinct guard cache keys, which is what Phase A's worker
//      side LRU has to cope with. The guard-RPC counters are the Phase A
//      target metric: today every subresource costs at least one stdio
//      round-trip, and every fresh connection costs several more.
//   C. challenge-scan cost — the same trivial snippet, but on a page with N
//      benign CROSS-SITE iframes. `detectSessionChallenges` walks every frame
//      on every execute, so C − A' is the per-action frame-walk tax Phase B
//      removes. Measured at 10 and 24 frames (24 = the hard cap in
//      `collectFrameMetadata`) so the scaling is data, not extrapolation.
//
// Run it:
//     npm run build:harness
//     node benchmarks/perf/run.js [--quick] [--label <name>] [--iframes 10,24]
//
// Results are merged into results.json under
// `runs["<label>[-quick]-<short sha>"]`, so a baseline run and a post-PR run
// sit side by side in one file and a `--quick` smoke run can never overwrite a
// recorded full-fidelity baseline. Nothing here touches the external network,
// so it is reproducible on any machine with the browser runtime installed
// (`betterwright setup`).

import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BetterWright, NetworkPolicy } from "../../dist/src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results.json");

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

// `--quick` trades statistical confidence for a ~4x faster smoke run. Use it
// while editing the harness; use the defaults for anything you record. Quick
// runs get their own results key so they cannot clobber a real baseline.
const QUICK = has("--quick");
const LABEL = String(flag("--label", "baseline"));
const FORCE = has("--force");

const ACTION_ITERS = QUICK ? 20 : 100;
const ACTION_WARMUP = 5;
const LOAD_ITERS = QUICK ? 3 : 10;
const LOAD_WARMUP = 1;
const CHALLENGE_ITERS = QUICK ? 10 : 30;
const CHALLENGE_WARMUP = 3;

const SUBRESOURCE_COUNT = 50; // spread across ORIGIN_COUNT servers
const ORIGIN_COUNT = 4;
// Every measured /heavy load must produce exactly this many fixture requests:
// the document itself plus every subresource. Asserted, not assumed — see
// `fixture_requests_per_load`.
const EXPECTED_FIXTURE_REQUESTS = SUBRESOURCE_COUNT + 1;

// `collectFrameMetadata` (src/worker.ts) hard-caps the walk at 24 frames, so 24
// is the worst case the product can reach and 10 is the plan's stated scenario.
const IFRAME_COUNTS = has("--iframes")
  ? String(flag("--iframes", "10"))
      .split(",")
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  : QUICK
    ? [10]
    : [10, 24];
if (!IFRAME_COUNTS.length)
  throw new Error("--iframes needs at least one positive integer, e.g. --iframes 10,24");
const MAX_IFRAMES = Math.max(...IFRAME_COUNTS);

// Benchmark C's frames must be CROSS-SITE, not just cross-port: Chromium's site
// isolation keys on scheme + eTLD+1 and ignores the port, so `127.0.0.1:A` and
// `127.0.0.1:B` share one renderer and their frame walks are cheap in-process
// CDP. Distinct loopback IPs are distinct sites, so these frames become real
// OOPIFs with their own targets — which is what an ad-heavy page actually
// looks like. 127.0.0.0/8 is entirely local on Linux, so binding these needs no
// setup.
const FRAME_HOSTS = ["127.0.0.2", "127.0.0.3"];

// ---------------------------------------------------------------- statistics

function quantile(sorted, q) {
  if (!sorted.length) return null;
  // Nearest-rank. With n=100 that makes p95 the 95th slowest sample, which is
  // the reading people expect from a latency table.
  const rank = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, rank)];
}

function round(value) {
  return value === null || value === undefined ? null : Math.round(value * 100) / 100;
}

function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
  return {
    count: v.length,
    p50_ms: round(quantile(v, 0.5)),
    p95_ms: round(quantile(v, 0.95)),
    mean_ms: round(mean),
    stdev_ms: round(Math.sqrt(variance)),
    min_ms: round(v[0]),
    max_ms: round(v[v.length - 1]),
  };
}

function countStats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return {
    count: v.length,
    p50: quantile(v, 0.5),
    mean: round(v.reduce((a, b) => a + b, 0) / v.length),
    min: v[0],
    max: v[v.length - 1],
  };
}

const log = (line) => process.stderr.write(`${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ fixtures

// 1x1 transparent GIF. Small enough that transfer time is noise and the cost
// being measured is purely per-request: guard RPC + route interception.
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function iframeBody(index) {
  // Enough text that `innerText` extraction is not free — a frame-scan sample
  // with an empty body would understate the cost the plan is chasing.
  const paragraph =
    "This is a benign iframe with ordinary prose in it, present only so the " +
    "per-frame text extraction has something to extract and the measurement " +
    "reflects a realistic embedded document rather than an empty one. ";
  return (
    `<!doctype html><meta charset="utf-8"><title>Frame ${index}</title>` +
    `<body><h1>Benign frame ${index}</h1><p>${paragraph.repeat(6)}</p></body>`
  );
}

async function startFixtureServer(indexOfServer, refs, host = "127.0.0.1") {
  // Request counting is the only thing that turns "no-store means every load
  // re-fetches all 50 subresources" from an assumption into an assertion. The
  // guard-RPC count is the number under test, so it cannot also be the evidence
  // that the requests happened — that reasoning is circular.
  let measured = 0;
  let total = 0;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${host}`);
    const pathname = url.pathname;
    total++;
    if (pathname === "/heavy" || pathname.startsWith("/asset/")) measured++;
    // Everything is no-store so each load re-fetches every subresource. Cache
    // hits would silently collapse the guard-RPC count and make the page-load
    // benchmark measure nothing.
    const nocache = { "cache-control": "no-store, no-cache, must-revalidate" };

    if (pathname === "/static") {
      response.writeHead(200, { ...nocache, "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><meta charset="utf-8"><title>Static fixture</title>' +
          "<body><h1>Static fixture</h1><p>No subresources, no frames.</p></body>",
      );
      return;
    }

    if (pathname === "/heavy") {
      // Subresources are dealt round-robin across every fixture origin, so the
      // load crosses ORIGIN_COUNT distinct host:port guard keys.
      const origins = refs.origins;
      const parts = [];
      for (let i = 0; i < SUBRESOURCE_COUNT; i++) {
        const origin = origins[i % origins.length];
        parts.push(
          i % 5 === 0
            ? `<script src="${origin}/asset/${i}.js"></script>`
            : `<img alt="" width="1" height="1" src="${origin}/asset/${i}.gif">`,
        );
      }
      response.writeHead(200, { ...nocache, "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><meta charset="utf-8"><title>Heavy fixture</title>' +
          `<body><h1>Heavy fixture</h1>${parts.join("")}</body>`,
      );
      return;
    }

    if (pathname === "/frames") {
      const wanted = Math.max(0, Number(url.searchParams.get("n") || MAX_IFRAMES));
      const frameOrigins = refs.frameOrigins;
      const frames = [];
      for (let i = 0; i < wanted; i++) {
        const origin = frameOrigins[i % frameOrigins.length];
        frames.push(
          `<iframe title="f${i}" width="200" height="80" src="${origin}/frame/${i}"></iframe>`,
        );
      }
      response.writeHead(200, { ...nocache, "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><meta charset="utf-8"><title>Frames fixture</title>' +
          `<body><h1>Frames fixture</h1>${frames.join("")}</body>`,
      );
      return;
    }

    if (pathname.startsWith("/frame/")) {
      response.writeHead(200, { ...nocache, "content-type": "text/html; charset=utf-8" });
      response.end(iframeBody(pathname.slice("/frame/".length)));
      return;
    }

    if (pathname.endsWith(".js")) {
      response.writeHead(200, { ...nocache, "content-type": "application/javascript" });
      response.end(`/* asset ${pathname} on server ${indexOfServer} */\n`);
      return;
    }

    if (pathname.endsWith(".gif")) {
      response.writeHead(200, { ...nocache, "content-type": "image/gif" });
      response.end(PIXEL);
      return;
    }

    response.writeHead(404, nocache);
    response.end("not found");
  });

  server.listen(0, host);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${host}:${port}`,
    host,
    port,
    resetHits() {
      measured = 0;
      total = 0;
    },
    hits() {
      return { measured, total };
    },
    // Dropping keep-alive sockets between loads is what makes every measured
    // load pay the SOCKS proxy's per-connection guards, instead of only the
    // first one paying them (n=1) and the rest hiding them.
    dropConnections() {
      server.closeAllConnections?.();
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// -------------------------------------------------------------- measurements

async function timedRun(bw, code) {
  const start = performance.now();
  const result = await bw.run(code);
  const elapsed = performance.now() - start;
  if (!result?.ok) throw new Error(`snippet failed: ${result?.error || "unknown error"}`);
  return { elapsed, result };
}

const TRIVIAL = "return page.title()";

async function measurePerAction(bw, origin, tag) {
  log(`\n[${tag}] per-action latency, 0 frames — ${ACTION_WARMUP} warmup + ${ACTION_ITERS} iterations`);
  const goto = await timedRun(
    bw,
    `await page.goto(${JSON.stringify(`${origin}/static`)}); return page.title()`,
  );
  log(`    loaded ${origin}/static in ${goto.elapsed.toFixed(0)}ms`);
  for (let i = 0; i < ACTION_WARMUP; i++) await timedRun(bw, TRIVIAL);
  const samples = [];
  for (let i = 0; i < ACTION_ITERS; i++) {
    const { elapsed } = await timedRun(bw, TRIVIAL);
    samples.push(elapsed);
    if ((i + 1) % 25 === 0) log(`    ${i + 1}/${ACTION_ITERS}`);
  }
  return stats(samples);
}

async function measurePageLoad(bw, origin, guard, servers) {
  log(
    `\n[B] page load + guard RPCs — ${LOAD_WARMUP} warmup + ${LOAD_ITERS} loads, ${SUBRESOURCE_COUNT} subresources / ${ORIGIN_COUNT} origins`,
  );
  const wall = [];
  const inner = [];
  const routeRpcs = [];
  const transportRpcs = [];
  const fixtureRequests = [];
  // The warmup load is discarded: it is the only one whose renderer, socket
  // pool and worker state have never seen this fixture. It is reported as
  // `first_load` with n=1 and is NOT a headline metric.
  let firstLoad = null;

  for (let i = 0; i < LOAD_WARMUP + LOAD_ITERS; i++) {
    // Cache-busting query string on top of no-store: belt and braces, since a
    // repeat of the identical URL is the one thing that could let the browser
    // skip the request entirely.
    const url = `${origin}/heavy?load=${i}-${Date.now()}`;
    // about:blank first so each measurement starts from a torn-down document
    // rather than a warm one that may reuse subresources.
    await timedRun(bw, "await page.goto('about:blank'); return 'reset'");
    // Drop every keep-alive socket so the next load is connection-cold. Without
    // this, only the first load pays the SOCKS proxy's per-connection guards
    // and the connection-scoped cost is an n=1 anecdote.
    for (const server of servers) server.dropConnections();
    // Settle BEFORE the reset, not only after: tearing down the previous
    // document produces trailing guard RPCs, and resetting the counter the
    // instant `goto` returns attributes those stragglers to the next load. That
    // is what made the steady-state count drift 51 -> 61 between runs.
    await sleep(250);
    guard.reset();
    for (const server of servers) server.resetHits();

    const start = performance.now();
    const { result } = await timedRun(
      bw,
      `const t0 = Date.now();
       await page.goto(${JSON.stringify(url)}, { waitUntil: 'load' });
       await page.waitForLoadState('networkidle').catch(() => {});
       return Date.now() - t0;`,
    );
    const elapsed = performance.now() - start;
    // Guard RPCs are serviced on the host as the worker asks; the last few can
    // land microtasks after networkidle resolves. A short settle keeps the
    // count honest without meaningfully inflating it.
    await sleep(250);
    const counts = guard.count();
    const requests = servers.reduce((sum, server) => sum + server.hits().measured, 0);

    if (i < LOAD_WARMUP) {
      // Liveness: if a refactor moves the guard off `_serviceRpc`, the counter
      // reads 0 and a broken hook looks exactly like a total Phase A win.
      if (!counts.route)
        throw new Error(
          "guard counter never fired: the client._serviceRpc hook is stale (no method === 'guard' RPCs observed)",
        );
      firstLoad = {
        note: "n=1 warmup load, discarded from the series; kept only as a sanity reading",
        guard_rpcs_route: counts.route,
        guard_rpcs_transport: counts.transport,
        fixture_requests: requests,
        wall_ms: round(elapsed),
      };
      log(
        `    warmup load: ${elapsed.toFixed(0)}ms wall, ${counts.route} route + ${counts.transport} transport guard RPCs, ${requests} fixture requests`,
      );
      continue;
    }

    // The core assumption of this benchmark, asserted rather than assumed: if
    // the memory cache ever starts serving `/asset/N.gif`, the guard count
    // collapses and would otherwise read as a Phase A win.
    if (requests !== EXPECTED_FIXTURE_REQUESTS)
      throw new Error(
        `fixture served ${requests} requests on load ${i - LOAD_WARMUP + 1}, expected ${EXPECTED_FIXTURE_REQUESTS} ` +
          `(1 document + ${SUBRESOURCE_COUNT} subresources). Something is serving subresources from cache; ` +
          "the guard-RPC counts for this run are not comparable.",
      );

    wall.push(elapsed);
    inner.push(Number(result.result));
    routeRpcs.push(counts.route);
    transportRpcs.push(counts.transport);
    fixtureRequests.push(requests);
    log(
      `    load ${i - LOAD_WARMUP + 1}/${LOAD_ITERS}: ${elapsed.toFixed(0)}ms wall, ${result.result}ms in-page, ` +
        `${counts.route} route + ${counts.transport} transport guard RPCs, ${requests} fixture requests`,
    );
  }

  const routeMean = routeRpcs.length
    ? routeRpcs.reduce((a, b) => a + b, 0) / routeRpcs.length
    : null;
  return {
    wall_time: stats(wall),
    navigation_time: stats(inner),
    guard_rpcs_per_load: {
      note:
        "route = context.route('**/*') interception, one per HTTP request, exact. " +
        "transport = the SOCKS proxy's per-connection hostname + per-resolved-IP guards; " +
        "connection-scoped and therefore variable, since Chromium decides how many sockets to open.",
      route: countStats(routeRpcs),
      transport: countStats(transportRpcs),
      total: countStats(routeRpcs.map((n, i) => n + transportRpcs[i])),
    },
    route_guard_rpcs_per_subresource:
      routeMean === null ? null : round(routeMean / SUBRESOURCE_COUNT),
    fixture_requests_per_load: countStats(fixtureRequests),
    first_load: firstLoad,
  };
}

async function measureChallengeScan(bw, origin, frameCount) {
  log(
    `\n[C${frameCount}] challenge-scan cost — ${frameCount} benign cross-site iframes, ${CHALLENGE_WARMUP} warmup + ${CHALLENGE_ITERS} iterations`,
  );
  const url = `${origin}/frames?n=${frameCount}`;
  await timedRun(
    bw,
    `await page.goto(${JSON.stringify(url)}, { waitUntil: 'load' }); return page.title()`,
  );

  // Verify the frames really are attached and really are cross-site. Same-site
  // frames would share the parent's renderer, and the measurement would be a
  // floor rather than the number it claims to be.
  const probe = await timedRun(
    bw,
    `const frames = await page.frames();
     const urls = [];
     for (const frame of frames) urls.push(await frame.url());
     return { count: urls.length, urls };`,
  );
  const urls = (probe.result.result?.urls || []) as string[];
  const mainHost = new URL(url).hostname;
  const childHosts = urls
    .slice(1)
    .map((u) => {
      try {
        return new URL(u).hostname;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  const crossSite = childHosts.filter((h) => h !== mainHost).length;
  if (childHosts.length !== frameCount)
    throw new Error(
      `expected ${frameCount} child frames, saw ${childHosts.length} (${urls.join(", ")})`,
    );
  if (crossSite !== frameCount)
    throw new Error(
      `expected all ${frameCount} child frames to be cross-site with ${mainHost}, only ${crossSite} were`,
    );
  log(`    ${frameCount} child frames attached, all cross-site (${[...new Set(childHosts)].join(", ")})`);

  for (let i = 0; i < CHALLENGE_WARMUP; i++) await timedRun(bw, TRIVIAL);
  const samples = [];
  for (let i = 0; i < CHALLENGE_ITERS; i++) {
    const { elapsed } = await timedRun(bw, TRIVIAL);
    samples.push(elapsed);
    if ((i + 1) % 10 === 0) log(`    ${i + 1}/${CHALLENGE_ITERS}`);
  }
  return {
    frames: frameCount,
    cross_site_frames: crossSite,
    ...stats(samples),
  };
}

// ------------------------------------------------------------------ plumbing

// Counts guard RPCs at the stdio RPC boundary rather than at `policy.check`.
// Two reasons: (1) it counts one per round-trip under any future batching
// scheme (the plan keeps a `guardBatch` RPC on the table, and a `policy.check`
// counter would still report N for a batch of N and hide the whole win);
// (2) it lets the count be bucketed by `payload.resourceType`, which matters
// because two very different populations arrive here:
//   - route guards   — one per HTTP request from `context.route("**/*")`;
//                      exactly (subresources + 1) and deterministic.
//   - transport guards — the SOCKS proxy's per-connection hostname
//                      (`resourceType: "transport"`) and per-resolved-IP
//                      (`"transport-address"`) checks; nondeterministic,
//                      because Chromium decides when to open a socket.
// Totalling them produces a scalar that drifts +-12% while looking exact.
function instrumentGuard(bw) {
  const original = bw._serviceRpc.bind(bw);
  const counts = { route: 0, transport: 0 };
  bw._serviceRpc = (message, child) => {
    if (message?.method === "guard") {
      const type = message.payload?.resourceType;
      if (type === "transport" || type === "transport-address") counts.transport++;
      else counts.route++;
    }
    return original(message, child);
  };
  return {
    reset() {
      counts.route = 0;
      counts.transport = 0;
    },
    count() {
      return { ...counts };
    },
    restore() {
      delete bw._serviceRpc;
    },
  };
}

function gitInfo() {
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: HERE, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  return {
    commit: git(["rev-parse", "--short", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: !!git(["status", "--porcelain"]),
  };
}

function readResults() {
  let existing: any = {};
  if (fs.existsSync(RESULTS)) {
    try {
      existing = JSON.parse(fs.readFileSync(RESULTS, "utf8")) || {};
    } catch {
      // A corrupt or hand-edited file must not lose the run that just
      // finished; keep it aside instead of overwriting it silently.
      const backup = `${RESULTS}.bak`;
      fs.copyFileSync(RESULTS, backup);
      log(`\nresults.json was unparseable; copied to ${backup} and starting fresh.`);
      existing = {};
    }
  }
  return existing;
}

// Refuse to silently replace a recorded run. Checked BEFORE any measurement so
// a doomed invocation costs zero seconds, and again in writeResults so a
// concurrent writer cannot slip past. `--quick` also gets its own key suffix,
// so a smoke run can never land on top of a full-fidelity baseline.
function assertKeyFree(key, existing = readResults()) {
  if (!existing.runs?.[key]) return;
  if (!FORCE)
    throw new Error(
      `results.json already has a run under "${key}" (recorded ${existing.runs[key]?.metadata?.date}). ` +
        "Overwriting it would destroy a recorded baseline. Re-run with a different --label, " +
        "or pass --force to replace it deliberately.",
    );
  log(`warning: --force given; the existing run "${key}" will be replaced.`);
}

function writeResults(key, payload) {
  const existing = readResults();
  assertKeyFree(key, existing);
  const merged = {
    schema_version: "betterwright-perf-results-v2",
    benchmark: "round-trip cost: per-action latency, page-load guard RPCs, challenge-scan overhead",
    fixture: "local http.createServer only — no external network",
    defined_in: "run.ts",
    runs: { ...(existing.runs || {}), [key]: payload },
  };
  fs.writeFileSync(RESULTS, `${JSON.stringify(merged, null, 2)}\n`);
}

async function main() {
  const git = gitInfo();
  const key = `${LABEL}${QUICK ? "-quick" : ""}-${git.commit || "unknown"}`;
  assertKeyFree(key);

  const servers = [];
  const frameServers = [];
  const refs = { origins: [], frameOrigins: [] };
  let bw = null;
  let guard = null;
  let home = null;
  let shuttingDown = false;

  // Teardown lives in a named function so it can be reached from BOTH the
  // `finally` below and a SIGINT handler. `finally` alone does not cover
  // Ctrl-C: Node's default SIGINT disposition kills the process outright, the
  // pending `await` never resumes, and every aborted run leaves a
  // `betterwright-perf-*` browser profile in os.tmpdir().
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    // Every teardown step is independently guarded: a failed bw.close() must
    // not leave six http servers listening and a temp home on disk.
    try {
      guard?.restore();
    } catch {
      /* the wrap is harness-local; failing to unwrap cannot affect results */
    }
    try {
      await bw?.close();
    } catch (error) {
      log(`warning: bw.close() failed: ${error}`);
    }
    for (const server of [...servers, ...frameServers]) {
      try {
        await server.close();
      } catch {
        /* a server that already errored out is already gone */
      }
    }
    if (home) {
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* leaving a temp dir behind is not worth failing the run over */
      }
      home = null;
    }
  }

  const onSigint = () => {
    log("\ninterrupted; tearing down browser, servers and temp home...");
    void shutdown().finally(() => {
      process.off("SIGINT", onSigint);
      process.kill(process.pid, "SIGINT");
    });
  };
  process.on("SIGINT", onSigint);

  try {
    for (let i = 0; i < ORIGIN_COUNT; i++) servers.push(await startFixtureServer(i, refs));
    refs.origins = servers.map((s) => s.origin);
    for (const [i, host] of FRAME_HOSTS.entries())
      frameServers.push(await startFixtureServer(100 + i, refs, host));
    refs.frameOrigins = frameServers.map((s) => s.origin);
    log(`fixture origins: ${refs.origins.join(", ")}`);
    log(`frame origins:   ${refs.frameOrigins.join(", ")}`);

    home = fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-perf-"));
    bw = new BetterWright({
      home,
      // Stock NetworkPolicy: loopback is allowed by default, and an unmodified
      // policy is what Phase A's `cacheable` flag will key on, so the baseline
      // must be measured through the same object shape.
      policy: new NetworkPolicy(),
      headless: true,
      // The vault is irrelevant here and its host-side redaction would add
      // noise to every result envelope.
      vault: false,
    });
    guard = instrumentGuard(bw);

    const origin = refs.origins[0];
    // A, then B, then C at each frame count with a fresh 0-frame control (A')
    // measured BETWEEN the two C runs. The iframe tax is derived from the
    // adjacent pair (C - A'), so monotonic per-session drift is measured
    // instead of being charged to the iframes.
    const perAction = await measurePerAction(bw, origin, "A");
    const pageLoad = await measurePageLoad(bw, origin, guard, [...servers, ...frameServers]);

    const challenges = [];
    let perActionAfter = null;
    for (const [i, frameCount] of IFRAME_COUNTS.entries()) {
      challenges.push(await measureChallengeScan(bw, origin, frameCount));
      if (i === 0) perActionAfter = await measurePerAction(bw, origin, "A'");
    }
    if (!perActionAfter) perActionAfter = await measurePerAction(bw, origin, "A'");

    const drift =
      perAction && perActionAfter ? round(perActionAfter.p50_ms - perAction.p50_ms) : null;
    const driftPct =
      perAction?.p50_ms && drift !== null ? round((drift / perAction.p50_ms) * 100) : null;

    const iframeOverhead = {};
    for (const c of challenges) {
      iframeOverhead[`frames_${c.frames}`] = {
        p50_ms: round(c.p50_ms - perActionAfter.p50_ms),
        p95_ms: round(c.p95_ms - perActionAfter.p95_ms),
        per_frame_p50_ms: round((c.p50_ms - perActionAfter.p50_ms) / c.frames),
      };
    }

    const payload = {
      metadata: {
        label: LABEL,
        date: new Date().toISOString(),
        commit: git.commit,
        branch: git.branch,
        working_tree_dirty: git.dirty,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        cpus: os.cpus()?.length ?? null,
        quick_mode: QUICK,
        betterwright_version: JSON.parse(
          fs.readFileSync(path.resolve(HERE, "..", "..", "package.json"), "utf8"),
        ).version,
      },
      config: {
        action_iterations: ACTION_ITERS,
        action_warmup: ACTION_WARMUP,
        load_iterations: LOAD_ITERS,
        load_warmup: LOAD_WARMUP,
        challenge_iterations: CHALLENGE_ITERS,
        challenge_warmup: CHALLENGE_WARMUP,
        subresources: SUBRESOURCE_COUNT,
        origins: ORIGIN_COUNT,
        iframe_counts: IFRAME_COUNTS,
        frame_hosts: FRAME_HOSTS,
        connections_dropped_between_loads: true,
        snippet: TRIVIAL,
      },
      per_action_latency: perAction,
      per_action_latency_after: perActionAfter,
      session_drift: {
        note: "A' minus A: monotonic per-session cost growth, measured so it is not charged to the iframes",
        p50_delta_ms: drift,
        p50_delta_pct: driftPct,
      },
      page_load: pageLoad,
      challenge_scan: challenges,
      derived: {
        // The headline Phase B number: what N benign cross-site iframes add to
        // every single agent action, purely through the unconditional frame
        // walk. Derived against the ADJACENT 0-frame control, not against the
        // A measured at the other end of the session.
        iframe_overhead: iframeOverhead,
      },
    };
    writeResults(key, payload);

    log(`\n=== ${key} ===`);
    log(`per-action p50/p95:     ${perAction?.p50_ms}ms / ${perAction?.p95_ms}ms`);
    log(`per-action p50 (A'):    ${perActionAfter?.p50_ms}ms  (session drift ${drift >= 0 ? "+" : ""}${drift}ms, ${driftPct}%)`);
    log(`page-load wall p50:     ${pageLoad.wall_time?.p50_ms}ms`);
    log(`route guard RPCs/load:  ${pageLoad.guard_rpcs_per_load.route?.p50} (p50), min ${pageLoad.guard_rpcs_per_load.route?.min} max ${pageLoad.guard_rpcs_per_load.route?.max}`);
    log(`transport guard/load:   ${pageLoad.guard_rpcs_per_load.transport?.p50} (p50), min ${pageLoad.guard_rpcs_per_load.transport?.min} max ${pageLoad.guard_rpcs_per_load.transport?.max}`);
    log(`fixture requests/load:  ${pageLoad.fixture_requests_per_load?.p50} (asserted ${EXPECTED_FIXTURE_REQUESTS})`);
    for (const c of challenges)
      log(`${String(c.frames).padStart(2)}-iframe page p50/p95: ${c.p50_ms}ms / ${c.p95_ms}ms  (tax +${iframeOverhead[`frames_${c.frames}`].p50_ms}ms, ${iframeOverhead[`frames_${c.frames}`].per_frame_p50_ms}ms/frame)`);
    log(`\nresults.json updated: ${RESULTS}`);
  } finally {
    process.off("SIGINT", onSigint);
    await shutdown();
  }
}

main().catch((error) => {
  log(`\nbenchmark failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
