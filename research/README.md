# research/

Internal research and operator tools. **None of this is part of the BetterWright
package, its build, or its test suite**, and none of it is supported.

`scripts/` holds the build and release engineering that produces and verifies
`dist/`. This directory holds the other thing: one-off probes used to answer a
question about the runtime, and operator utilities that are useful when running
BetterWright yourself but are not part of shipping it. They were separated so
that the distinction is visible rather than implied by a filename.

## Status and support

- Not published to npm, not exercised by CI, not covered by tests.
- No compatibility guarantee. They read internal layouts and may break at any
  release without a changelog entry.
- They are kept because they document how a measurement was taken, not because
  they are expected to keep working.
- Several launch browsers, bind loopback ports, or write into your BetterWright
  home. Read a file before running it.

## Contents

| File | What it is |
| --- | --- |
| `stealth-report.ts` | Serves the local stealth probe fixture, runs it headless and headed, and prints a per-check score table. `--live` additionally visits public bot-score pages and scrapes their headline verdicts. |
| `cdpfree-probe.ts` | Control-plane comparison probe. Launches a browser binary directly, with an MV3 bridge extension over a loopback WebSocket as the only control channel — no Playwright, no DevTools protocol. Not the production runtime. |
| `warm-profile.ts` | Operator utility that ages a persistent BetterWright profile with bounded, human-paced browsing so history, cookies, and storage are not empty on first real use. |
| `assemble-mac-fonts.sh` | Build-host utility for the macOS-metric font set used by the Linux fork artifact. **See the licensing note below.** |

The three TypeScript files are compiled alongside the benchmark harnesses, so
run `npm run build:harness` first and invoke the emitted `.js`:

```bash
node research/stealth-report.js
```

## Licensing note: `assemble-mac-fonts.sh`

This script copies **Apple-licensed system fonts** out of the macOS host it is
run on. It fetches nothing and vendors nothing — the fonts are never part of
this repository or the npm package, and no font file is committed here.

The directory it writes is local output. It **must not be redistributed,
published, or committed**, and the license terms that govern it are Apple's, not
this project's. If you run it, you are responsible for confirming that your use
is permitted by the license attached to the fonts on your own machine.

## Legal and ethical scope

The stealth and profile tooling exists to measure and reduce the ways an
automated browser differs from a real one, which is the same work as making the
browser behave correctly. It is published for transparency about how the
project's claims were measured. It is not an invitation to defeat access
controls, misrepresent identity to a service, or violate a site's terms of use,
and the project does not support that use.
