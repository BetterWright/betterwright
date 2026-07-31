# Odysseys: partial run report

**Benchmark:** Odysseys — 200 long-horizon, multi-site web tasks with per-rubric
grading (arXiv:2604.24964)
**Date:** 2026-07-23
**Status:** Exploratory. **24 of 200 tasks attempted, 23 judged.** This is not a
complete run and not a leaderboard result.

## Scope and what this does not show

The campaign was stopped before completion, so there is no BetterWright score on
the full 200-task set. Everything below describes a sample of 23 judged tasks
drawn from the first tasks the runner reached. That sample was not stratified:
it is 7 easy, 3 medium, and 13 hard. With n=23 and an unbalanced difficulty mix,
the aggregate rates are diagnostic signal about failure modes, not a measurement
of capability, and they should not be compared directly with published Odysseys
numbers.

Verdicts produced by an earlier judge configuration were discarded and are not
included. Every number here comes from the multimodal judge described below,
re-run over the same trajectories.

## Configuration

| | |
| --- | --- |
| Agent | BetterWright `exec` harness, `gpt-5.6-sol`, reasoning `high` |
| Budget | 90 minutes wall clock per task, no fixed step cap |
| Concurrency | 8 |
| Judge | `openai-codex/gpt-5.6-luna`, reasoning `high`, multimodal (screenshots + actions) |
| Grading | Per-rubric 0/1, scored independently against the trajectory and final answer |

Judging is automated LLM-as-judge, not human adjudication, and uses a different
judge model from the paper's. Its agreement with human graders was not measured
here.

## Results (23 judged tasks)

| Split | n | Perfect | Rubric average |
| --- | ---: | ---: | ---: |
| **Overall** | 23 | **8.7%** (2/23) | **67.5%** |
| Easy | 7 | 14.3% | 54.8% |
| Medium | 3 | 33.3% | 80.0% |
| Hard | 13 | 0.0% | 71.5% |

- **Rubric average** — mean of the per-rubric 0/1 scores on a task, then the
  mean over tasks. Partial credit.
- **Perfect** — 1 only if every rubric on the task scores 1.

Agent-side execution, across the 24 completed tasks: no task failed to produce
an answer, mean duration 10.0 minutes (range 3.5–19.6), and roughly 34 agent
steps on average (range 11–109).

The headline is the gap between the two metrics. The agent completes tasks and
satisfies about two thirds of the individual rubrics, but almost never satisfies
all of them. The distribution is not bimodal: on hard tasks the common outcome
is 5/6 or 6/7 rubrics passing, which is a near miss on a strict all-or-nothing
metric rather than a failure to browse.

Note that easy tasks score *lower* on rubric average here than hard ones. With
n=7 and n=13 that difference is not meaningful on its own; it is reported
because omitting it would misrepresent the sample.

For context, the paper reports perfect rates of 44.5% (Opus 4.6) and 33.5%
(GPT-5.4) for API computer-use agents under a 100-step cap. That comparison is
not like-for-like: different agent architecture, different judge model, live-web
variance, and a partial, unstratified sample on this side.

## Failure analysis

Themes taken from the judge's per-rubric reasoning on the failed rubrics,
ordered by how often they appeared:

| Theme | Frequency | Description |
| --- | --- | --- |
| No visual proof | High | The answer asserts a fact the trajectory never shows on the source page |
| Search-results-only evidence | Medium | A fact is taken from a search engine's snippet without opening the first-party page |
| Incomplete multi-item coverage | Medium | The task required N sites or products; only a subset is evidenced |
| Tabs not left open | Low–medium | A rubric requires specific tabs still open at the end; the final view does not show them |
| Access walls | Low–medium | A site returned a restriction page instead of the requested listing |
| Thin deliverable | Low | Research performed, but not returned in the structured form asked for |

The dominant pattern is an evidence problem rather than a navigation problem.
Odysseys rubrics ask a grader to *confirm* a claim against the trajectory, so a
correct answer with no screenshot of the page it came from scores zero on that
rubric.

This is partly a conflict between two objectives. BetterWright's default `exec`
guidance optimizes for few model round-trips, batched extraction, and finishing
as soon as the answer is known. Odysseys rewards multi-site proof, exhaustive
checklists, tabs left in a specific end state, and visual evidence for every
claim. Batching and early finishing are exactly what produce search-snippet
answers and missing screenshots.

## Suggested follow-up

Agent policy, in rough order of expected value:

1. Treat search-results pages as navigation only. Every reported fact needs a
   non-search URL and a screenshot taken on that page.
2. Add a pre-finish checklist pass that refuses to finish while any checklist
   item's evidence host is a search engine.
3. Handle open-tab rubrics explicitly: keep the required tabs and capture the
   multi-tab state before finishing.
4. Count N-of-X coverage; do not finish until N items are evidenced or the
   remainder is explicitly reported as blocked.
5. On an access wall, report the blocker rather than reconstructing listing
   details from a snippet.

Harness:

1. Optional finish guard that rejects evidence URLs on search hosts.
2. A structured `{ fact, url, screenshot }` evidence log, for the judge and for
   debugging.
3. Judge only task IDs that have a `result.json`, to cut log noise on a partial
   campaign.

Evaluation:

1. Spot-audit 10–20 verdicts against human judgement to estimate agreement.
2. Report perfect rate and rubric average together; the partial credit is where
   the actionable signal is.
3. Re-run as a stratified 20–40 task pilot before attempting the full 200.

## Per-task appendix

All 23 judged tasks. Task IDs are truncated to 16 characters.

| Level | Task ID | Rubrics passed | Rubric average | Perfect | Failed rubrics |
| --- | --- | ---: | ---: | :---: | --- |
| easy | `156e2acc95361db4` | 5/5 | 100% | yes | — |
| easy | `0ce94d4e773eff10` | 5/6 | 83% | no | R4 |
| easy | `140960bb7293bdee` | 3/4 | 75% | no | R1 |
| easy | `082aa17f3e88c3ce` | 2/4 | 50% | no | R1, R4 |
| easy | `1d3952479bc687cb` | 2/4 | 50% | no | R1, R2 |
| easy | `0ab48db6076089bb` | 1/4 | 25% | no | R1, R2, R3 |
| easy | `1211fbaa646424ab` | 0/5 | 0% | no | R1, R2, R3, R4, R5 |
| medium | `18ddad3e0781d4b8` | 4/4 | 100% | yes | — |
| medium | `0eecee553a8cdda9` | 4/5 | 80% | no | R1 |
| medium | `041a4bee5d80a285` | 3/5 | 60% | no | R1, R5 |
| hard | `03328a94fec2dce9` | 6/7 | 86% | no | R2 |
| hard | `17f506970491ac59` | 6/7 | 86% | no | R3 |
| hard | `1d20e51c4aa23eb6` | 6/7 | 86% | no | R7 |
| hard | `2075861f234062f2` | 6/7 | 86% | no | R3 |
| hard | `09fe03cd3da0fac1` | 5/6 | 83% | no | R4 |
| hard | `228dda0bbfce65f7` | 5/6 | 83% | no | R5 |
| hard | `1fd26abb3743ca1d` | 8/10 | 80% | no | R5, R6 |
| hard | `148dc4d3bebc5769` | 4/6 | 67% | no | R3, R6 |
| hard | `20cea7be868a6dba` | 4/6 | 67% | no | R1, R6 |
| hard | `0dc4be74eb82df8d` | 4/7 | 57% | no | R1, R3, R4 |
| hard | `23081b41564a070a` | 4/7 | 57% | no | R3, R6, R7 |
| hard | `1f90184fb61690b3` | 3/6 | 50% | no | R1, R4, R5 |
| hard | `08e2ad6afc624b6f` | 3/7 | 43% | no | R4, R5, R6, R7 |

Per-task artifacts (trajectory, final answer, and the per-rubric verdict with
the judge's reasoning) are written to `runs/<campaign>/submission/<task_id>/`,
which is gitignored because it contains browser profiles and screenshots.

## Reproducing

See [`README.md`](README.md) for commands, dataset provenance, and the
concurrency note. Both the runner and the judge resume rather than restart, so a
stopped campaign can be continued by re-issuing the same command.
