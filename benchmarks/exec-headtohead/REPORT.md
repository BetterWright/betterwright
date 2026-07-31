# `betterwright exec` vs a reference agent — a development case study

**This is not a benchmark, and it is not reproducible as published.** It is the
record of a development exercise: BetterWright's `exec` agent was run against a
second agent CLI over a 15-scenario battery, the places where `exec` lost were
diagnosed, fixes were shipped, and the battery was re-run. The result is a
useful account of *what was wrong and what changed*. It is not evidence that one
agent is better than another, and it should not be read that way.

**Date:** 2026-07-19 (15 scenarios, three rounds)
**Model, both sides:** `gpt-5.6-sol` at reasoning effort `low`
**BetterWright:** `betterwright exec "<task>" --model gpt-5.6-sol`. The runs
predate the current model selector and were invoked as `--model codex`, a
shortcut today's CLI rejects in favour of real model ids; the command above is
the equivalent current invocation.
**Reference:** a second agent's own CLI, `exec -m openai-codex/gpt-5.6-sol
--effort low "<task>"`, with a no-subagents instruction appended to every task
(BetterWright has no subagents, so the reference's child-session machinery was
prompt-disabled; it has no CLI flag for it).

## What you can and cannot conclude from this

**You cannot conclude anything comparative.** The reference agent is not named,
not vendored, and not pinned to a version, so nobody can re-run its column. Its
numbers here are unauditable. Beyond that:

- Each cell is a **single run**. LLM latency variance on these scenarios is
  large — one scenario spread across 20s/54s/90s between rounds — so most
  individual timing differences are inside the noise.
- Correctness was **assessed by hand**, not machine-scored. The `completed`
  flags in [`results.json`](results.json) record only that a harness returned
  something without erroring.
- The BetterWright side was **iterated against this battery** across the three
  rounds while the reference side was not. Round-3 numbers are therefore
  measured after tuning on the same 15 scenarios that produce them. That is the
  definition of fitting to your test set, and it is why the comparison table is
  presented below as a development log rather than a score.
- Two scenarios were affected by an external site being down or rate-limited.

**You can conclude something about BetterWright.** The BetterWright column is
reproducible from this repository, the defects the exercise found were real and
are described concretely below, and the fixes for them are in the shipped code
with unit tests. That is the value of this document.

## The battery

15 scenarios spanning: trivial baseline, dynamic extract, static lookup,
multi-step navigation, 2-way and 3-way multi-tab compares, synthesis,
form/search interaction, large-table extraction, pagination, cross-site
multi-hop, form fill and submit, and three complex flows — login → cart →
checkout with computation, a 10-item aggregate with a share computation, and
table-row arithmetic. They are defined in [`run.ts`](run.ts).

## What the exercise found, and what was fixed

Round 1 exposed three structural defects in `exec`, all since fixed:

1. **A two-turn floor.** Every task cost at least two model turns (act, then a
   separate `done`), and each turn is a full model round-trip. Simple lookups
   paid 2–3 turns for work that needed one.

   *Fix:* a `browser` call whose code returns `{ finalAnswer: "…" }` ends the
   task in that same turn. Read-only tasks now cost one model turn. A guard
   ignores `finalAnswer` on an errored run. After round 2 surfaced a
   wrong-table-row answer, the prompt additionally requires the code to check
   that the extracted values satisfy the request — matching a ranked row by its
   own rank cell rather than by position — before finishing.

2. **A password rule that was too blunt.** `exec` mode has no vault, and the
   operator prompt banned typing *any* password, so the agent refused a demo
   login even though the user's own task text supplied the credentials.

   *Fix:* vault and password-manager secrets remain untypeable; a credential the
   user wrote into the task itself is not a protected secret, and is filled.

3. **Giving up on transient errors.** A 503 was retried twice and then reported
   as blocked.

   *Fix:* transient 5xx and timeouts retry with growing backoff for 30–60s
   before a site is treated as down.

These three are the substantive output of the exercise. They were found by
running a second implementation alongside and asking why it did better, which is
a good way to find defects and a poor way to produce a ranking.

## Round-3 log (after the fixes)

Read this as "what the two harnesses did on one afternoon", not as a
leaderboard. Single runs; bold marks the faster cell only.

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
| 12 | Form fill + submit | 87.1s · 3 | 113.5s · 8 | site down (503): BW reported the failure; the reference answered unconfirmed |
| 13 | Login + cart + checkout | **50.7s · 5** | 64.2s · 13 | both ($17.98) |
| 14 | Aggregate + compute (10 items) | 24.4s · 2 | **17.9s** · 3 | both |
| 15 | Table rows + arithmetic | **22.5s · 2** | 150.0s **TIMEOUT** | BW only |

By hand-assessed correctness in this round: BetterWright 14/15 (its one miss was
a genuinely down site, reported as such), reference 12/15 (one timeout, one
unconfirmed form-fill answer, and a checkout "answer" that was a bare image
path). Round 2, with a healthier form-fill site, showed the same shape.

Caveats that apply to every row: single run, BetterWright tuned against these
scenarios and the reference not, reference unversioned and unnamed, and
`Steps` means different things on the two sides — a true model-turn count for
BetterWright, and a count of `repl(` calls in stdout as a rough proxy for the
reference.

## Observations worth keeping

Stated as observations from this exercise, not as measured general properties:

- The scenarios that became fast for BetterWright are the ones the single-call
  finish applies to: trivial lookups, static facts, single-hop navigation.
- The complex interactive flows were where BetterWright used markedly fewer
  turns — checkout in 5 versus 13, form fill in 3 versus 8. The observe/act/
  verify discipline costs turns on easy work and saves them when the page
  fights back.
- Multi-tab fact comparison was the consistent gap in the other direction: the
  reference collapses the whole comparison into one code block, while
  BetterWright spends 2–3 turns when the extraction targets are uncertain. Both
  sides were always correct on those.
- BetterWright's snapshot-heavy caution on the search-box flow was high variance
  (20s/54s/90s across rounds). A later adjustment — parse article text rather
  than snapshot the whole encyclopedia page — brought that scenario to 31.3s/4
  steps against 25.8s/5.

## Token usage (BetterWright, measured live)

| Task | Steps | Input (uncached) | Cache read | Output | Context end |
|------|:---:|---:|---:|---:|---:|
| baseline-title | 1 | ~2.6K | 0 | ~0.1K | ~2.6K |
| saucedemo-checkout | 5 | ~8–10K | ~15–20K | ~0.9K | ~8–10K |

Only BetterWright's numbers are available; the reference exposes no per-task
token counts.

## Running it

The reference CLI is not shipped or named here, so [`run.ts`](run.ts) requires
you to supply one via `REFERENCE_CLI` and exits with an explanation if it is
unset:

```bash
betterwright auth --login codex                   # one-time OAuth
REFERENCE_CLI=your-cli node benchmarks/exec-headtohead/run.js
REFERENCE_CLI=your-cli node benchmarks/exec-headtohead/run.js --only saucedemo
```

[`results.json`](results.json) holds per-scenario outcomes, timings, turn counts
and BetterWright token usage. It deliberately contains no agent answers, no
model transcripts, and no local artifact paths; pass `--raw <file>` to dump
those to a path of your choosing while debugging, and do not commit the result.
Correctness is not machine-scored — the runner prints each side's answer so you
can score it yourself.
