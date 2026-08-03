# Round-trip cost: per-action latency, guard RPCs, challenge-scan overhead

This harness measures the three round-trip costs that the current performance
plan targets. Unlike the other benchmarks in this directory it touches **no
external network at all** — every byte comes from `http.createServer` fixtures
on loopback — so it is fully reproducible on any machine with the browser
runtime installed, and the numbers describe BetterWright's own overhead rather
than someone else's CDN.

It exists to answer one question per phase of the plan, before and after:

| Benchmark | Measures | Plan target |
|---|---|---|
| **A / A'.** Per-action latency | The floor cost of one agent action on a quiet page | Baseline for everything; Phase B's sandbox hoists move it |
| **B.** Page load + guard RPC count | Stdio round-trips paid per page load | **Phase A** — worker-side guard decision cache |
| **C.** Challenge-scan cost | What benign cross-site iframes add to *every* action | **Phase B** — staged challenge scan |

## How to run

```
npm run build:harness
node benchmarks/perf/run.js
```

Roughly 25 seconds. Flags:

- `--quick` — 20/3/10 iterations instead of 100/10/30, and only the 10-frame
  challenge scan. For editing the harness, not for numbers you intend to
  record. Quick runs write under their own `<label>-quick-<sha>` key, so they
  **cannot** overwrite a recorded full-fidelity baseline.
- `--label <name>` — the results key prefix (default `baseline`). Results land
  in `results.json` under `runs["<label>[-quick]-<short sha>"]`, **merged** with
  what is already there, so a before and an after live side by side in one
  file. Use `--label baseline` before a change and `--label phase-a` after it.
- `--iframes <n>[,<n>...]` — frame counts for benchmark C (default `10,24`).
- `--force` — replace an existing run under the same key. Without it the
  harness **refuses** to overwrite a recorded run, and it checks this *before*
  measuring anything, so a doomed invocation costs zero seconds.

The harness needs the managed browser runtime (`betterwright setup`). It creates
its own temp home, uses a stock `NetworkPolicy`, and runs with `vault: false` so
host-side secret redaction does not add noise to every result envelope.

Teardown (browser, six fixture listeners, temp home) lives in a named
`shutdown()` reached from **both** the `finally` block and a `SIGINT` handler.
`finally` alone does not cover Ctrl-C — Node's default SIGINT disposition kills
the process outright and the pending `await` never resumes — which is why the
signal handler is explicit. Verified: `SIGINT` mid-run exits 130 and leaves no
`betterwright-perf-*` profile in `os.tmpdir()`.

## What each benchmark actually does

### A / A'. Per-action latency

Loads a fixture page with no subresources and no frames, then executes
`return page.title()` 100 times (5 warmup iterations discarded), timing each
`bw.run()` call end to end from the host process.

This is the floor every agent action pays regardless of what the page contains:
client to worker stdio RPC, sandbox realm creation, snippet compile, execute,
challenge scan, envelope build, response. A trivial snippet on a quiet page
isolates that scaffolding from any real work.

It is measured **twice**: once at the start of the session (A) and once between
the two challenge-scan runs (A'). Benchmark C otherwise sits at the far end of a
long session — after ~110 executes, 11 page loads, and a grown `session.events`
/ `session.artifacts` — and any per-session drift would be charged entirely to
the iframes. The reported iframe tax is derived from the **adjacent** pair,
`C − A'`, and `session_drift` records `A' − A` so the drift is a number rather
than a silent bias.

### B. Page-load wall time + guard RPC count

One fixture page pulls **50 subresources spread round-robin across 4 distinct
`127.0.0.1:<port>` origins**. Distinct ports matter: they are distinct guard
cache keys, which is precisely the case Phase A's worker-side LRU has to handle.

Three things make each measured load honest:

1. **Everything is `no-store` and the document URL is cache-busted per load.**
2. **Every fixture server counts its own requests** (`fixture_requests_per_load`)
   and the run **fails** if any measured load is not exactly 51 (1 document +
   50 subresources). Without this the only evidence that subresources were
   re-fetched would be the guard count — the very number under test. If a
   Chromium change or a header edit ever let the memory cache serve
   `/asset/N.gif`, the guard count would collapse and read as a Phase A win.
3. **All keep-alive sockets are dropped between loads**
   (`server.closeAllConnections()`), so every measured load is connection-cold
   and the SOCKS proxy's per-connection guards appear as a full n=10 series
   instead of a single confounded warmup sample.

The `about:blank` teardown navigation is followed by a **250 ms settle before**
`guard.reset()`, not only after the timed load. Tearing down the previous
document emits trailing guard RPCs; resetting the counter the instant `goto`
returns attributed those stragglers to the next load, which is what made the
count drift run to run.

Guard RPCs are counted **without modifying `src/`**, at the **stdio RPC
boundary** rather than at `policy.check`:

```js
const original = bw._serviceRpc.bind(bw);
bw._serviceRpc = (message, child) => {
  if (message?.method === "guard") { /* bucket by message.payload.resourceType */ }
  return original(message, child);
};
```

Wrapping `_serviceRpc` rather than `policy.check` matters for two reasons. It
counts **one per round-trip under any batching scheme** — the plan keeps a
`guardBatch` RPC on the table, and a `policy.check` counter would still report N
for a batch of N and hide the entire win. And it exposes `payload.resourceType`,
which is what lets the count be **bucketed**, which it must be:

- **`guard_rpcs_per_load.route`** — the `context.route("**/*")` interception
  (`src/worker.ts:1393`): one RPC per HTTP request. Exactly
  `subresources + 1`, and genuinely invariant.
- **`guard_rpcs_per_load.transport`** — the SOCKS guard proxy's per-connection
  guards: one hostname check (`resourceType: "transport"`,
  `src/guard-proxy.ts:517`) plus one per resolved IP
  (`"transport-address"`, `:546`). **Connection-scoped and inherently
  variable**, because Chromium decides how many sockets to open and when.

Totalling the two produces a scalar that drifts ±12% while looking exact. It is
still reported as `.total`, but the two buckets are the numbers to read.

There is also a **liveness assertion**: if the warmup load records zero route
guards, the run throws. Otherwise a refactor that moves the check off
`_serviceRpc` would report 0 guard RPCs, and a broken hook would look exactly
like a total Phase A win.

### C. Challenge-scan cost

Identical snippet to benchmark A (`return page.title()`, 30 iterations, 3
warmup) against a page embedding **N benign iframes**, each with a real body of
prose so per-frame text extraction has something to extract. Nothing on the page
is a challenge. Measured at **N = 10 and N = 24** (24 is the hard cap in
`collectFrameMetadata`, `src/worker.ts:3973`), so frame scaling is measured data
rather than extrapolation.

The frames are served from **distinct loopback hostnames** (`127.0.0.2`,
`127.0.0.3`) while the parent is on `127.0.0.1`. This is load-bearing:
Chromium's site isolation keys on scheme + eTLD+1 and **ignores the port**, so
same-host different-port frames would share the parent's renderer process and
their frame walks would be cheap same-process CDP. Distinct IPs are distinct
sites, so these are real OOPIFs with their own targets — which is what an
ad-heavy page actually looks like. The harness **asserts** it: after navigation
it reads `page.frames()` and fails unless all N children are attached and all N
are cross-site with the parent.

`detectSessionChallenges` runs unconditionally on every execute. **C minus A' is
therefore the per-action tax that benign iframes impose today** — reported as
`derived.iframe_overhead.frames_<n>`.

## Baseline results

`baseline-52a577d` — 2026-08-03, BetterWright 1.6.2, Node v26.5.0, linux-x64,
8 CPUs, commit `52a577d` (`perf/bench-harness`, before any Phase A/B change).

| Metric | p50 | p95 | mean | stdev |
|---|---|---|---|---|
| **A.** Per-action latency (n=100) | **7.60 ms** | 11.31 ms | 7.93 ms | 1.85 ms |
| **A'.** Per-action latency, late-session (n=100) | **6.45 ms** | 8.56 ms | 6.37 ms | 1.17 ms |
| **B.** Page-load wall time (n=10) | **715.8 ms** | 756.6 ms | 720.2 ms | 15.7 ms |
| **B.** In-page navigation time (n=10) | 695 ms | 728 ms | 697.5 ms | 13.6 ms |
| **C.** Per-action, 10 cross-site iframes (n=30) | **36.68 ms** | 46.45 ms | 35.95 ms | 5.03 ms |
| **C.** Per-action, 24 cross-site iframes (n=30) | **60.57 ms** | 71.16 ms | 61.10 ms | 4.76 ms |

| Guard RPCs per load (n=10) | p50 | min | max | mean |
|---|---|---|---|---|
| **`route`** — one per HTTP request | **51** | 51 | 51 | 51 |
| **`transport`** — per-connection hostname + IP | **44** | 36 | 48 | 42.8 |
| `total` | 95 | 87 | 99 | 93.8 |

| Assertion | Value |
|---|---|
| Fixture requests per load (n=10) | **51** — min 51, max 51 (enforced) |
| Route guard RPCs per subresource | 1.02 |

| Derived (against the adjacent A' control) | Value |
|---|---|
| **Iframe tax per action, 10 frames (p50)** | **+30.23 ms** (3.02 ms/frame) |
| Iframe tax per action, 10 frames (p95) | +37.89 ms |
| **Iframe tax per action, 24 frames (p50)** | **+54.12 ms** (2.26 ms/frame) |
| Iframe tax per action, 24 frames (p95) | +62.60 ms |
| Session drift (A' − A, p50) | −1.15 ms (−15.1%) |

### Reading the baseline

**Route guards: 51 per load for 50 subresources, and this one *is* exact.**
50 subresources + 1 document = 51 stdio round-trips, min = max = 51 across all
10 loads in both recorded runs, with the fixture independently confirming 51
requests were served. Every one of those is a synchronous pipe round-trip to the
client process for what `src/client.ts:686` resolves as pure sync CPU. This is
the cleanest Phase A signal in the file: **treat any movement in the `route`
series as real.**

**Transport guards: ~43 per connection-cold load, and this one is *not*
exact — by nature.** Every measured load drops all keep-alive sockets first, so
each pays the SOCKS proxy's per-connection cost afresh: one hostname guard plus
one per resolved IP, issued serially (`src/guard-proxy.ts:546`). The observed
range is 36–48 across 10 loads in both recorded runs, because Chromium decides
how many sockets to open to each of the four origins and when. **Do not read a
±6 move here as a regression** — compare p50 and mean across ≥10 loads.
Phase A targets both buckets, and a real ad-heavy page with many origins and
short-lived connections looks much more like this row than like a keep-alive
steady state, which is why every measured load is deliberately connection-cold.

An earlier version of this harness reported the two buckets summed as a single
"51, zero variance" invariant. That was wrong: the sum drifts ±12% run to run,
and the doc instructed the reviewer to read that drift as signal.

**Benign iframes cost 6–9x the entire base action.** 36.7 ms at 10 frames and
60.6 ms at 24 versus a 6.45 ms floor: iframes that contain nothing but prose make
every single agent action **six to nine times slower**, purely through the
unconditional frame walk, and it is paid on *every* execute whether or not a
challenge exists. This is the Phase B target.

**The frame cost is sublinear in frame count, and the two measured points say
how sublinear.** 10 frames cost +30.2 ms (3.02 ms/frame); 24 frames cost
+54.1 ms (2.26 ms/frame). A 2.4x frame count buys a 1.8x tax — the ~25%
per-frame discount is `collectFrameMetadata`'s `Promise.all` overlapping the ~5
CDP round-trips *across* frames, while they stay sequential *within* a frame
(`src/worker.ts:3973`). So do not divide the tax by frames and call it a
per-frame round-trip cost, and do not extrapolate 10 frames to 24 — the harness
measures both points, and `--iframes` takes any list. At the 24-frame cap the
frame walk is still roughly **8x the entire rest of the action**.

**Per-action latency itself is already tight** at 6.5–7.6 ms p50 on a quiet
page. Phase B's sandbox hoists (realm script, `compileCode` heuristic) are
chipping at a small number; expect single-digit-percent movement here, and do
not read a 1 ms shift as a win.

## Variance

The full battery was run twice back to back on an otherwise idle machine
(`baseline-52a577d` and `repeat-52a577d`, both in `results.json`):

| Metric | baseline | repeat | delta |
|---|---|---|---|
| Per-action p50 (A) | 7.60 ms | 7.45 ms | −2.0% |
| Per-action p50 (A') | 6.45 ms | 6.34 ms | −1.7% |
| Page-load wall p50 | 715.8 ms | 715.2 ms | −0.1% |
| Route guard RPCs / load | 51 (51–51) | 51 (51–51) | 0 |
| Transport guard RPCs / load | 44 p50, 42.8 mean (36–48) | 42 p50, 42.8 mean (36–48) | 0% on the mean |
| Fixture requests / load | 51 | 51 | 0 |
| 10-iframe p50 | 36.68 ms | 33.92 ms | −7.5% |
| 24-iframe p50 | 60.57 ms | 60.70 ms | +0.2% |
| Iframe tax p50, 10 frames | 30.23 ms | 27.58 ms | −8.8% |
| Iframe tax p50, 24 frames | 54.12 ms | 54.36 ms | +0.4% |

Caveats when comparing runs:

- **The `route` guard count is exact**, not statistical: min = max = 51 in both
  runs, cross-checked against the fixture's own request counter. Treat *any*
  change as real.
- **The `transport` guard count is statistical.** It ranged 36–48 per load in
  both runs; the p50 moved 44 to 42 while the mean was identical at 42.8.
  Compare p50/mean over the full n=10 series; a single-load reading means
  nothing.
- **p50s are reliable to a few percent, except the 10-frame scan; p95s are not
  reliable at all.** The 10-iframe p95 moved 46.5 to 40.4 ms between two
  identical runs. Compare p50s; treat a p95 delta under ~30% as noise.
- **Per-session drift is real and is now measured, not assumed.** `A' − A` was
  −15.1% and −14.9% in the two runs: the late-session A' is consistently
  *faster*, not slower — JIT warmup dominates any session-state growth over a
  run this size. Because the tax is derived from `C − A'`, this makes the
  reported tax slightly *larger* than the old `C − A` form did, and correctly
  so. If a future run shows `session_drift` swinging positive by more than a
  few percent, the iframe tax for that run is suspect.
- **The iframe tax carries ~9% run-to-run spread at 10 frames and <1% at 24.**
  It is a difference of two measurements, so it inherits both their variances,
  and the 24-frame figure is the steadier of the two. A Phase B win needs to be
  much larger than 9% to count — which, given it should remove most of the 30
  ms, it will be.
- **Page-load wall time is dominated by the fixture**, not by BetterWright: 695
  of the 716 ms is in-page navigation including `networkidle` settling. Do not
  expect Phase A to move this number much even if it removes 50 RPCs; the RPC
  *counts* are the metrics that matter there, and wall time is context.
- Only run this on an idle machine. A browser build, a test suite, or a video
  call in the background will swamp the per-action numbers.

## Phase A results

`phase-a-cee1d46` and `phase-a-repeat-cee1d46` — 2026-08-03, same machine, Node
v26.5.0, linux-x64, 8 CPUs, branch `perf/guard-cache`: worker-side guard
decision cache (`src/guard-url.ts`) plus parallel resolved-IP validation
(`src/guard-proxy.ts`). Two full-fidelity runs back to back, for the same reason
the baseline has a `repeat`.

| Metric (p50) | baseline | phase-a | repeat | delta |
|---|---|---|---|---|
| **A.** Per-action latency (n=100) | 7.60 ms | 7.36 ms | 7.35 ms | −3.2% |
| **A'.** Per-action latency, late-session (n=100) | 6.45 ms | 6.19 ms | 6.50 ms | ±noise |
| **B.** Page-load wall time (n=10) | 715.8 ms | 713.8 ms | 716.2 ms | −0.3% |
| **B.** In-page navigation time (n=10) | 695 ms | 691 ms | 689 ms | −0.7% |
| **C.** Per-action, 10 cross-site iframes (n=30) | 36.68 ms | 35.41 ms | 33.31 ms | ±noise (−3.5% / −9.2%) |
| **C.** Per-action, 24 cross-site iframes (n=30) | 60.57 ms | 66.08 ms | 60.28 ms | see below |

| Guard RPCs per load (n=10) | baseline p50 | phase-a p50 | baseline mean | phase-a mean | delta (mean) |
|---|---|---|---|---|---|
| **`route`** — one per HTTP request | **51** (51–51) | **1** (1–6) | 51 | 2.0 | **−96.1%** |
| **`transport`** — per-connection hostname + IP | **44** (36–48) | **0** (0–3) | 42.8 | 0.8 | **−98.1%** |
| `total` | 95 | 1 | 93.8 | 2.8 | −97.0% |

| Assertion | baseline | phase-a |
|---|---|---|
| Fixture requests per load (n=10) | **51** — min 51, max 51 | **51** — min 51, max 51 (enforced) |
| Route guard RPCs per subresource | 1.02 | **0.04** |
| Warmup (cold-cache) load: route / transport | 51 / 46 | 6 / 5 — repeat 5 / 3 |

| Derived (against the adjacent A' control) | baseline | phase-a | repeat |
|---|---|---|---|
| Iframe tax per action, 10 frames (p50) | +30.23 ms | +29.22 ms | +26.81 ms |
| Iframe tax per action, 24 frames (p50) | +54.12 ms | +59.89 ms | +53.78 ms |
| Session drift (A' − A, p50) | −15.1% | −15.9% | −11.6% |

### Reading Phase A

**The route bucket — the one the baseline called "exact, treat any movement as
real" — went from a flat 51 to a p50 of 1, and the fixture still served exactly
51 requests on every measured load.** That cross-check is the whole reason to
believe the number: the subresources were genuinely re-fetched, the guard simply
stopped costing a stdio round-trip. The steady-state 1 is the cache-busted
document, which is a `fullUrl` check and therefore *never* cacheable by
construction — so 1/load is the floor this design can reach, and it reaches it.
The mean of 2.0 rather than 1.0 is the 5 s TTL amortising: a load cycle is
~1.25 s, so roughly every fourth load re-pays first contact (loads 4 and 8 in the
first run). That is the TTL doing its job against mutable `allowHosts`, not a
miss. Cold-cache cost is 5–6 route RPCs, and tracing the payload URLs shows why
it is 5–6 and not a fixed 5: one document plus one miss per distinct origin
(4), plus occasionally one *duplicate* miss when two same-origin subresources
are in flight before the first RPC resolves. There is no single-flight
coalescing, so concurrent first contacts to one key can each miss. It is bounded
by connection concurrency, costs at most a handful of RPCs once per key per TTL,
and is worth noting rather than fixing now.

**Two caveats keep the transport row honest.** Its collapse to a p50 of 0 is
real but this fixture flatters its *shape*: every origin is a literal IP, so
`transportUrl(host, port)` and `transportUrl(address, port)` produce the same
cache key, which makes the per-IP `transport-address` check a guaranteed hit —
zero of them appear in a traced load. Against a real hostname with N A-records
the keys differ, so first contact costs 1 + N and every repeat contact costs 0;
still a collapse, just not to zero on the first connection. And **the parallel
IP validation is not measured by this harness at all** — loopback resolves to a
single address, so there is nothing to overlap, and the cache turns the check
into a hit regardless. That half of Phase A needs a multi-A-record target to
show up anywhere, and no number in this table is evidence for or against it.

**Wall time did not move, exactly as the baseline predicted, and per-action
latency is flat-to-marginally-better.** 715.8 → 713.8/716.2 ms: 50 removed
round-trips are invisible against ~695 ms of fixture navigation and `networkidle`
settling, which is why the counts and not the clock are the Phase A metrics. The
~3% dip in A is within the ±2% the baseline records for repeated runs; do not
bank it.

**Neither challenge-scan row carries a Phase A signal — both are noise.** Phase A
touches nothing in `collectChallengeMetadata` or `collectFrameMetadata`, so any
movement here is run-to-run spread, and the two rows are quoted as ranges rather
than deltas for that reason. C24 is the one that needed a second run: the first
Phase A run put the 24-frame page at 66.08 ms, +9.1% over baseline — outside the
±0.4% spread the Variance section claims for that metric. The repeat came back at
60.28 ms against a 60.57 ms baseline (−0.5%). Across the four recorded full runs
the 24-frame p50 has spanned 60.28–66.08 ms and the 10-frame p50 has spanned
33.31–36.68 ms — **~10% for both, so the earlier claim that the 24-frame figure
is the steadier of the two challenge-scan points (<1%) is wrong** until more runs
say otherwise. The C10 arms straddle that whole band (−3.5% for the first run,
−9.2% for the repeat, and +1.1% if the means are compared instead), which is why
no single delta is quoted. Phase B is graded on these metrics, so treat
60.3–60.6 ms and 33.3–36.7 ms as its baselines and require a win far larger than
10%.

## Files

- [`run.ts`](run.ts) — the harness. Compiled to `run.js` by `npm run
  build:harness`; the emitted `.js` is gitignored (`benchmarks/*/*.js`), same as
  every other harness here.
- [`results.json`](results.json) — all recorded runs, keyed by
  `<label>[-quick]-<short sha>`, each with its own metadata and config block.
  Schema `betterwright-perf-results-v2`.
