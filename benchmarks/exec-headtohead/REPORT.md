# `betterwright exec` vs a reference agent — agent-scaffold head-to-head

**Date:** 2026-07-19 (15-scenario battery, three full rounds)
**Model (both sides):** `gpt-5.6-sol` — **reasoning effort `low`**
**BetterWright:** `betterwright exec "<task>" --model gpt-5.6-sol` (codex OAuth →
ChatGPT backend Responses API, direct). The runs predate the current model
selector and were invoked as `--model codex`, a shortcut today's CLI rejects in
favor of real model ids — the command above is the equivalent current
invocation.
**Reference:** the reference agent's own CLI, `exec -m openai-codex/gpt-5.6-sol
--effort low "<task>"`, with an explicit **no-subagents instruction** appended to
every task (BetterWright has no subagents, so the reference's child-session
machinery is prompt-disabled for fairness; it has no CLI flag for it).

The comparison agent is intentionally unnamed. Reproducing its column requires
setting `REFERENCE_CLI` to a CLI installed on your own machine (the runner's
`reference-agent` default is a placeholder that exists nowhere); only the
BetterWright column is independently reproducible as published.

Both harnesses drive the **same model at the same effort**, so this isolates the
**agent scaffold** — the loop shape, how work is batched, and how a task ends —
not the model and not the browser runtime (already at parity in
[`../browser-agent-headtohead`](../browser-agent-headtohead/REPORT.md)).

## The battery

15 scenarios across the complexity range: trivial baseline, dynamic extract,
static lookup, multi-step navigation, 2-way and 3-way multi-tab compares,
synthesis, form/search interaction, large-table extraction, pagination,
cross-site multi-hop, form fill + submit, and three complex ones — a login →
cart → checkout flow with computation (saucedemo), a 10-item aggregate + share
computation (HN), and table-row arithmetic (Wikipedia population gap).

## What changed between rounds (the iteration)

**Round 1 (baseline)** exposed three structural advantages on the reference side:

1. **Turn count.** BetterWright's floor was 2 model turns (act → `done`), and
   simple lookups cost 2–3 turns vs the reference's collapsed single-block shape. Every
   turn is a full `gpt-5.6-sol` round-trip (~4–8s), so BW lost every trivial
   task by 3–7s.
2. **Password rule too blunt.** `exec` mode has no vault, and the operator
   prompt banned typing *any* password — so BW refused the saucedemo login even
   though the user's task supplied the demo credentials. The reference just typed them.
3. **Giving up on transient errors.** BW retried a 503 twice and reported
   blocked; the reference ground on and completed.

Fixes shipped (harness + prompt, all unit-tested):

- **Single-call finish:** a `browser` call whose code returns
  `{ finalAnswer: "…" }` ends the task in that same turn — no `done`
  round-trip. Read-only tasks now cost **one** model turn. A guard ignores
  `finalAnswer` on an errored run, and (after round 2 caught a bad table row)
  the prompt requires the code to **check the extracted values satisfy the
  request** (match a ranked row by its own rank cell, not position) before
  finishing.
- **Task-supplied credentials are fillable:** vault/password-manager secrets
  remain untypeable, but a credential the user wrote into the task itself is
  not protected — fill it and proceed.
- **Transient 5xx/timeouts:** keep retrying with growing backoff for 30–60s
  before treating a site as down.

## Results (round 3, after the fixes)

| # | Scenario | BetterWright | Reference | Correct |
|---|----------|-------------:|------:|:---|
| 1 | Trivial baseline | **5.3s · 1 step** | 7.6s · 1 | both |
| 2 | Single extract (dynamic) | 18.0s · 1 | **8.6s** · 1 | both |
| 3 | Static lookup | **7.5s · 2** | 9.1s | both |
| 4 | Multi-step navigation | **7.0s · 1** | 11.1s · 1 | both |
| 5 | Multi-tab compare (2-way) | 24.8s · 3 | **10.3s** | both |
| 6 | Read + synthesize | 9.2s · 1 | **7.7s** · 1 | both |
| 7 | Form / search interaction | 89.7s · 6 | **14.0s** · 2 | both |
| 8 | Multi-tab compare (3-way) | 18.5s · 2 | **13.3s** | both |
| 9 | Large-table extraction | **25.6s · 3** | 17.9s · 1 | both |
| 10 | Pagination | 14.6s · 2 | **12.3s** · 2 | both |
| 11 | Deep multi-hop (cross-site) | **29.2s · 3** | 39.4s · 3 | both |
| 12 | Form fill + submit | 87.1s · 3 | 113.5s · 8 | site down (503): BW reported honestly; the reference answered **unconfirmed** |
| 13 | Login + cart + checkout | **50.7s · 5** | 64.2s · 13 | both ($17.98) |
| 14 | Aggregate + compute (10 items) | 24.4s · 2 | **17.9s** · 3 | both |
| 15 | Table rows + arithmetic | **22.5s · 2** | 150.0s **TIMEOUT** | BW only |

**Correctness: BetterWright 14/15** (sole miss = a genuinely down site,
reported honestly) — **reference 12/15** (population-gap timeout, unconfirmed
form-fill answer, and its checkout "answer" was a bare image path).

Round-2 numbers (same code except the round-3 table-check/backoff tweaks) tell
the same story with a healthier form-fill site: **BW median 10.2s vs reference
14.7s, BW faster on 10 of 15.** Averaged over both post-fix rounds, BW is
faster on 9 of the 14 non-environmental scenarios.

## Where each side wins now

**BetterWright wins:** everything single-call-able (trivial/lookup/multi-step
nav — now ~5–9s, reliably *faster* than the reference), table extraction with
verification, cross-site hops, and — decisively — the **complex interactive
flows**: login+cart+checkout in 5 turns vs the reference's 13, form fill in 3 vs 8.
The observe/act/verify discipline pays off exactly where the page fights back.

**The reference still wins:** multi-tab fact compares (it collapses everything into one
big repl block; BW spends 2–3 turns when extraction targets are uncertain) and
the Wikipedia search-box flow, where BW's snapshot-heavy caution is high
variance (20s/54s/90s across rounds). These are the residual cost of BW's
check-before-finish discipline — the same discipline that kept BW correct where
the reference timed out or answered unverified.

A post-round-3 recheck (after a nudge to parse article text instead of
snapshotting encyclopedia pages) brought wiki-search to **31.3s/4 steps vs
25.8s/5** — near parity — and confirmed hn-top/hn-top3 at parity (7.9s/9.7s vs
8.3s/8.9s). The multi-tab compares remain the one structural gap: ~30–36s
(2–3 turns) vs the reference's 12–20s single block, with both sides always correct.

## Token usage (BetterWright, round 3, measured live)

| Task | Steps | Input (uncached) | Cache read | Output | Context end |
|------|:---:|---:|---:|---:|---:|
| baseline-title | 1 | ~2.6K | 0 | ~0.1K | ~2.6K |
| saucedemo-checkout | 5 | ~8–10K | ~15–20K | ~0.9K | ~8–10K |

The reference exposes no per-task token counts (its daemon log is HTTP timings
only).

## Reproduce

```bash
betterwright auth --login codex        # one-time OAuth (ChatGPT / Codex plan)
node benchmarks/exec-headtohead/run.js            # all 15 scenarios, both harnesses
node benchmarks/exec-headtohead/run.js --only saucedemo  # a subset
```

Raw per-task output (answers, step counts, timings, proof paths) is written to
`results.json` next to the runner.

## Caveats

- Dynamic tasks (HN, releases) depend on live pages; the harnesses run minutes
  apart but landed on identical answers in every compared cell.
- "Steps" for the reference is a proxy (its `repl(` call count, `null` when the block
  count isn't visible in output); for BetterWright it is the real model-turn
  count.
- Single run per cell per round; LLM-latency variance is real (±2–3s small
  tasks, much larger on interactive flows — see the wiki-search spread).
  Cross-round patterns (single-call wins, compare-task gap, interactive-flow
  wins) reproduced in every round.
- httpbin.org was flaky-to-down during rounds 1 and 3; treat form-fill timing
  as environmental.
