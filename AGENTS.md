# Working on BetterWright

Guidance for agents (and humans) changing this repo. CONTRIBUTING.md covers
the release process; this file lists the invariants that are easy to break
because they are enforced by code, not convention.

## Commands

- `npm run lint` — biome lint rules. The formatter is off deliberately (see
  biome.jsonc); match the hand style recorded in .editorconfig.
- `npm run typecheck` — TypeScript 7 checks the runtime and CLI without
  emitting files.
- `npm run check:build` — rebuilds `dist/` and verifies every source file,
  package export, relative import, and executable entrypoint.
- `npm run test:unit` — every `tests/node/*.test.mjs` except
  `browser.test.mjs`, which needs the managed browser and runs via `npm test`
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
  playwright-core, cloakbrowser, and tldts are exact-pinned (tldts's Public
  Suffix List snapshot decides credential base-domain scope), patchright-core
  must equal playwright-core, and the pins are mirrored in `src/doctor.ts`
  and the publish workflow. `scripts/check-versions.mjs` fails the release on
  any drift — run `npm run check:versions` after touching versions.
- **CI job display names are pinned by branch protection.** "Worker copies in
  sync" and "Node tests" in `.github/workflows/ci.yml` must not be renamed.
  Actions in both workflows are SHA-pinned; Dependabot bumps the pins.
- **`src/worker.ts` compiles to an entrypoint with import side effects** (stdin
  readline, ready handshake) — never import the source or
  `dist/src/worker.js` directly from unit tests.
