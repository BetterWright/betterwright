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

## Phase B results

`phase-b-51eebd0` and `phase-b-repeat-51eebd0` — 2026-08-03, same machine, Node
v26.5.0, linux-x64, 8 CPUs, branch `perf/challenge-staging`: the staged
challenge scan (`challengeScanNeeded` / `frameUrlLooksLikeChallenge` in
`src/challenges.ts`, the two-stage `collectChallengeMetadata` in
`src/worker.ts`) plus the two sandbox hoists (the realm factory `vm.Script`,
`src/compile-code.ts`'s statement-first heuristic). Two full-fidelity runs back
to back, same as every other recorded phase.

**These two keys were re-recorded after code review** (`--force`), against the
reviewed revision rather than the first cut. Four review fixes move numbers in
this table and the reasoning below is written against the reviewed code:

1. Stage 1 is **four concurrent reads**, not one evaluate — `page.title()`,
   `locator("body").innerText()`, the token evaluate, and the frame-descriptor
   walk — so one slow field can no longer blank the other three. Title and text
   go back through Playwright's utility world, which page script cannot patch.
2. Stage 2 reads each frame's text and checkbox state through **locators**, not
   an in-page evaluate: two parallel round trips per frame instead of one, in
   exchange for utility-world isolation and shadow-DOM piercing.
3. The gate opens for **unread cross-origin frames** — any frame whose URL is
   challenge-shaped, plus up to `CHALLENGE_UNREAD_FRAME_BUDGET` (3) of them
   unconditionally. This is a detection fix, and it is why the C fixture's 10
   and 24 frames still skip while a 1–3 frame page no longer does.
4. Unmatched frames resolve their geometry through `frameElement()` instead of
   borrowing a sibling descriptor.

**Both keys carry the Phase A commit `51eebd0` because Phase B was still
uncommitted when the runs were taken** (`working_tree_dirty: true`, as with
every other run in the file). The key names the tree the run started from, not
the code under test; the branch field is what distinguishes these two runs.

| Metric (p50) | baseline | phase-a | phase-b | phase-b-repeat | delta |
|---|---|---|---|---|---|
| **A.** Per-action latency (n=100) | 7.60 ms | 7.36 ms | 7.56 ms | 7.50 ms | flat |
| **A'.** Per-action latency, late-session (n=100) | 6.45 ms | 6.19 ms | 7.52 ms | 6.96 ms | **+0.5 to +1.1 ms** |
| **B.** Page-load wall time (n=10) | 715.8 ms | 713.8 ms | 721.0 ms | 711.7 ms | ±noise, fixture-dominated |
| **B.** In-page navigation time (n=10) | 695 ms | 691 ms | 697 ms | 686 ms | ±noise |
| **C.** Per-action, 10 cross-site iframes (n=30) | 36.68 ms | 35.41 ms | **8.99 ms** | **8.64 ms** | **−74% to −76%** |
| **C.** Per-action, 24 cross-site iframes (n=30) | 60.57 ms | 66.08 ms | **11.64 ms** | **9.38 ms** | **−81% to −86%** |

The C rows are quoted against the **full recorded band** rather than one arm,
because the Phase A section established that band as ~10% wide: C10 has spanned
33.31–36.68 ms and C24 60.28–66.08 ms across the four pre-Phase-B runs.

| Derived (against the adjacent A' control) | recorded band, 4 runs | phase-b | phase-b-repeat | delta |
|---|---|---|---|---|
| **Iframe tax per action, 10 frames (p50)** | +26.81 to +30.23 ms | **+1.47 ms** | **+1.68 ms** | **−94% to −95%** |
| **Iframe tax per action, 24 frames (p50)** | +53.78 to +59.89 ms | **+4.12 ms** | **+2.42 ms** | **−92% to −96%** |
| Per-frame cost, 10 frames | 2.68–3.02 ms | 0.15 ms | 0.17 ms | |
| Per-frame cost, 24 frames | 2.24–2.50 ms | 0.17 ms | 0.10 ms | |
| Session drift (A' − A, p50) | −11.6% to −15.9% | −0.5% | −7.2% | see below |

| Control (Phase A metrics, untouched by Phase B) | phase-a | phase-b | phase-b-repeat |
|---|---|---|---|
| **`route`** guard RPCs / load | 1 p50, mean 2.0 (1–6) | 1 p50, mean 1.8 (1–5) | 1 p50, mean 1.9 (1–6) |
| **`transport`** guard RPCs / load | 0 p50, mean 0.8 (0–3) | 0 p50, mean 0.9 (0–4) | 0 p50, mean 1.0 (0–4) |
| Fixture requests / load | **51** (enforced) | **51** (enforced) | **51** (enforced) |

### Reading Phase B

**The iframe tax collapsed by an order of magnitude, and it cleared the recorded
variance by roughly ten times that variance.** The Phase A section set the bar:
"treat 60.3–60.6 ms and 33.3–36.7 ms as its baselines and require a win far
larger than 10%." C24 went to 9.38–11.64 ms and C10 to 8.64–8.99 ms. The tax
derived against the adjacent A' control fell from +54 ms to +2.4–4.1 ms at 24
frames and from +30 ms to +1.5–1.7 ms at 10. The C10 arms agree to within
0.35 ms; C24 spans 2.3 ms between arms, which is the widest disagreement in this
table and is why that row is quoted as a band.

**Frame-count scaling is now flat inside the noise, which is the shape the
staging predicts.** The baseline's headline structural finding was a sublinear
but steep 2.26–3.02 ms *per frame*; Phase B reports 0.10–0.17 ms per frame, and
the 10-frame and 24-frame tax bands (+1.47/+1.68 and +2.42/+4.12) nearly
overlap. A 2.4x frame count now buys ~1–2 ms, because no per-frame round trip is
being made at all. **Do not read the residual as a per-frame cost** — it is
dominated by the fixed part of stage 1 plus the in-page descriptor walk.

**The residual tax is stage 1, and it is charged whether or not the gate
fires.** Stage 1's descriptor evaluate still enumerates `iframe, frame` elements
and computes `getBoundingClientRect` + `getComputedStyle` for each (up to
`CHALLENGE_FRAME_LIMIT`), attempts `contentDocument` on each to collect the
same-origin text the gate judges, and the worker still calls `page.frames()` and
maps their URLs. That is one round trip plus in-page work, which is why it costs
~0.15 ms/frame instead of the ~2.3–3.0 ms of the old per-frame CDP walk. It is
also the floor this design can reach without giving the gate less to look at
than the detector needs.

**Per-action latency did not improve, and A' cost about a millisecond — that is
the review's price and it is worth paying.** A's p50 is 7.56/7.50 ms against a
7.35–7.60 ms pre-Phase-B band: flat. A' is 7.52/6.96 ms against 6.19–6.50 ms:
up 0.5–1.1 ms, and the session-drift row moved with it (−0.5%/−7.2% against a
prior −11.6% to −15.9%), which is the same fact seen from the other side — A'
rose relative to A. The cause is structural, not noise: stage 1 issues four
concurrent round trips per action where the pre-review cut issued one, so a
per-action floor that was 6.2–6.5 ms is now ~7 ms. What that buys is that a page
slow enough to lose one read no longer loses the other three — in particular an
empty `tokens` would re-report an already-solved challenge and burn the solver's
three-attempt budget — and that title and body text are read in Playwright's
utility world, where page script cannot patch `innerText` to hide its own
interstitial. Against a 30–54 ms frame-walk win, a ~1 ms floor is the right
trade; against the pre-review cut's headline "−2% on A", it means **the sandbox
hoists' contribution is no longer visible in this metric.** Do not quote an A
win from this table.

**Nothing in the Phase A control rows moved, which is the negative result this
table needs.** Phase B touches no guard path, and `route`/`transport` stayed at
a p50 of 1 and 0, means of 1.8–1.9 and 0.9–1.0, with the fixture still serving
its enforced 51 requests per load. (The `route` mean of 2.9 seen in the
pre-review Phase B run — one load costing 15 RPCs — did not recur; both arms
here match Phase A's 1.9–2.0.)

**Page-load wall time did not move and was not expected to.** 721.0 and 711.7 ms
against 713.8–716.2 ms is inside the spread this file records for a metric that
is ~690 ms of fixture navigation and `networkidle` settling.

### Gate verification: the gate did not fire

The tax collapsing is consistent with the gate skipping stage 2, but it is not
*proof* of it — a stage 2 that ran and did nothing would look similar enough to
be worth ruling out, and a detection regression would look like a win. So the
gate was checked directly rather than inferred from the clock.

**Trace (pre-review revision).** `dist/src/worker.js` was temporarily patched at
two points — the `options.gate` call site in `collectChallengeMetadata` and the
entry to `collectFrameMetadata` itself — to append one NDJSON record per gate
decision and per stage-2 invocation under a `BW_GATE_TRACE` env var.
`collectFrameMetadata` was instrumented as well as the gate because the gate's
own return value only proves what happened at *that* call site; the entry
counter catches stage 2 arriving by any other path (the captcha-solving paths
call `collectChallengeMetadata` ungated by design). The harness was then run
under `--quick --iframes 10,24`.

| Instrumented quick run | Value |
|---|---|
| Gate decisions recorded | **90** |
| … returning `true` (scan stage 2) | **0** |
| … returning `false` (skip stage 2) | **90** |
| … reached with no gate function (ungated path) | **0** |
| **`collectFrameMetadata` invocations** | **0** |
| Decisions on the 0-frame pages (A, A', B) | 60 — all skip |
| Decisions on the 10-frame page | 15 — all skip |
| Decisions on the 24-frame page | 15 — all skip |
| Same-origin frame texts read by stage 1 | 0, on every decision |
| Main-frame `<iframe>` descriptors seen by stage 1 | 0 / 10 / 24 |

Two rows carry the argument. **Stage 2 ran zero times** across the whole
battery, so the C rows above are measuring a page whose per-frame walk genuinely
did not happen. And **stage 1 saw 10 and 24 iframe descriptors on the respective
pages** — the skip was a decision taken with the frames in hand, not a blindness
to frames that were never enumerated. The `sameOrigin: 0` row confirms the
design assumption the fixture was built to exercise: the frames are cross-site
OOPIFs, opaque to stage 1's evaluate, so all the gate ever learned about them
was their URL.

**Replay (reviewed revision).** That trace predates review fix 3, which changed
what the gate is given: frames now carry a `readable` flag, and an unread frame
opens the gate either on URL shape or on the unread-frame budget. The trace was
therefore re-checked rather than assumed, by replaying the fixture's exact frame
sets through the shipped `challengeScanNeeded` in `dist/`:

| Fixture page | Unread cross-site frames | `challengeScanNeeded` |
|---|---|---|
| A / A' / B (`/static`, `/page`) | 0 | `false` |
| C10 (`/frames?n=10`) | 10 | `false` |
| C24 (`/frames?n=24`) | 24 | `false` |

All three still skip: the fixture frame URLs (`http://127.0.0.{2,3}:<port>/frame/<n>`)
match no provider and carry no challenge-shaped token, and 10 and 24 are both
over the 3-frame unread budget. **A page with 1–3 such frames would now scan** —
that is the detection fix working, and it means this fixture is measuring the
frame-heavy case specifically. A 2-frame variant of the C fixture would show the
gate opening and stage 2's new cost; the harness does not have one.

**Positive control: the gate does fire.** An all-skip trace is also what a
permanently-false gate would produce, so the bot-challenge integration tests in
`tests/node/browser.test.js` are the counter-evidence. Against the reviewed
build all 13 challenge/captcha tests pass, including
`iframe-only bot challenges are detected` and the new
`bot challenges in a cross-origin frame are detected` — an out-of-process
`127.0.0.2` frame whose URL names no provider, which only the unread-frame
budget can reach, and which the pre-review gate missed.

The instrumentation was removed by rebuilding `dist/` from source; `grep` for
`BW_GATE_TRACE` in `dist/src/worker.js` returns 0 matches. The instrumented
`--quick` run was deliberately **not** kept in `results.json`: its numbers
include a synchronous `appendFileSync` per gate decision, and a quick run is not
full-fidelity anyway.

### Caveats specific to Phase B

- **This harness measures the benign frame-heavy case only.** A page that
  carries a challenge — or merely 1–3 opaque cross-origin frames — now pays
  stage 1 plus stage 2 on every execute. Stage 2 was also rewritten: two
  parallel locator reads per frame (`innerText`, checkbox `count`) plus one
  shared descriptor walk on the parent, against five sequential CDP round trips
  before (`frameElement`, rect/style, `dispose`, `innerText`, checkbox count).
  Challenged pages should be faster too, but **no number in this table is
  evidence of that**. It would need a fixture with a provider frame, which the
  harness does not have.
- **The gate is a detection surface, and the benchmark cannot see detection
  regressions.** A gate that wrongly skipped would show up here as a *larger*
  win — which is exactly what happened before review: the pre-review C rows were
  0.5–2.5 ms lower than these, and part of that gap was a gate that skipped
  cross-origin challenge frames. What constrains it now is
  `tests/node/challenge-scan-gate.test.ts` — which feeds the gate
  production-fidelity inputs (same-origin frames with text, cross-origin frames
  with a bare URL) and compares against the detector run over the **full** frame
  metadata the old unconditional scan produced, asserting that the only
  divergence is the documented over-budget unread-frame case — plus the 13
  integration tests used as the positive control above. Read the win only
  together with those.
- **A constant background load was present for every run in this file.** A
  `sunshine` process held ~150% CPU (of 8 cores) from 16:10 local on 2026-08-02
  onward, which covers the baseline (02:45Z), Phase A (03:13Z) and Phase B
  (04:51Z / 04:52Z) runs alike. Absolute millisecond figures here are therefore
  *not* the idle-machine floor the "How to run" section asks for, but the load
  was the same for every arm, so the cross-run comparisons — which is all the
  deltas above claim — hold. Anyone re-recording an absolute baseline should do
  it on a genuinely idle machine.
- **The C rows are now small enough that A' precision starts to matter.** The
  residual tax (1.5–4.1 ms) is of the same order as A's own stdev (1.6–2.4 ms).
  It is still a p50 of 30 samples against a p50 of 100, so it is a real
  central-tendency difference, but quote it as the band across both runs rather
  than as any single figure — and note that A' itself moved this round, so the
  derived tax is a difference of two numbers that both changed.

## Files

- [`run.ts`](run.ts) — the harness. Compiled to `run.js` by `npm run
  build:harness`; the emitted `.js` is gitignored (`benchmarks/*/*.js`), same as
  every other harness here.
- [`results.json`](results.json) — all recorded runs, keyed by
  `<label>[-quick]-<short sha>`, each with its own metadata and config block.
  Schema `betterwright-perf-results-v2`.
