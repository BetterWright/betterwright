# Runtime performance

BetterWright freezes and garbage-collects idle pages between calls, reuses shared action-directory context, and limits the GPU-less Linux software renderer to WebGL. The measurements below cover these specific workloads. They do not establish that every browser task is faster.

Unless a section gives its own setup, the retained measurements ran on 2026-09-05 with Linux x64, an AMD Ryzen 9 7950X3D, Bun 1.4.0, and the same pinned BetterChromium backend for baseline and candidate runs.

## Parking that actually idles the browser

Page parking had stopped working on BetterChromium 153. Playwright enables
focus emulation on every page, and that emulation holds a visible capture on
the tab. Chromium never hides a captured tab and ignores a freeze request for a
visible one, so a "parked" page kept running `requestAnimationFrame` at 60 FPS.
Parking now releases focus emulation on Playwright's own session just before
the freeze and restores it before the next call. A browser regression test
checks that no animation frame runs while a page is parked, and that the page
wakes focused and visible with its state intact.

While a page is parked, one full garbage collection runs if its JavaScript and
Blink heaps grew by at least 4 MiB since the previous one. A frozen page runs no
idle tasks, so without this V8 and Blink keep memory the page has already freed.
The managed browser also no longer keeps Chromium 153's two omnibox popup WebUI
renderers resident. No page can observe them.

These measurements ran on 2026-09-24 on Linux x64 with 4 vCPUs and no GPU, so
WebGL used SwiftShader. They used Bun 1.4.0 and BetterChromium 153.0.8010.36
(r2), running as root without the Chromium sandbox. Baseline and candidate runs
alternated. The fixture is local: a 400-row table with 40 images, a 20,000-object
script, a CSS spinner, a canvas animated with `requestAnimationFrame`, and two
cross-site iframes with their own timers and animation. Figures cover only
BetterChromium processes. PSS is summed from `/proc/<pid>/smaps_rollup`, and CPU
is user plus system time, including children the browser reaped. Values are
medians of three runs per build.

| Measurement | Before | After | Change |
| --- | ---: | ---: | ---: |
| Parked idle CPU, 5 s | 0.69 s | 0.01 s | −99% |
| Idle PSS after browsing | 670.9 MiB | 533.3 MiB | −21% |
| Idle anonymous memory after browsing | 397 MiB | 266 MiB | −33% |
| PSS after startup | 440.7 MiB | 394.4 MiB | −11% |
| Agent loop CPU: 8 steps, each one load then 4 s idle | 12.13 s | 11.09 s | −9% |
| Agent loop average PSS | 609.4 MiB | 528.2 MiB | −13% |
| Agent loop peak PSS | 694.9 MiB | 565.5 MiB | −19% |
| Active CPU: 12 loads, screenshots, 3 extra tabs | 10.48 s | 10.26 s | noise |
| CPU during a 5 s wait inside a call | 1.19 s | 1.29 s | noise |

The full garbage collection is a CPU-for-memory trade. On this fixture, every
load leaves about 100 MiB of reclaimable V8 and Blink heap, so each park
collects it. In two further alternating agent-loop runs with the collection
disabled, CPU was 9.2 s (−24% from the baseline). However, average PSS was about
577 MiB and peak PSS about 655 MiB, compared with about 530 MiB and 565 to
585 MiB with the collection enabled. A page that allocates little between calls
does not pay for it.

Work inside a call is essentially unchanged. The largest remaining cost is
structural: Playwright request routing, which enforces the network policy on
every request, disables the HTTP cache. In a separate Playwright-only
comparison, the same 12 loads took 2.9 CPU seconds without routing and 5.8 with
it. See the [performance audit](performance-audit.md) for why routing stays.

Memory has a floor that no launch option moves. In the idle state after
browsing, about 275 MiB of PSS is the BetterChromium executable's own code
pages. These pages are clean and file-backed, and the kernel can reclaim them,
but they are counted in PSS. The rest was measured as follows:

- `--single-process` reached only 463 MiB, and gives up process isolation.
- Moving the GPU and network services into the browser process and disabling
  the spare renderer saved about 16 MiB, at the cost of fault isolation.
- `--js-flags=--optimize-for-size` saved little beyond parked collection and
  increased renderer CPU during loads by about 15%.
- A simulated critical memory-pressure notification freed nothing measurable.

None of these ships. A smaller code footprint would require build changes, such
as an official build with ThinLTO and profile-guided optimization, benchmarked
against the current reproducible build as
[the build notes](../scripts/chromium/README.md) require.

## Faster action-directory scans

Action-directory scans now reuse context text for controls that share the same root element. The cache exists only during one frame evaluation. It cannot carry page text across scans, frames, or navigation, and the returned directory is unchanged.

The large fixtures use 36 controls. Each fixture runs five warmup groups and twenty measured groups of five scans. On the large shared-form case, median scan wall time fell from 52.6 ms to 5.3 ms in forward order and from 54.1 ms to 4.8 ms in reverse order. That is a 90% to 91% reduction. Normal forms moved from 1.4 ms to 1.2 ms, while forms with distinct context roots moved from 2.4 ms to 2.6 ms. Those cases are effectively unchanged at this scale.

Run the committed [directory context benchmark](../benchmarks/runtime-efficiency/README.md) against two built checkouts to reproduce this comparison. Per-run measurements and scan samples are in the [measurement data](../benchmarks/runtime-efficiency/measurements-2026-09-05.json). The benchmark measures scan wall time, not browser CPU or whole-task performance.

## Lower CPU on GPU-less Linux

When Linux has no usable render device, BetterWright now scopes software rendering to WebGL with `--use-angle=swiftshader-webgl`. The native hardware path is unchanged. Chromium documents this mode as its [SwiftShader WebGL fallback](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md).

Across 12 retained runs, whole measured-process CPU fell from a 13.435-second median to 3.035 seconds over browser startup, idle periods, DOM reads, a 640 by 360 rendering probe, and a 60 FPS recording probe. That is 77.4% lower for this measured lifecycle. GPU-process CPU fell from 11.220 seconds to 0.635 seconds.

The capability checks remained intact. WebGL 1 and WebGL 2 were available in every run, and both pixel-read probes returned the expected colors. The first 60 frames decoded from each of the 12 MP4 files were all unique, with changes between every adjacent frame.

Memory was roughly flat. Recording-phase aggregate RSS was 1391.9 MiB before and 1406.0 MiB after, about 1% higher. The existing renderer-process limit and recording resource bounds remain in place; this comparison measures no additional RAM savings.

The fallback requires the pinned BetterChromium release, which includes the Linux software-GPU renderer identity patch. CI keys its browser cache by release tag and asset checksum so an older revision of the same Chromium version cannot supply the test binary. For an older local managed installation, run `betterwright setup --force` to install the pinned artifact.

## Recording

The [recording API](recording.md), CLI, and MCP tool remain available with MP4 and WebM output. The browser regression checks that recording keeps the same page, state, and animation alive between calls. Canvas2D, WebGL 1/2 shader rendering, and screenshot pixels are checked alongside the runtime changes.

## Frame references in batched controls

`controls.batch` now accepts the frame-prefixed references that interactive snapshots already return, including nested-frame references and their `aria-ref=` form. The change keeps the existing length, target, password, write, and redaction checks.

The browser regression covers controls in the main document, a child frame, and a nested frame, with both plain references and the `aria-ref=` prefix. Malformed references remain rejected.
