# BetterWright Online-Mind2Web 300-task report

## Result

BetterWright achieved **278/300 (92.7%)** on the pinned 300-task
Online-Mind2Web snapshot.

| Difficulty | Passed | Total | Rate |
| --- | ---: | ---: | ---: |
| Easy | 80 | 81 | 98.8% |
| Medium | 134 | 143 | 93.7% |
| Hard | 64 | 76 | 84.2% |
| **Overall** | **278** | **300** | **92.7%** |

This is an iterative best-validated campaign, not a one-shot run. It combines
retained validated outcomes across targeted reruns. A later 14-task rerun was
stopped before judging and is excluded.

This result is from BetterWright's **local strict multimodal judge**. It is not
an official Online-Mind2Web human evaluation or leaderboard score.

## Configuration

- Agent and judge: `openai-codex/gpt-5.6-sol`
- Reasoning: `high`
- Maximum concurrency: 32
- Browser-step budget: 100 per task
- Dataset snapshot: 2025-11-23 public mirror
- Dataset SHA-256:
  `9e12bc981aa8bac167987f2e762669f3efa16a3ded2ea75609cfcba888aa0422`
- Manifest SHA-256:
  `dfd0db63bc59e336949718dc004ed4a97e31a93fb9ee86ce56e807f4172aa252`

The benchmark changes represented by this score include the native Pi Coding
Agent integration, persistent browser/evidence tooling, compact exact-task
guidance, conservative cookie and promotional-overlay dismissal, stricter proof
validation, and bounded continuation for unresolved checklist items.

## Public results

[`results.json`](results.json) contains the aggregate score, difficulty
breakdown, configuration, hashes, and failed task IDs. Every task in
[`full-300.json`](full-300.json) not listed as failed is a validated pass.

The public files intentionally exclude task instructions, agent answers, judge
reasoning, screenshots, trajectories, browser profiles, cookies, storage,
session logs, and network captures. Those raw runtime artifacts can contain
personal or authenticated data and remain under the gitignored `runs/`
directory.

## Reproduction notes

The harness and command examples are documented in [`README.md`](README.md).
Online-Mind2Web changes live tasks over time, so comparisons must use the same
snapshot and manifest hashes. The benchmark's maintainers also note that full
runs may have privacy, legal, and cost constraints.

Sources: [official Online-Mind2Web repository](https://github.com/OSU-NLP-Group/Online-Mind2Web),
[public benchmark dataset](https://huggingface.co/datasets/osunlp/Online-Mind2Web).
