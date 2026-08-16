# Working on BetterWright

Guidance for agents (and humans) changing this repo. CONTRIBUTING.md covers
the release process; this file lists the invariants that are easy to break
because they are enforced by code, not convention.

## Commands

- `npm run lint` — biome lint rules. The formatter is off deliberately (see
  biome.jsonc); match the hand style recorded in .editorconfig.
- `npm run typecheck` — TypeScript 7 checks, without emitting, the runtime and
  CLI (`tsconfig.json`), the build tooling (`tsconfig.tools.json`), and the
  shipped examples (`tsconfig.examples.json`). The test and benchmark harness
  (`tsconfig.harness.json`) is checked by `npm run test:unit`, because it
  imports `dist/` and so cannot be checked before a build.
- **Development sources are TypeScript and compile in place.** There are four
  projects, split by what they can depend on:
  - `tsconfig.json` — `src/` and `bin/` → `dist/`.
  - `tsconfig.tools.json` (`npm run build:tools`, runs automatically as
    `prebuild`) — the build and release scripts. These must never import
    `dist/`, because they are what produces it.
  - `tsconfig.harness.json` (`npm run build:harness`) — tests, benchmarks, and
    probe scripts, all of which drive the built runtime. Runs after `build`.
  - `tsconfig.examples.json` — the shipped examples, type-checked against
    `types/`.

  Each emits its `.js` next to its `.ts` (gitignored) because these files
  resolve the repo root, `dist/`, and their fixtures by relative path. Run a
  script or benchmark directly only after `npm run build:tools` or
  `npm run build:harness`.
- `npm run check:build` — rebuilds `dist/` and verifies every source file,
  package export, relative import, and executable entrypoint.
- `npm run test:unit` — every `tests/node/*.test.ts` except
  `browser.test.ts`, which needs the managed browser and runs via `npm test`
  in CI. Set `BETTERWRIGHT_COVERAGE=1` for a report-only coverage table.
- `npm run test:types` — compiles against the hand-written declarations in
  `types/`. Runtime JavaScript is generated in `dist/`, but public declarations
  are not generated: any public API change must update the matching `.d.ts` in
  the same commit.
- `npm run release:check` — all of the above plus version and package checks.

## Invariants

- **Every browser connection stays on the guard proxy.** Chromium is pointed
  at the worker's SOCKS guard (`src/guard-proxy.ts`) on the command line so
  even traffic that bypasses Playwright routing is policy-checked. The network
  floor is the security boundary (SECURITY.md) — never add a launch path or
  transport that skips it.
- **Secrets never enter the model sandbox.** The vault fills credentials via
  trusted input without returning values to model code, and handled secrets
  are redacted from every result envelope. Any new output channel must go
  through redaction.
- **Runtime dependencies are pinned exactly, in several places at once.**
  playwright-core and tldts are exact-pinned (tldts's Public
  Suffix List snapshot decides credential base-domain scope), patchright-core
  must equal playwright-core, and the pins are mirrored in `src/doctor.ts`
  and the publish workflow. `scripts/check-versions.ts` fails the release on
  any drift — run `npm run check:versions` after touching versions.
- **CI job display names are pinned by branch protection.** "Worker copies in
  sync" and "Node tests" in `.github/workflows/ci.yml` must not be renamed.
  Actions in both workflows are SHA-pinned; Dependabot bumps the pins.
- **`src/worker.ts` compiles to an entrypoint with import side effects** (stdin
  readline, ready handshake) — never import the source or
  `dist/src/worker.js` directly from unit tests.
