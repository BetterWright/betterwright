# Odysseys benchmark (BetterWright harness)

Long-horizon multi-site web agent benchmark from:

> Jang, Koh, Fried, Salakhutdinov — *Odysseys: Benchmarking Web Agents on Realistic Long Horizon Tasks* (arXiv:2604.24964)

This harness runs all **200** official tasks through BetterWright’s own `exec` agent (`src/agent.ts`, compiled to `dist/src/agent.js`), records screenshot trajectories, and scores them with the paper’s **per-rubric** grading style (averaged + perfect).

## Config used for the campaign

| Setting | Value |
| --- | --- |
| Model | `gpt-5.6-sol` (Codex / ChatGPT backend) |
| Reasoning effort | `high` |
| Tasks | 200 (`odysseys.json`) |
| Agent wall-clock budget | 90 minutes / task |
| Process timeout | 100 minutes / task |
| Default concurrency | **8** (parallel tasks; keep ≤8 on a dedi) |

This is a **local BetterWright evaluation**, not an official Odysseys leaderboard submission. Rubric judging is automated LLM-as-judge and is not human adjudication.

Do **not** launch the full 200 until you are ready. Prefer a smaller pilot first.

## Run

```bash
# Full 200-task agent campaign — 8 in parallel (do not raise without headroom)
node benchmarks/odysseys/exec-runner.mjs run \
  --tasks benchmarks/odysseys/odysseys.json \
  --manifest benchmarks/odysseys/full-200.json \
  --output benchmarks/odysseys/runs/full-200-gpt56sol-high \
  --model gpt-5.6-sol \
  --effort high \
  --concurrency 8 \
  --agent-budget-minutes 90 \
  --timeout-minutes 100

# Rubric judge — multimodal Pi + screenshots (gpt-5.6-luna)
node benchmarks/odysseys/judge.mjs \
  --tasks benchmarks/odysseys/odysseys.json \
  --manifest benchmarks/odysseys/full-200.json \
  --output benchmarks/odysseys/runs/full-200-gpt56sol-high \
  --model openai-codex/gpt-5.6-luna \
  --thinking high \
  --concurrency 2
```

Subset options: `--task-id`, `--task-ids`, `--level easy|medium|hard`, `--force`.

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

## Metrics

- **Rubric average** — mean of per-rubric 0/1 scores across a task (then mean over tasks).
- **Perfect** — 1 only if every rubric for the task is 1.
- **Trajectory efficiency** — can be derived as mean(rubric_average / steps).

Official paper ceiling (API CUA, 100-step cap): Opus 4.6 **44.5%** perfect, GPT-5.4 **33.5%** perfect.
