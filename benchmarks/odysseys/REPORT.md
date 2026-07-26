# Odysseys Benchmark Campaign Report

**BetterWright × Odysseys (arXiv:2604.24964)**  
**Date:** 2026-07-23  
**Status:** Campaign **stopped early** (user request). Partial results retained.

This report covers harness setup, operational failures, judging methodology mistakes and fixes, score analysis, root causes of low perfect rates, and recommended next steps.

---

## 1. Executive summary

| Item | Value |
| --- | --- |
| Benchmark | Odysseys — 200 long-horizon multi-site web tasks |
| Agent | BetterWright `exec` harness + **`gpt-5.6-sol`** / **high** |
| Judge (final) | Pi multimodal + **`openai-codex/gpt-5.6-luna`** / **high** |
| Target concurrency | **8** (after 20-wide thrashing the host) |
| Tasks completed (agent) | **24 / 200** |
| Tasks judged | **23** (luna multimodal) |
| Perfect rate | **8.7%** (2/23) |
| Rubric average | **67.5%** |
| Agent run failures | **0** among finished attempts (tasks returned answers) |
| Campaign outcome | Stopped; not a full leaderboard run |

**Bottom line:** The agent reliably *finishes* tasks with partial success (~⅔ of rubrics), but rarely satisfies *every* Odysseys rubric (visual proof, open tabs, full multi-site coverage). Ops issues (over-parallelism, runner death, restarts) cut the campaign short and polluted early signal. An initial judge bug under-used screenshots; that was fixed before the scores below.

Paper reference (API computer-use agents, 100-step cap): Opus 4.6 **44.5%** perfect overall; easy **~98%**, hard **~11%**. Our sample is small and not directly comparable (different agent stack, live web, partial set).

---

## 2. What we built

Harness under `benchmarks/odysseys/`:

| Component | Role |
| --- | --- |
| `odysseys.json` + `full-200.json` | Official 200 tasks + rubrics |
| `exec-runner.ts` / `exec-task.ts` | Parallel agent campaign (isolated Chromium per task) |
| `judge.ts` | Per-rubric 0/1 scoring |
| `judge-loop.sh` | Background re-judge as submissions land |
| `agent-prompt.md` | Odysseys-specific operator guidance |
| `status.sh` | Progress snapshot |
| Output | `runs/full-200-gpt56sol-high/` |

**Agent loop:** BetterWright `runAgentTask` — observe/act via Playwright, no fixed step cap (wall-clock budget **90 min**, process timeout **100 min**).

**Metrics (paper-aligned):**
- **Rubric average** — mean of per-rubric 0/1 scores  
- **Perfect** — 1 only if every rubric on the task passes  

---

## 3. Campaign results (as stopped)

### 3.1 Agent progress

| | |
| --- | --- |
| Completed | **24** |
| Failed (no answer / process fail) | **0** among recorded attempts |
| Remaining | **176** (not run or wiped/restarted mid-flight) |
| Avg duration | **~10.0 min** (range 3.5–19.6) |
| Avg agent steps | **~34** (range 11–109) |

**By difficulty (completed):** easy 8 · medium 3 · hard 13  

### 3.2 Scores (23 luna judgments)

| Split | N | Perfect | Rubric avg |
| --- | ---: | ---: | ---: |
| **Overall** | 23 | **8.7%** (2/23) | **67.5%** |
| Easy | 7 | 14% | 55% |
| Medium | 3 | 33% | 80% |
| Hard | 13 | 0% | 72% |

Many hard tasks land at **80–86%** (one or two rubrics short) — near-misses, not total collapses.

### 3.3 Paper context (not apples-to-apples)

| Model (paper CUA) | Perfect overall | Easy | Hard |
| --- | ---: | ---: | ---: |
| Opus 4.6 | 44.5% | ~98% | ~11% |
| GPT-5.4 | 33.5% | ~80% | ~4% |
| **BetterWright + gpt-5.6-sol (this sample)** | **~9%** | **~14%** | **0%** |

Caveats: n=23, different scaffolding (Playwright/code agent vs screenshot CUA), live web variance, early stop, and our judge model (`luna` vs paper’s Gemini Flash Lite).

---

## 4. Operational / infrastructure issues

### 4.1 Over-parallelism (20 concurrent) crashed / lagged the dedicated host

- Initial full run used **concurrency 20** (each task = Chromium + model loop).  
- Host (~60 Gi RAM) was driven into heavy memory pressure / lag.  
- User reported the machine lagging out; concurrency was reduced to **8** and documented as the default.

**Lesson:** Cap browser-agent campaigns at **≤8** on a 60 Gi box unless memory is measured under load. Stagger browser starts (we used ~600 ms).

### 4.2 Multiple full restarts and data wipes

Sequence included:
1. Smoke test (1 easy task) — OK  
2. Full run at 20-wide — thrash  
3. Stop → config to 8-wide  
4. “Start from scratch” — wipe progress, restart  
5. Runner **died** mid-campaign after ~23 completes; 8 orphan runtimes left without `attempt.json`  
6. Resume (skip finished)  
7. User stop — kill all agent/judge/Chromium  

Each wipe invalidated partial progress; resume path relied on valid `submission/*/result.json` skip logic.

### 4.3 Agent runner process death

- Observed **exec-runner gone** while progress sat at 23/200 and **orphan runtimes** (in-flight tasks with screenshots but no final attempt).  
- Likely causes: OOM killer / host lag / accidental SIGTERM during process cleanup scripts / child Chromium storms.  
- Cleanup scripts that scanned `/proc` for “odysseys” strings sometimes **self-signaled** the controlling shell (tooling footgun).

**Lesson:** Prefer PID files + `setsid` for campaign control; never `kill` by broad cmdline match from the same shell that embeds those strings.

### 4.4 Incomplete campaign

- Stopped at **~12%** of tasks.  
- No full 200-task perfect/average numbers.  
- ETA estimates (when healthy at 8-wide, ~10 min/task) were **~4–8 hours** remaining for the rest; hard-task tail could push longer (90 min budget).

### 4.5 Resource snapshot (while healthy at 8-wide)

- ~8–9 workers: often **~20–35 Gi** RAM  
- After stop: **~4 Gi** RAM  

---

## 5. Judging issues

### 5.1 Wrong initial claim: “judge isn’t multimodal”

- BetterWright’s **Online-Mind2Web** judge is multimodal (Pi + `@screenshot` attachments, `gpt-5.6-sol`).  
- Early Odysseys `judge.mjs` incorrectly used a **text-only** `complete()` path and only pasted **file paths** into the prompt, while the system prompt said “multimodal.”  
- That was a **bug in the Odysseys harness**, not project design.

**Fix applied:** Odysseys judge rewritten to the same **Pi + `@image` multimodal** path as Online-Mind2Web.

### 5.2 Judge model change

| Phase | Judge model |
| --- | --- |
| Early broken / transitional | `gpt-5.6-sol` (text path or mixed) |
| Final | **`openai-codex/gpt-5.6-luna`** / high, method `pi-multimodal` |

Skip logic was updated so verdicts only skip when **same judge model** already graded (so luna re-grades old sol verdicts).

### 5.3 Judge loop noise

- Early loop wrote **`missing_submission`** verdicts for all 200 IDs before agents finished (race). Fixed: do not persist missing placeholders.  
- Score summary file sometimes lagged live on-disk verdicts.  
- Judge still scans full 200-task manifest each pass → lots of `missing_submission` log lines for unfinished IDs (harmless but noisy).

### 5.4 Paper judge vs ours

| | Odysseys paper | This campaign |
| --- | --- | --- |
| Model | `gemini-3.1-flash-lite-preview` | `gpt-5.6-luna` |
| Method | Per-rubric, screenshots + actions | Per-rubric, Pi multimodal screenshots + actions |
| Human agreement | Reported high in paper | Not measured here |

Scores are **local automated** judgments, not official Odysseys leaderboard numbers.

---

## 6. Why perfect rates stayed low (quality analysis)

### 6.1 Dominant failure themes (from luna reasoning text)

| Theme | Approx. frequency | Description |
| --- | ---: | --- |
| **No visual proof** | High | Answer claims facts; trajectory doesn’t show the product/recipe/official page |
| **Incomplete multi-item coverage** | Medium | Needed N sites/products/tabs; only subset evidenced |
| **SERP / search-only evidence** | Medium | Facts taken from Google results page without opening first-party page |
| **Access walls** | Low–medium | e.g. Etsy restriction page instead of listing |
| **Tabs not left open** | Low–medium | Rubric requires specific tabs open; final view doesn’t show them |
| **Missing / thin deliverable** | Low | Research without full structured deliverable |

### 6.2 “Google SERP” problem (clarified)

**SERP = Search Engine Results Page** (the list of links/snippets after a search).

Failure pattern:
1. Agent searches Google  
2. Reads **snippet** text (e.g. MPG, price)  
3. Puts it in the final answer  
4. Never opens the **U-Haul / product / recipe** page  

Judge correctly rejects: Odysseys wants **source-page** evidence, not search snippets.

### 6.3 Near-miss pattern (especially hard)

Many hard tasks: **5/6 or 6/7 rubrics pass**. One remaining rubric kills perfect, e.g.:
- “Verify all 9 candidates on official **and** retailer pages”  
- “Leave 3 YouTube + 4 product + 2 retailer tabs open”  
- “MPG figure from U-Haul’s site specifically”  

This matches paper observations (over-research, incomplete deliverables, high-fanout collapse) more than “agent can’t browse at all.”

### 6.4 Harness incentives that fight Odysseys

BetterWright’s default exec guidance optimizes for:
- Few model round-trips  
- Batch extraction  
- Early `return { finalAnswer }`  

Odysseys optimizes for:
- Multi-site proof  
- Open tabs  
- Exhaustive checklists  
- Visual trajectory evidence  

**Conflict:** speed/batching encourages SERP shortcuts; rubrics punish them.

---

## 7. Recommended fixes (priority order)

### Agent / prompt (highest ROI)

1. **SERP ≠ evidence** — search pages are navigation only; every reported fact needs a non-search URL + proof screenshot on that page.  
2. **Pre-finish checklist** — refuse `finalAnswer`/`done` while any checklist item’s evidence host is Google/Bing/DDG.  
3. **Open-tab rubrics** — explicitly keep required tabs; screenshot multi-tab state before finishing.  
4. **N-of-X coverage** — count items (10 sites, 9 products); don’t finish until N or mark remainder blocked.  
5. **Access walls** — report blocker; never invent listing details from SERP/snippet.  
6. Prefer **direct first-party URLs** when the task names a site.

### Harness (enforcement)

1. Optional finish guard in final browser code: reject evidence URLs matching search hosts.  
2. Structured evidence log: `{ fact, url, screenshot }` pairs for judge and debugging.  
3. Soft step guidance for Odysseys (long-horizon) without abandoning batching entirely.

### Ops

1. Default concurrency **8** (done).  
2. PID-file based start/stop; no broad `/proc` greps from interactive shells.  
3. Auto-resume watchdog if `exec-runner` dies (restart, skip valid submissions).  
4. Judge only task IDs that have `result.json` (less log noise).

### Eval

1. Keep **luna multimodal** (or paper Gemini) for final numbers.  
2. Spot human audit of 10–20 verdicts for agreement.  
3. Report both **perfect** and **rubric average** (partial credit matters for training signal).

---

## 8. Per-task score appendix (judged)

| Level | Task ID (prefix) | Rubric avg | Perfect | Failed rubrics |
| --- | --- | ---: | ---: | --- |
| easy | `156e2acc95361db4` | 100% | yes | — |
| easy | `0ce94d4e773eff10` | 83% | no | R4 |
| easy | `140960bb7293bdee` | 75% | no | R1 |
| easy | `1d3952479bc687cb` | 50% | no | R1, R2 |
| easy | `082aa17f3e88c3ce` | 50% | no | R1, R4 |
| easy | `0ab48db6076089bb` | 25% | no | R1–R3 |
| easy | `1211fbaa646424ab` | 0% | no | R1–R5 |
| medium | `18ddad3e0781d4b8` | 100% | yes | — |
| medium | `0eecee553a8cdda9` | 80% | no | R1 |
| medium | `041a4bee5d80a285` | 60% | no | R1, R5 |
| hard | `17f506970491ac59` | 86% | no | R3 |
| hard | `1d20e51c4aa23eb6` | 86% | no | R7 |
| hard | `2075861f234062f2` | 86% | no | R3 |
| hard | `03328a94fec2dce9` | 86% | no | R2 |
| hard | `09fe03cd3da0fac1` | 83% | no | R4 |
| hard | `228dda0bbfce65f7` | 83% | no | R5 |
| hard | `1fd26abb3743ca1d` | 80% | no | R5, R6 |
| hard | `148dc4d3bebc5769` | 67% | no | R3, R6 |
| hard | `20cea7be868a6dba` | 67% | no | R1, R6 |
| hard | `23081b41564a070a` | 57% | no | R3, R6, R7 |
| hard | `0dc4be74eb82df8d` | 57% | no | R1, R3, R4 |
| hard | `1f90184fb61690b3` | 50% | no | R1, R4, R5 |
| hard | `08e2ad6afc624b6f` | 43% | no | R4–R7 |

Full artifacts: `runs/full-200-gpt56sol-high/submission/<task_id>/` (`result.json`, `trajectory/`, `rubric-verdict.json`).

---

## 9. Timeline (compressed)

1. Odysseys research + harness scaffolded from Online-Mind2Web exec pattern.  
2. Smoke test: 1 easy task, high agent — completed; early judge path messy.  
3. Full 200 launched too hot (**20-wide**) → host lag / user intervention.  
4. Concurrency cut to **8**; multiple restarts / “from scratch” wipes.  
5. Judge corrected to **Pi multimodal**; model set to **`gpt-5.6-luna`**.  
6. Partial campaign: **24 agent completes**, **23 judged**, ~**9% perfect**, **~68%** rubric avg.  
7. Runner death + resume; then **full stop** on user request.  
8. This report.

---

## 10. Artifacts & how to resume later

```text
benchmarks/odysseys/
  REPORT.md                 # this file
  README.md                 # how to run
  agent-prompt.md
  exec-runner.ts            # default concurrency 8
  judge.ts                  # luna multimodal
  runs/full-200-gpt56sol-high/
    progress.jsonl
    submission/<id>/...
    runtime/<id>/...
logs/odysseys-full-200-gpt56sol-high.log
logs/odysseys-judge.log
```

Resume (skips valid submissions):

```bash
node benchmarks/odysseys/exec-runner.js run \
  --tasks benchmarks/odysseys/odysseys.json \
  --manifest benchmarks/odysseys/full-200.json \
  --output benchmarks/odysseys/runs/full-200-gpt56sol-high \
  --model gpt-5.6-sol --effort high --concurrency 8

node benchmarks/odysseys/judge.js \
  --tasks benchmarks/odysseys/odysseys.json \
  --manifest benchmarks/odysseys/full-200.json \
  --output benchmarks/odysseys/runs/full-200-gpt56sol-high \
  --model openai-codex/gpt-5.6-luna --thinking high --concurrency 2
```

**Do not** raise concurrency above 8 on this host without measuring RAM.

---

## 11. Conclusions

1. **Ops first:** 20-wide browser agents on one dedi was unsafe; **8-wide** is the working bound.  
2. **Partial success ≠ perfect:** ~68% rubric average with ~9% perfect is “does most of the checklist, fails proof/completeness.”  
3. **Biggest quality gap:** claiming answers without first-party page proof (SERP snippets, missing screenshots, incomplete N-of-X).  
4. **Judging is usable** after the multimodal + luna fix; earlier text-path scores should be disregarded.  
5. **Not a finished leaderboard run** — treat numbers as a diagnostic pilot, not a published BetterWright Odysseys score.

Next engineering step when ready: patch `agent-prompt.md` with SERP/proof/tab/N-of-X rules, optionally add a finish guard, re-run a stratified 20–40 task pilot at concurrency 8, then full 200.
