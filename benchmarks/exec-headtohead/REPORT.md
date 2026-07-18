# `betterwright exec` vs `aside exec` — agent-scaffold head-to-head

**Date:** 2026-07-18 (re-run after the batching + harness work)
**Model (both sides):** `gpt-5.6-sol` — **reasoning effort `low`**
**BetterWright:** `betterwright exec "<task>" --model codex` (codex OAuth → ChatGPT
backend Responses API, direct, no router)
**Aside:** `aside exec -m openai-codex/gpt-5.6-sol --effort low "<task>"`

Both harnesses drive the **same model at the same effort**, so this isolates the
**agent scaffold** — the observe/act/verify loop and how it batches browser work
— not the model and not the browser runtime. (The runtime itself was already at
parity in [`../asidewright-headtohead`](../asidewright-headtohead/REPORT.md).)

This is BetterWright's **own** agent harness. An earlier benchmark ran BetterWright
under the general-purpose Pi coding agent and measured a ~20s gap; the point of
`betterwright exec` was to close that, and the batching guidance added in this pass
closed most of what remained.

## Results

| # | Scenario | Task | BetterWright | Aside | Both correct? |
|---|----------|------|-------------:|------:|:---:|
| 1 | Trivial baseline | example.com title | 7.2s · 2 steps | 6.9s · 1 | ✅ |
| 2 | Single extract (dynamic) | HN #1 title + points | 9.6s · 2 | 10.1s · 1 | ✅ (both 144 pts) |
| 3 | Static lookup | Eiffel Tower height | **7.0s · 2** | 14.3s | ✅ (both 330 m) |
| 4 | Multi-step navigation | latest `microsoft/playwright` release tag | **9.3s · 2** | 12.0s · 1 | ✅ (both v1.61.1) |
| 5 | Multi-tab compare | Eiffel vs Statue of Liberty height | **36.0s · 4** | 4.2s | ✅ (both: Eiffel, +237 m) |
| 6 | Read + synthesize | top 3 HN titles in order | 8.8s · 2 | 7.5s · 1 | ✅ (identical list) |
| 7 | Form / search interaction | Wikipedia search → first sentence | 22.8s · 4 | 10.1s **FAIL** | BW ✅ / Aside ✗ |

**Success: BetterWright 7/7. Aside 6/7** — Aside failed the Wikipedia
search-and-read task this run; BetterWright returned the correct first sentence.

- **Median:** BetterWright **9.3s** · Aside **10.1s** — BetterWright is now *faster
  at the median*.
- **Faster than Aside on 3 tasks** (#3 static lookup, #4 multi-step nav, #2 dynamic
  extract) and at parity on #1 and #6.
- **Totals:** BetterWright 100.7s · Aside 65.1s (one of Aside's was a failure).

## Token usage (BetterWright, measured live)

Captured from the codex Responses stream (`response.usage`) per model turn:

| Task | Steps | Input (total) | cached | Output | Grand total |
|------|:---:|---:|---:|---:|---:|
| Eiffel height (simple) | 2 | 5,032 | 3,072 (61%) | 166 | **5,198** |
| Eiffel vs Liberty (multi-tab) | 4 | 16,837 | 11,264 (67%) | 663 | **17,500** |

- System-prompt floor ≈ **1,536 tokens**, **cached on every turn after the first**
  (the per-session `prompt_cache_key` does real work — 61–67% of input is a cache
  hit).
- Output is tiny (compact tool code + short reasoning, not prose).
- Aside exposes no per-task token count (daemon log records only HTTP timings), so
  a like-for-like Aside number isn't available; architecturally its ~1-turn shape
  trades more per-turn context for fewer round-trips.

## Reading the result

**Correctness is at parity or better** — BetterWright completed every task with the
same answers Aside produces, and got one that Aside missed, autonomously, capturing
a proof screenshot each time.

**The scaffold gap is closed on ordinary tasks.** Baseline, extract, lookup,
multi-step navigation, and synthesis all land at 7–10s, within noise of Aside and
faster on several. The old 50s `github-release` outlier from the previous run
collapsed to **9.3s** once the harness learned to batch a known multi-hop flow into
one `browser` call.

**One structural outlier remains: multi-tab comparison (#5).** There Aside collapses
the whole task into **one** big `repl` block (open both tabs, extract, compute,
answer) and pays for a single model turn, while BetterWright's loop takes 4 tighter
observe → act → verify turns. Because each turn is a full `gpt-5.6-sol` round-trip
(~8s at low effort), wall-clock is dominated by turn count. The browser runtime is
not the cost; the number of model turns is — the same mechanism drives both the
latency and the token totals above.

### Remaining opportunity

Push the "one `browser` call opens all needed tabs and returns all needed values"
batching further into the multi-tab case so #5 collapses toward Aside's single-turn
5s. This is a harness/prompt refinement, not a runtime limitation.

## Reproduce

```bash
betterwright auth --login codex        # one-time OAuth (ChatGPT / Codex plan)
node benchmarks/exec-headtohead/run.mjs            # all 7 scenarios, both harnesses
node benchmarks/exec-headtohead/run.mjs --only hn  # a subset
```

Raw per-task output (answers, step counts, timings, proof paths) is written to
`results.json` next to the runner.

## Caveats

- Dynamic tasks (#2, #6) depend on the live HN front page; the two harnesses ran
  minutes apart but landed on the same #1 story here.
- "Steps" for Aside is a proxy (its `repl(` call count); for BetterWright it is the
  harness's real model-turn count. Aside's one-big-block style makes its step count
  structurally lower — which is exactly the mechanism this report measures.
- Single run per cell. Timings carry normal LLM-latency variance (±2–3s on the small
  tasks; the Wikipedia-search task has shown 19–23s across trials). The multi-tab
  outlier pattern on #5 reproduced across trials and is structural, not noise.
