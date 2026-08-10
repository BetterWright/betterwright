# BetterWright 1.7.1 efficiency measurements

These local, deterministic probes cover the 1.7.1 paths without a network,
browser, or model provider. Results below compare commit `273e51d` (1.7.0) to
the 1.7.1 working tree on an Apple M4 Pro with Node v24.16.0. Each figure is the
median of five fresh-process samples.

## Results

| Workload | 1.7.0 | 1.7.1 | Change |
| --- | ---: | ---: | ---: |
| 2,000-turn built-in agent loop | 906.3 ms / 81.1 MiB RSS | 17.2 ms / 77.3 MiB RSS | **52.8× faster / 4.8% lower RSS** |
| Resulting transcript | 750,009 chars | 476,009 chars | **36.5% smaller** |
| One successful built-in observation (cl100k) | 44 tokens / 174 chars | 15 tokens / 53 chars | **65.9% fewer tokens** |
| One successful MCP observation (cl100k) | 43 tokens / 168 chars | 15 tokens / 53 chars | **65.1% fewer tokens** |
| 3,000-line wholesale-replacement diff | 18.8 ms / 66.0 MiB RSS | 1.3 ms / 45.9 MiB RSS | **14.6× faster / 30.4% lower RSS** |
| 3,000-line diff sharing one displaced line | 15.7 ms / 66.3 MiB RSS | 33.9 ms / 51.1 MiB RSS | **22.9% lower RSS** |

The agent workload uses a no-I/O model and browser stub so it isolates harness
overhead: each turn appends one ordinary browser call and its successful
observation. The old loop serialized the complete, growing transcript before
every turn; 1.7.1 accounts for each appended message once. Real model and
browser latency will reduce the wall-clock percentage, but not the eliminated
CPU work or allocations.

Observation token counts use `js-tiktoken@1.0.21`, `cl100k_base`, on the exact
JSON strings shown by the harness. Provider tokenizers differ, so the release
notes quote both tokens and exact serialized characters.

The diff probes exercise the public 3,000-line cap. A wholesale replacement
now takes a linear no-common-line path. When an LCS must be reconstructed,
1.7.1 retains sparse checkpoints plus one reusable 64-row block (under 700 KiB
of DP storage at the cap) instead of an 18,012,002-byte table. That adversarial
one-common-line case is 2.2× slower in exchange for bounded memory, as the final row reports;
typical snapshot diffs are much smaller after common-prefix/suffix trimming.

## Reproduce

Build a clean 1.7.0 checkout and the candidate, then point the harness at both:

```bash
baseline_dir=$(mktemp -d)
git worktree add --detach "$baseline_dir" 273e51d
(cd "$baseline_dir" && npm ci && npm run build)
npm run build:harness
node benchmarks/efficiency/run.js --baseline "$baseline_dir"
git worktree remove "$baseline_dir"
```

The harness prints every raw sample plus its medians. `--repeats` and `--turns`
can change the defaults; `--candidate` can compare a second external checkout.
