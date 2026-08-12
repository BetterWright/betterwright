# Browser process candidate-vs-baseline benchmark

This harness compares two **already-built** BetterWright checkouts at browser
level. It measures cold and warm startup, repeated local navigation, summed
process-tree memory, idle and active CPU, renderer count, and process-tree
memory growth over a long session. It never navigates to an external site: a
loopback-only HTTP fixture is created by the controller, while BetterWright's
normal `NetworkPolicy` and SOCKS guard remain enabled.

## Run

```bash
npm run build:tools
npx tsc -p tsconfig.harness.json
node benchmarks/browser-process/run.js \
  --baseline /path/to/built/baseline \
  --candidate /path/to/built/candidate \
  --output /tmp/browser-process.json
```

Both paths must contain `package.json` and `dist/src/index.js`; the harness does
not build either checkout. Candidate defaults to the current repository.

Useful flags:

- `--repeats N` (default 7, minimum 3): fresh-process/profile samples. Target
  order alternates each repeat to reduce thermal and background-load bias.
- `--long-turns N` (default 100): local navigations used for growth measurement.
- `--idle-ms N` / `--active-ms N` (default 2000): CPU sampling windows.
- `--quick`: 3 repeats, 20 long-session turns, and 750 ms CPU windows. This is a
  smoke test, not suitable for reported performance claims.
- `--output FILE`: writes the same JSON printed to stdout. No repository result
  file is modified by default.

Run on an otherwise idle machine, with both targets using the same browser
installation and environment variables. Compare medians, retain the raw samples,
and repeat the complete run if a claimed change is near the run-to-run spread.
Seven repeats are enough for directional regression checks, not publication-
grade confidence intervals.

## Metric definitions and support

- **Cold startup:** first construction plus first local navigation and debug
  screenshot with a new temporary BetterWright home. The screenshot deliberately
  launches BetterChromium's on-demand pixel renderer.
- **Warm startup:** the same Chromium-backed operation after closing and
  reconstructing against the existing home/profile.
- **Navigation:** five measured local page loads plus screenshots after two
  discarded warmups, so this remains a browser-level Chromium measurement.
- **RSS:** `ps` RSS summed over the probe process and all descendants. This
  intentionally captures BetterWright, its worker, and the Chromium process
  tree rather than one selected browser PID.
- **PSS:** summed `/proc/<pid>/smaps_rollup` PSS on Linux. It is explicitly
  `null` when any process cannot be read. PSS is unsupported on macOS and the
  JSON records the reason.
- **CPU:** change in cumulative process-tree CPU time over a fixed window;
  `100%` means one fully used logical core. Idle is measured after page parking;
  active repeatedly executes a deterministic local operation.
- **Renderer count:** peak descendants whose command line contains
  `--type=renderer`, sampled while screenshots are active. The renderer is
  on-demand and may be absent at idle checkpoints.
- **Long-session growth:** end minus start process-tree RSS/PSS after the
  configured number of local navigation-plus-screenshot turns. A positive
  single-run delta is not a
  leak diagnosis; inspect all raw samples and medians.

The JSON includes OS/CPU/Node metadata, exact target commits and dirty state,
package versions, built artifact mtimes, configuration, metric support, summary
statistics, and every raw sample. RSS double-counts shared pages by definition;
prefer Linux PSS for cross-process memory claims. macOS RSS and Linux PSS are
not directly comparable, and CPU results should only be compared on the same
machine under similar power/thermal conditions.
