# Runtime performance

BetterWright includes three accepted runtime changes from the performance audit. The measurements below cover their specific workloads. They do not establish that every browser task is faster.

The retained measurements ran on 2026-09-05 with Linux x64, an AMD Ryzen 9 7950X3D, Bun 1.4.0, and the same pinned BetterChromium backend for baseline and candidate runs.

## Faster action-directory scans

Action-directory scans now reuse context text for controls that share the same root element. The cache exists only during one frame evaluation. It cannot carry page text across scans, frames, or navigation, and the returned directory is unchanged.

The large fixtures use 36 controls. Each fixture runs five warmup groups and twenty measured groups of five scans. On the large shared-form case, median scan wall time fell from 52.6 ms to 5.3 ms in forward order and from 54.1 ms to 4.8 ms in reverse order. That is a 90% to 91% reduction. Normal forms moved from 1.4 ms to 1.2 ms, while forms with distinct context roots moved from 2.4 ms to 2.6 ms. Those cases are effectively unchanged at this scale.

Run the committed [directory context benchmark](../benchmarks/runtime-efficiency/README.md) against two built checkouts to reproduce this comparison. Per-run measurements and scan samples are in the [measurement data](../benchmarks/runtime-efficiency/measurements-2026-09-05.json). The benchmark measures scan wall time, not browser CPU or whole-task performance.

## Lower CPU on GPU-less Linux

When Linux has no usable render device, BetterWright now scopes software rendering to WebGL with `--use-angle=swiftshader-webgl`. The native hardware path is unchanged. Chromium documents this mode as its [SwiftShader WebGL fallback](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md).

Across 12 retained runs, whole measured-process CPU fell from a 13.435-second median to 3.035 seconds over browser startup, idle periods, DOM reads, a 640 by 360 rendering probe, and a 60 FPS recording probe. That is 77.4% lower for this measured lifecycle. GPU-process CPU fell from 11.220 seconds to 0.635 seconds.

The capability checks remained intact. WebGL 1 and WebGL 2 were available in every run, and both pixel-read probes returned the expected colors. The first 60 frames decoded from each of the 12 MP4 files were all unique, with changes between every adjacent frame.

Memory was roughly flat. Recording-phase aggregate RSS was 1391.9 MiB before and 1406.0 MiB after, about 1% higher. This change is a CPU improvement, not a memory improvement.

## Frame references in batched controls

`controls.batch` now accepts the frame-prefixed references that interactive snapshots already return, including nested-frame references and their `aria-ref=` form. The change keeps the existing length, target, password, write, and redaction checks.

The browser regression covers controls in the main document, a child frame, and a nested frame. A targeted editing task ran three times per version with GPT-6-Astra at low reasoning. Both groups received identical instructions to use fresh frame references, with ordinary visible-UI recovery available. Each baseline trial needed one recovery call after reference validation failed; the candidate needed none.

Median actual token use fell from 12,000 to 9,511, a 20.7% reduction. Median task duration fell from 36.638 to 26.259 seconds, a 28.3% reduction. All six trials saved the correct edit exactly once and produced complete, independently inspected proof images. These results measure one reference-recovery workflow; they do not establish token savings for other tasks.

The final release gate at `cae465382d5c1499ed352e2d82c9b23c2abef70b` passed 1,108 unique tests with four intentional skips.

## Model behavior

The default model prompts did not change. Several observation-guidance candidates improved aggregate results but increased tokens for some task families, and one later candidate omitted required final operations and proof images. BetterWright rejected those candidates. This audit makes no aggregate token claim.
