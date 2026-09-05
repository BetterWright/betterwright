# Performance and recording audit

The original measurements below compare the pre-integration implementation with commit `72a2ba9eb` on Linux x64, using Node 24.13.1, BetterChromium 151.0.7922.108, and an AMD Ryzen 9 7950X3D host. It covers CLI startup, daemon and worker execution, snapshots, model observations, input, recording, live view, network policy, credentials, artifacts, packaging, and the test harness. Measurements describe these fixtures on this host, not every website or model task.

## Changes retained

| Path | Change | Evidence |
| --- | --- | --- |
| Worker execution | Skip the browser event pump when no snippet listeners remain | Quiet action p50: 4.60 → 2.62 ms. Existing event-delivery tests still exercise listeners. |
| Page summaries | Read the DOM title once and use `page.title()` as a fallback | Changed, empty, and closed-page cases are covered. The action measurement includes both worker changes. |
| Snapshot compression | Accumulate adjacent text and escape it once | A 4,000-paragraph synthetic case: 1,546.97 → 1.693 ms. All 23,225 full-output comparisons match the original. |
| Snapshot history | Save only output delivered to the caller and separate URL-mode histories | A refused large snapshot no longer causes a retry to say that nothing changed. A previous valid baseline survives a refusal. |
| Built-in agent | Preserve page action directories and keep observation JSON valid when results grow | Tests verify complete directories, error information, and credential-recovery metadata. Only an oversized result field is replaced. |
| Pi integration | Serialize model observations without indentation | Parsed content and image attachments are unchanged. This removes formatting bytes; it does not establish a task-success or tokenizer score improvement. |
| CLI | Load setup and doctor modules only in commands that use them | Subprocess tests reject accidental eager imports and preserve explicit model selection and default discovery. |
| Test commands | Preserve upstream direct TypeScript execution and type-check the full harness | Tests prove source execution, stale JavaScript exclusion, and explicit browser inclusion. |
| Recording | Add CLI, snippet, and MCP control of a persistent viewport recording | Real encoded frames, preserved page state, concurrent calls, session isolation, tab closure, and live-view coexistence are checked. |

The recording guide is [Record a browser session](recording.md). Start with `betterwright record start demo.mp4 --session demo`, then finish with `betterwright record stop --session demo`. Capture defaults to 60 FPS, without audio, and requires FFmpeg only while recording.

## Measurements

The existing [round-trip benchmark](../benchmarks/perf/run.ts) uses local fixtures and verifies that each heavy-page load actually requests all 51 resources. Full runs use 100 action samples, 10 page loads, and 30 samples for each iframe case.

| Fixture | Before p50 | After p50 | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Quiet action | 4.60 ms | 2.62 ms | 5.43 ms | 3.47 ms |
| Action with 10 cross-site iframes | 4.57 ms | 2.94 ms | 5.09 ms | 3.72 ms |
| Action with 24 cross-site iframes | 4.85 ms | 3.25 ms | 5.78 ms | 4.30 ms |
| Heavy local page | 601.58 ms | 600.57 ms | See raw results | See raw results |

These changes reduce the tested action overhead by about 43%. Heavy page loading is effectively unchanged. The raw runs are in [results.json](../benchmarks/perf/results.json), under `audit-node-before` and `audit-runtime-after` labels.

The [compression benchmark](../benchmarks/snapshot-compression/run.ts) compares complete strings against a separately built original implementation. It includes quoted and unquoted empties, whitespace, escaped strings, Unicode, nested trees, refs, URL options, and long adjacent text. Seven alternating timing samples per case produced these medians:

| Adjacent paragraphs | Before | After |
| --- | ---: | ---: |
| 1,000 | 63.87 ms | 0.458 ms |
| 2,000 | 288.63 ms | 0.863 ms |
| 4,000 | 1,546.97 ms | 1.693 ms |

This is a removal of repeated prefix processing. It preserves the existing compression format, including its unusual distinctions between raw empty text and quoted empty text. Ordinary small interactive snapshots remain approximately flat.

A recording fixture draws a binary counter each animation frame. Decoding the original WebM implementation verified 301 distinct, increasing rendered counters in 301 output frames over five seconds. Both system FFmpeg and the cached Playwright encoder passed. That is evidence of actual motion at roughly 60 frames per second, beyond container metadata. Static pages repeat their latest picture, and overloaded pages can deliver fewer distinct frames.

## CPU, memory, and startup

Two isolated alternating runs each executed 1,000 warm actions. Aggregate process-tree CPU time fell from 5.65 and 5.54 seconds to 4.34 and 4.05 seconds, about 25% less CPU for the same work. Wall time fell from 3.66 and 3.70 seconds to 2.01 and 1.90 seconds. Process-tree proportional memory varied from 779 to 879 MiB across the runs. That variation does not establish a whole-browser memory reduction.

The compression allocation test ran four 4,000-paragraph compressions per fresh process. Both before runs peaked at about 286 MiB RSS. The two after runs peaked at 68.4 and 67.8 MiB, about 76% less peak process memory. Output hashes match. This result applies to the paragraph-heavy compressor fixture, not Chromium's memory use.

CLI startup remains about 42–44 ms at the median for version and help commands. Deferring setup imports did not produce a reliable wall-time improvement in those samples. The import regression tests prove that those commands skip setup code; explicit model selection also skips default-model discovery. No CLI speedup is claimed.

The original WebM configuration in three repeated 640×360 recording cycles consumed 0.42–0.45 CPU cores across the harness, worker, browser, and encoder during five-second active windows. The corresponding parked windows consumed 0.09–0.12 cores. Videos grew on disk before stop. Every stopped window had zero FFmpeg processes, and process-tree proportional memory returned to the observed parked range. At the default 1280×720 output size, three further cycles consumed 0.82–0.85 cores. These are local fixture observations, not a fixed recording cost.

The reproducible probes are in [runtime-efficiency](../benchmarks/runtime-efficiency/). After `bun run build:harness`, run them serially against an original build and the candidate:

```sh
bun benchmarks/runtime-efficiency/run.ts /path/to/original/dist/src/index.js
bun benchmarks/runtime-efficiency/run.ts dist/src/index.js
bun benchmarks/runtime-efficiency/run.ts dist/src/index.js recording
bun benchmarks/runtime-efficiency/run.ts dist/src/index.js recording-hd
node --expose-gc benchmarks/runtime-efficiency/compression-memory.ts /path/to/original/dist/src/snapshot.js
node --expose-gc benchmarks/runtime-efficiency/compression-memory.ts dist/src/snapshot.js
bun benchmarks/runtime-efficiency/cli-startup.ts /path/to/original/dist/bin/betterwright.js
bun benchmarks/runtime-efficiency/cli-startup.ts dist/bin/betterwright.js
```

The process-tree probe reads Linux `/proc` CPU counters and proportional set size. CPU includes the probe process and its live descendants at each sample; processes that exit within a window can be undercounted. It excludes unrelated system processes. Shared memory is apportioned through PSS instead of claiming that summed RSS is unique physical memory. The compression probe reports the isolated process's peak RSS, including Node itself.

## Recording format comparison

The default is MP4/H.264. Two original 1280×720 JPEG sequences, each containing 300 frames captured from guarded Chromium, were encoded serially with the same input, frame rate, scaling, and thread limits. We compared VP8/WebM with x264’s `ultrafast` and `veryfast` presets at several CRF settings. The selected configuration is `veryfast`, CRF 28, zero-latency tuning, and a one-second keyframe interval.

The final comparison used two alternating runs per format and fixture. CPU is encoder process CPU time; memory is peak encoder RSS. These are encoder measurements, not whole-browser resource savings.

| Fixture | WebM CPU | MP4 CPU | WebM peak RSS | MP4 peak RSS | WebM bytes | MP4 bytes | WebM SSIM | MP4 SSIM |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Text and scrolling | 2.353 s | 1.405 s | 111.80 MiB | 98.45 MiB | 1,436,941 | 588,561 | 0.977697 | 0.982462 |
| Moving dashboard | 2.472 s | 2.082 s | 110.95 MiB | 97.25 MiB | 1,276,580 | 1,798,203 | 0.968400 | 0.978377 |

MP4 used 16–40% less CPU and about 12% less peak memory, with higher measured image similarity on both fixtures. Its output was 59% smaller for text and scrolling and 41% larger for motion. All 42 trial encodes retained 300 decodable frames at 60 FPS. This supports the default for CPU and memory priorities; it does not establish a universal file-size or quality advantage.

[FFmpeg’s codec documentation](https://ffmpeg.org/ffmpeg-codecs.html) describes the encoder settings. [Fragmented MP4](https://ffmpeg.org/ffmpeg-formats.html#Fragmentation) supports non-seekable output, so MP4 uses the existing byte-limited pipe and bounded capture queue. No production JavaScript dependency was added. Explicit WebM remains available for compatibility with FFmpeg builds that only include VP8.

The [codec comparison harness](../benchmarks/runtime-efficiency/codec-compare.ts) reuses the original captured sequences. Raw inputs, results, and the complete method are retained in `.audit/performance/codec-compare/` and `.audit/performance/codec-comparison.md`.

## Runtime decision

The audit started on the older Node checkout. Before release, upstream v2.2.0 had already migrated the CLI, worker, and tests to Bun 1.4. The v2.3.0 candidate preserves that migration and its explicit browser-driver override. The original Node measurements below are historical evidence, not measurements of the integrated Bun release. Release validation runs on Bun, with Node library compatibility checked separately.

The initial audit retained Node on that older checkout. Installed Bun 1.4.0 started the original CLI faster, but failed the real startup assertion that `playwright-core` imports are redirected to `patchright-core`. Its heavy-page benchmark also timed out. The current [Bun Node compatibility documentation](https://bun.com/docs/runtime/nodejs-apis) describes `module.register` as a no-op. BetterWright relies on the registration behavior documented by [Node](https://nodejs.org/api/module.html#moduleregisterspecifier-parenturl-options).

Basic VM isolation, code-generation restrictions, and synchronous timeout probes passed on both runtimes. The rejection is based on the loader and browser evidence, not an outdated claim that Bun lacks those VM options. A Bun CLI with a Node worker remains a separate deployment design with two runtimes to manage. Deferring unused imports is a smaller alternative that retains the existing executable contract.

A Rust rewrite has no measured justification here. The browser still renders pages, Playwright still owns action semantics, and existing snippets still require a JavaScript execution environment. [Playwright's supported languages](https://playwright.dev/docs/languages) do not include Rust. A small native socket client could reduce shell startup, but would add binary distribution and duplicate argument and daemon-protocol handling. Neither a whole rewrite nor a second runtime follows from the measured bottlenecks.

## Recording design

Three viable approaches were examined:

1. Playwright video recording. This integrates with browser contexts, but its internal recorder uses a fixed 25 FPS rate and offers no public 60 FPS option. Recreating the context would also disturb the current page's JavaScript and form state.
2. Native `Page.startScreenRecording`. The method appears in the [current CDP specification](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreenRecording), but the pinned BetterChromium build returns “method not found.”
3. CDP screencast frames streamed to FFmpeg. This works with the installed browser, preserves the current tab, and allows explicit timing and memory limits. This is the implemented approach.

[Vercel Agent Browser's recording interface](https://agent-browser.dev/recording) informed the start, stop, status, and restart controls. BetterWright keeps the actual page and elapsed time. It does not compress long idle gaps or require a separate recording context.

The encoder is loaded only on demand. It receives JPEGs through a pipe and writes a private MP4 artifact by default (or WebM with an explicit `.webm` filename) through a byte-limited stream. A four-frame timestamp queue retains at most 16 MiB, plus the last emitted frame and stream buffers. This is a capture-queue bound, not a total-browser RSS limit. Two-frame lookahead absorbs short delivery jitter. Slow encoding drops excess capture frames instead of retaining the history in memory.

FFmpeg initially buffered input during probing. Explicit JPEG probing limits make encoded output grow during capture. The [FFmpeg format documentation](https://ffmpeg.org/ffmpeg-formats.html) explains `probesize` and `analyzeduration`; Playwright's existing recorder uses the same small-probe approach. Decoder and filter threads are set to one and encoding threads to two. Observed total encoder process threads fell from 10 to 8; that count also includes FFmpeg's other work.

Starting, active, and finished recordings have one session owner. Ownership is registered before asynchronous startup, so an immediate stop waits for the start. The tab stays awake between agent calls. Normal tab/session closure finalizes the encoder; startup failure, a crash, byte-limit failure, or an encoder failure removes the partial file. The default duration limit finishes a valid video. Completed status is idempotent.

## Further opportunities and why they remain separate

| Area | Finding | Next comparison or constraint |
| --- | --- | --- |
| Automatic discovery | Network discovery runs after the snippet timeout and can wait on remote responses | Compare an explicit end-to-end deadline with background discovery. Preserve immediate action advertisement and cancellation. |
| Artifact housekeeping | Directory scans and file stats repeat during normal runs | Measure directories with many artifacts before introducing a dirty flag or accounting ledger. External file changes and reservations must remain correct. |
| UI action directories | Duplicate-control context is built for controls that may not need it | Find duplicate candidates first, then measure frame-heavy pages. Preserve target disambiguation. |
| UI batching | Settling and directory stability checks can repeat | Compare explicit expected-state verification with existing polling on delayed renders, redirects, and background requests. Auto-wait alone does not establish result completion. |
| HTTP caching | Playwright routing disables the browser HTTP cache | Removing routing loses full-URL, method, custom-policy, and search-navigation enforcement. The SOCKS guard cannot replace those checks. |
| Human input | Pointer paths and typing deliberately take time | Exact locators already provide a faster option. Changing defaults needs task-success and challenge-rate evidence. |
| Snapshot capture | Password scanning and accessibility capture cost browser work | Keep password redaction. A smaller output or faster scan cannot justify exposing newly filled secrets. |
| Screenshot fallback | Pixel geometry can be read more than once | Pass validated geometry through the fallback if profiling shows material cost. Preserve clipping and pixel limits. |
| Model context | The transcript can grow during long tasks | Compaction needs evaluations that preserve constraints, recovery state, and task success. No universal improvement was established. |
| Live view | Existing capture and viewer traffic add CPU while watched | The new recorder was tested alongside live view. A shared capture service would need independent dimensions, timing, and lifecycle contracts before replacing either path. |
| Recording overload | Frames are acknowledged even when the encoder is behind | Retained memory is bounded, but browser capture still consumes CPU. ACK-based throttling needs measurements with slow encoders and concurrent live view. |
| Native capture | Newer Chromium may provide native screen recording | Re-evaluate after the pinned browser exposes the method and its timing, memory, quota, and cleanup behavior can be tested. |

The [Playwright routing documentation](https://playwright.dev/docs/api/class-browsercontext#browser-context-route) confirms the HTTP-cache tradeoff. Existing caching of explicitly cacheable policy decisions, parallel address validation, download-gate deduplication, background tab parking, and bounded snapshot diffing remain in place.

## Verification and limits

The integrated v2.3.0 candidate passed the complete Bun 1.4 suite as a nonroot user with Chromium’s sandbox enabled: 1,104 tests passed, three optional live-site tests and one BSD-only test skipped, and no failures. The run required both the managed browser and recording encoders. An independent reviewer passed 77 focused tests and 13 browser tests. A separate Node 22.22.1 library check completed a browser call and MP4 recording. Earlier Node audit results below describe the pre-integration implementation.

After the MP4 change, `BETTERWRIGHT_COVERAGE=1 npm run release:check` passed with 1,009 tests passed and five optional external live-site tests skipped. Lint, type checks, build validation, public declaration consumers, and package installation smoke testing passed. All 91 focused tests and all nine recording browser tests passed, including real MCP recordings in both formats. Recorder coverage is 97.52% of lines and 87.83% of branches in the release run.

Before the format follow-up, the complete `BETTERWRIGHT_REQUIRE_BROWSER=1 BETTERWRIGHT_REQUIRE_RECORDING=1 npm test` run passed with 1,089 tests passed, five skipped, and no failures, including all 82 managed-browser tests. The follow-up reran the changed browser recording paths alongside the full release checks.

The installed CLI produced a 1280×720 H.264 MP4 with 101 decodable frames at 60 FPS over 1.683 seconds. The frame was inspected, and the page’s form value remained intact after stop. The sample is `.audit/performance/cli-recording-proof.mp4`; current verification logs have the `mp4-` prefix.

Additional validation includes 23,225 full-output compression comparisons, actual installed-CLI recording, public declaration consumer tests, streaming and frame-counter probes, an inspected video frame, and package installation smoke tests. The packaged artifact installs and runs successfully. No model task-success benchmark was rerun. Raw audit logs and compatibility probes are retained locally in `.audit/performance/`.

No production JavaScript dependency or browser pin changes. Network routing, the SOCKS guard, credential fill boundaries, redaction, screenshot limits, download approvals, and public snippet capabilities remain intact. This audit does not establish better task success on every website, a lower total memory footprint for every workload, or an across-the-board model-token reduction.
