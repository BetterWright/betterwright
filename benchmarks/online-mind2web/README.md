# Online-Mind2Web benchmark

> Compile the harness first: `npm run build:harness` (emits the `.js` next to each `.ts`).

This directory contains BetterWright's reproducible 50-task
[Online-Mind2Web](https://github.com/OSU-NLP-Group/Online-Mind2Web) harness. It
runs Pi Coding Agent through the native BetterWright extension, emits the
benchmark's `online-mind2web-v2` result/trajectory layout, validates it, and can
apply a strict local multimodal judge.

## Recorded 300-task result — 2026-07-15

The iterative 300-task campaign reached **278/300 (92.7%)** using the pinned
2025-11-23 snapshot. See the public-safe [`REPORT.md`](REPORT.md) and
[`results.json`](results.json). This is a local strict-judge result, not an
official human evaluation or leaderboard score.

## Recorded 50-task result — 2026-07-15

| Partition | Result | Rate |
| --- | ---: | ---: |
| Development baseline | 26/35 | 74.3% |
| Development after targeted iterations | 34/35 | 97.1% |
| Frozen holdout | 13/15 | 86.7% |
| Combined 50-task campaign | **47/50** | **94.0%** |

The combined result uses the best validated outcome for each development task
after targeted reruns, plus one agent run for every untouched holdout task. It
is an iterative engineering result, not a one-shot 50-task run. All agent and
judge invocations were pinned to `openai-codex/gpt-5.6-sol` with `high`
reasoning and the agent had a 100-browser-step budget.

The local judge is deliberately labeled **not official human evaluation**. It
is not the benchmark team's WebJudge configuration and must not be presented as
an official leaderboard score. The official project recommends starting at the
specified site, submitting factual v2 trajectories, and using its own review
path. Runtime evidence is under `runs/` locally and is gitignored because it
contains browser profiles, screenshots, and model-session artifacts.

## Sample protocol

[`sample-50.json`](sample-50.json) is an order-independent, difficulty-stratified
SHA-256 sample with seed `betterwright-online-mind2web-v1`:

- 50 distinct tasks: 14 easy, 24 medium, and 12 hard.
- 35 development tasks and 15 holdout tasks.
- Task bases listed by the official update log as changed after the source
  snapshot are excluded before sampling.
- The 15 holdout tasks were not used to change the agent prompt or browser
  implementation. A judge evidence-selection fix developed from a development
  case was applied consistently to the unchanged development and holdout
  trajectories.

The official Hugging Face dataset was access-gated on the benchmark machine, so
the run used the public
[Genteki mirror](https://huggingface.co/datasets/Genteki/Online-Mind2Web) dated
2025-11-23. Exact inputs:

```text
task JSON SHA-256: 9e12bc981aa8bac167987f2e762669f3efa16a3ded2ea75609cfcba888aa0422
sample manifest SHA-256: e9e5ba077fdab5c0397b3671cb8e833a28094c40a1a8422199cbca033b75e42b
```

## Run it

Set `TASKS` to an Online-Mind2Web JSON array (or `{ "tasks": [...] }`) with
`task_id`, `website`, `task`, `reference_length`, and `level` fields.

```bash
export TASKS=/absolute/path/to/Online-Mind2Web.json

node benchmarks/online-mind2web/runner.js sample \
  --tasks "$TASKS" \
  --manifest benchmarks/online-mind2web/sample-50.json \
  --count 50 \
  --holdout-count 15

# Or create a manifest containing every task in the pinned snapshot.
node benchmarks/online-mind2web/runner.js full \
  --tasks "$TASKS" \
  --manifest benchmarks/online-mind2web/full-300.json

node benchmarks/online-mind2web/runner.js run \
  --tasks "$TASKS" \
  --manifest benchmarks/online-mind2web/sample-50.json \
  --output benchmarks/online-mind2web/runs/development \
  --partition development \
  --max-steps 100 \
  --timeout-minutes 45 \
  --concurrency 3

node benchmarks/online-mind2web/runner.js validate \
  --tasks "$TASKS" \
  --manifest benchmarks/online-mind2web/sample-50.json \
  --output benchmarks/online-mind2web/runs/development \
  --partition development

node benchmarks/online-mind2web/judge.js \
  --tasks "$TASKS" \
  --manifest benchmarks/online-mind2web/sample-50.json \
  --output benchmarks/online-mind2web/runs/development \
  --partition development \
  --max-images 12 \
  --timeout-minutes 10 \
  --concurrency 3
```

Both scripts pin the benchmark model and reasoning level in source. Use
`--task-id ID` or `--task-ids ID1,ID2` for development reruns, and `--force`
only when intentionally replacing an existing run or verdict.

## What improved

The iterations added or strengthened:

- a native Pi package extension with a persistent BetterWright browser,
  screenshot vision blocks, step budgets, trace recording, and download policy;
- recoverable start-page failures rather than poisoning every later tool call;
- active-tab tracking so an inactive stale challenge cannot replace the current
  page's screenshot or challenge state;
- exact-filter, ranking, semantic-label, ZIP provenance, compound-task, and
  fallback-evidence rules in the benchmark agent policy;
- deterministic v2 trajectory conversion, resumable runs, subset reruns,
  missing-submission failures, and first-frame retention in judge evidence.

The one unresolved development task required a real saved-preference mutation
on a site whose store-search application returned a country-level access block.
BetterWright reported the blocker instead of editing local storage or the DOM to
simulate success. With 50 binary tasks, the first score above 95% is 48/50
(96%); the recorded run finished one task short of that mark.
