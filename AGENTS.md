# Working on BetterWright

Guidance for agents (and humans) changing this repo. CONTRIBUTING.md covers
the release process; this file lists the invariants that are easy to break
because they are enforced by code, not convention.

## Commands

- `bun run lint` — biome lint rules. The formatter is off deliberately (see
  biome.jsonc); match the hand style recorded in .editorconfig.
- `bun run typecheck` — TypeScript 7 checks, without emitting, the runtime and
  CLI (`tsconfig.json`), the build tooling (`tsconfig.tools.json`), and the
  shipped examples (`tsconfig.examples.json`). The test and benchmark harness
  (`tsconfig.harness.json`) is checked by `bun run test:unit`, because it
  imports `dist/` and so cannot be checked before a build.
- **Development sources are TypeScript and compile in place.** There are four
  projects, split by what they can depend on:
  - `tsconfig.json` — `src/` and `bin/` → `dist/`.
  - `tsconfig.tools.json` (`bun run build:tools`) — the build and release
    scripts. These must never import `dist/`, because they are what produces it.
    `bun` runs the `.ts` scripts directly; this project is type-check only.
  - `tsconfig.harness.json` (`bun run build:harness`) — tests, benchmarks, and
    probe scripts, all of which drive the built runtime. Runs after `build`.
    Tests execute as TypeScript under `bun test`; this project is type-check
    only.
  - `tsconfig.examples.json` — the shipped examples, type-checked against
    `types/`.

  Run a script or benchmark with `bun path/to/file.ts` after `bun run build`
  (runtime) or `bun run build:harness` (type-check of the harness).
- `bun run check:build` — rebuilds `dist/` and verifies every source file,
  package export, relative import, executable entrypoint, and bun shebang.
- `bun run test:unit` — every `tests/node/*.test.ts` except
  `browser.test.ts`, which needs the managed browser and runs via `bun run test`
  in CI. Set `BETTERWRIGHT_COVERAGE=1` for a report-only coverage table.
- `bun run test:types` — compiles against the hand-written declarations in
  `types/`. Runtime JavaScript is generated in `dist/`, but public declarations
  are not generated: any public API change must update the matching `.d.ts` in
  the same commit.
- `bun run release:check` — all of the above plus version and package checks.

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
  any drift — run `bun run check:versions` after touching versions.
- **CI job display names are pinned by branch protection.** "Worker copies in
  sync" and "Node tests" in `.github/workflows/ci.yml` must not be renamed.
  Those jobs run Bun 1.4; the display names stay for GitHub's required checks.
  Actions in both workflows are SHA-pinned; Dependabot bumps the pins.
- **`src/worker.ts` compiles to an entrypoint with import side effects** (stdin
  readline, ready handshake) — never import the source or
  `dist/src/worker.js` directly from unit tests.

## Cursor Cloud specific instructions

The Cloud Agent environment is defined by `.cursor/environment.json`, whose
install phase (`.cursor/install.sh`) installs the `.bun-version` Bun (1.4.0,
the `engines` floor) from bun.com, runs `bun install --frozen-lockfile`,
builds the runtime/CLI, type-checks the test harness, and downloads the pinned
BetterChromium backend. So `dist/`, `node_modules`, and the browser are already
present on a fresh agent — running the built CLI (`bun dist/bin/betterwright.js …`)
and the product work out of the box.

Do not install Bun from npm. Tarballs published as `bun@1.4.1` and later patch
numbers on npm have been malware; `.cursor/install.sh` uses
`https://bun.com/install` with `bun-v$(cat .bun-version)`.

The platform's non-interactive shell may put a bundled Node ahead of other
tools on `PATH`. BetterWright's scripts are Bun, so put Bun first:

```bash
export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
bun --version   # -> 1.4.0
bun run lint    # and typecheck / test:unit / release:check
```
