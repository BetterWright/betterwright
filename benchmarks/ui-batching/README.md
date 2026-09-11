# UI batching measurements

Measured merged main (`c0408cf39b1fec5ce16201e2a71d7cedd95189ee`) against `8596d5e43a0b04ec451c0b5df32899a4f7ee15ab` with the same local Chromium binary. Each runtime fixture runs once for warmup and ten measured repetitions per build and execution mode, alternating build and mode order. All **160 measured cases passed** independent final-state assertions.

| Fixture | Main batch median | Updated batch median | Reduction | Individual calls → batch calls |
|---|---:|---:|---:|---:|
| form | 532.7 ms | 106.6 ms | 80.0% | 6 → 2 |
| deferred | 1324.5 ms | 224.3 ms | 83.1% | 4 → 2 |
| wizard | 674.0 ms | 331.6 ms | 50.8% | 5 → 2 |
| frame | 519.5 ms | 120.4 ms | 76.8% | 5 → 2 |

The fixtures cover text/select/checkbox controls, a delayed result while an unrelated request remains pending, a page that reveals a later button, and an iframe form. Every measured batch ends with an expected result read. Observation mode is separately covered by a Chromium regression with a delayed, server-generated receipt, and is available to the model trials below.

The interval includes navigation, directory discovery, and actions through the persistent worker. Action plans use fixed semantic targets; separate browser regressions copy targets directly from discovery, including filtered duplicates and distant controls. Startup, warmups, and independent final-state assertions are excluded. There are no model requests, simulated model delays, or dollar estimates in this runtime benchmark. Individual-call mode measures the same actions without an LLM; it does not estimate agent latency.

## Model trials

Four supplied workloads—filtered reservation, an 80-field preference form, a delayed report, and a public-page read—run three times per build, alternating build order. These are 12 trials per build, **not 12 distinct tasks**. Both builds receive their own shipped skill and actual MCP schemas through the same host adapter. No task-specific product instructions were added. Fresh browser homes are used; browser startup is excluded. The cap is 12 model turns/180 seconds, with failed trials retained in all averages.

Strict success requires the fixture oracle (including exactly one submission/save), a completed nonempty model response, and exact raw JSON when requested. Correct data wrapped in prose or code fences is counted separately. Public-page data is checked against an independent browser read. Actual model-reported input, cached input, and output tokens are used; character counts are not token estimates.

| Model | Build | Strict success | Mean | Median | Input tokens | Uncached input | Output tokens | Calls / errors | API cost |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| DeepSeek V4.1 Flash | Main | 6/12 | 21.16 s | 14.52 s | 599,537 | 50,545 | 26,665 | 76 / 9 | $0.025228 |
| DeepSeek V4.1 Flash | Updated | 12/12 | 16.89 s | 13.60 s | 403,484 | 41,116 | 15,856 | 56 / 10 | $0.016768 |

DeepSeek uses its direct API (`deepseek-flash`, V4.1 Flash, high thinking; the provider maps medium to high). This revision is evaluated only with direct DeepSeek. The preceding native Sol repeat was stopped during its first trial; no further Sol evaluations ran. Earlier completed trials remain in the development evidence. DeepSeek cost is calculated from reported cache-hit/miss/output usage and the applicable rates at request time from [official pricing](https://api-docs.deepseek.com/quick_start/pricing/), rather than a character estimate. Model/provider load and cache warmth can affect both latency and cost.

**The update improves mean time and aggregate cost without lowering strict completion in this limited trial set.** Strict completion is 6/12 for main and 12/12 for the update. Required task state/data is correct in 9/12 and 12/12 respectively. Unfinished responses and incorrect requested formats still fail strict scoring. Aggregate cost per strict success is $0.004205 versus $0.001397.

The preference fixture resets displayed fields on reload, so reloading to verify persistence can induce duplicate saves and fail its exactly-once oracle. This is a fixture limitation as well as a recovery challenge. There is one real public-page task; these measurements do not establish performance across all sites or models. Earlier development rounds are included in `development-results.json` rather than selecting the most favorable round. Native round one's compiled-directory fingerprint changed, so its timings are excluded from the primary comparison.

## Reproduce and evidence

Use Bun 1.4.0 and two checkouts with committed source/build inputs and pinned dependencies:

```sh
BETTERWRIGHT_CHROMIUM_PATH=/absolute/path/to/BetterChromium \
  bun benchmarks/ui-batching/run.ts \
  --baseline /absolute/path/to/baseline \
  --candidate . --output /absolute/path/to/results.json
```

The runner rebuilds both checkouts; do not run other tests against their `dist` directories concurrently. It checks source trees, runtime diffs, installed dependency contents (including linked packages), compiled artifacts, browser binary, and harness files before/after. `results.json` contains every runtime sample. `model-results.json` contains every model trial, raw request usage for the direct API, task prompts, source/build/harness fingerprints, and hashes of retained local event traces. Model trials used a local host adapter and the supplied fixture package; the runtime command above does not reproduce model trials. Later report-only commits do not change measured source/build inputs.
