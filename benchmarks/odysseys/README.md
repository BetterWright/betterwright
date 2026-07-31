# Odysseys benchmark harness

> Compile the harness first: `npm run build:harness` (emits the `.js` next to each `.ts`).

Odysseys is a long-horizon, multi-site web agent benchmark: 200 tasks derived
from real browsing sessions, evaluated on the live internet, each annotated with
a set of graded rubrics rather than a single pass/fail.

This directory runs those tasks through BetterWright's own `exec` agent
(`src/agent.ts`, compiled to `dist/src/agent.js`), records screenshot
trajectories, and scores them with the paper's per-rubric grading style.

The result recorded here is a **partial, exploratory run of 24 of the 200
tasks** — see [`REPORT.md`](REPORT.md). There is no complete BetterWright
Odysseys result.

## Dataset provenance and license

`odysseys.json` is a copy of the benchmark's 200 tasks and rubrics. It is
third-party data, not BetterWright's.

**Source**

> Lawrence Keunho Jang, Jing Yu Koh, Daniel Fried, Ruslan Salakhutdinov.
> *Odysseys: Benchmarking Web Agents on Realistic Long Horizon Tasks.*
> arXiv:2604.24964. <https://arxiv.org/abs/2604.24964>

```text
odysseys.json SHA-256: 77a17bda3d04a93b178fd9c246b31c070d138cabb6f1cd1759a41973d2913b7f
full-200.json SHA-256: d6fea49f17040d7ea3ef9f482de056e0db4bba082fd800f080052f8581c02b79
```

**License: MIT**, from the dataset's own release at
<https://github.com/ljang0/Odysseys> (`Copyright (c) 2026 ljang0`), which is the
upstream recorded in `full-200.json`. The MIT terms permit the copy kept here as
long as the notice above travels with it; the arXiv listing covers only the
paper and grants no rights over the task data, so the repository license is the
one that governs. Cite the paper when you publish results.

The harness does not depend on the vendored copy. Every entry point takes
`--tasks <path>`, so you can supply your own copy from the original source and
this directory needs no task file at all:

```bash
node benchmarks/odysseys/exec-runner.js run --tasks /path/to/your/odysseys.json …
```

This mirrors [`../online-mind2web`](../online-mind2web/README.md), which ships
no dataset and requires the operator to point `--tasks` at one.

## Configuration used for the recorded run

| Setting | Value |
| --- | --- |
| Model | `gpt-5.6-sol` |
| Reasoning effort | `high` |
| Tasks attempted | 24 of 200 |
| Agent wall-clock budget | 90 minutes per task |
| Process timeout | 100 minutes per task |
| Concurrency | 8 |
| Judge | `openai-codex/gpt-5.6-luna`, `high`, multimodal |

This is a local BetterWright evaluation, not an official Odysseys leaderboard
submission. Rubric judging is automated LLM-as-judge, not human adjudication.

## Cost and concurrency

A full 200-task campaign is long and expensive: each task is an independent
Chromium instance plus a model loop with a 90-minute budget, and the recorded
tasks averaged about 10 minutes each. Run a small stratified pilot before
committing to the full set.

Each concurrent task holds its own browser, so memory scales with concurrency.
Concurrency above 8 exhausted memory on a single host in our runs, which is why
8 is the default; raise it only after measuring peak RSS under load. The runner
staggers browser starts by 600 ms to avoid a launch spike.

## Run

```bash
# Agent campaign
node benchmarks/odysseys/exec-runner.js run \
  --tasks benchmarks/odysseys/odysseys.json \
  --manifest benchmarks/odysseys/full-200.json \
  --output benchmarks/odysseys/runs/full-200 \
  --model gpt-5.6-sol \
  --effort high \
  --concurrency 8 \
  --agent-budget-minutes 90 \
  --timeout-minutes 100

# Rubric judge — multimodal, screenshots + actions
node benchmarks/odysseys/judge.js \
  --tasks benchmarks/odysseys/odysseys.json \
  --manifest benchmarks/odysseys/full-200.json \
  --output benchmarks/odysseys/runs/full-200 \
  --model openai-codex/gpt-5.6-luna \
  --thinking high \
  --concurrency 2

# Point-in-time progress and score snapshot; safe to run mid-campaign
benchmarks/odysseys/status.sh benchmarks/odysseys/runs/full-200
```

Both entry points skip work that is already recorded, so re-running either one
resumes rather than restarts. Subset options: `--task-id`, `--task-ids`,
`--level easy|medium|hard`, and `--force` to intentionally replace an existing
run or verdict.

## Outputs

```
runs/<campaign>/
  progress.jsonl          # one line per finished task
  run-summary.json        # agent completion counts
  score-summary.json      # rubric perfect rate + averages
  submission/<task_id>/
    result.json           # trajectory + final answer
    trajectory/*.png
    rubric-verdict.json   # per-rubric 0/1 scores
  runtime/<task_id>/      # home, transcript, stderr, steps.jsonl
```

`runs/` is gitignored. It holds browser profiles, screenshots, and model-session
artifacts, which can contain personal or authenticated data and must not be
committed.

## Metrics

- **Rubric average** — mean of the per-rubric 0/1 scores on a task, then the
  mean over tasks. Partial credit.
- **Perfect** — 1 only if every rubric on the task scores 1.
- **Trajectory efficiency** — derivable as mean(rubric_average / steps).

For scale, the paper reports these perfect rates for API computer-use agents
under a 100-step cap: Opus 4.6 **44.5%**, GPT-5.4 **33.5%**. Those figures use a
different agent stack and a different judge model from this harness and are
context, not a baseline this directory has matched.
