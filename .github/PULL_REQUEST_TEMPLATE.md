<!--
Keep the summary short. The checklist is the part reviewers rely on: every line
is an invariant this repo enforces in code, not a style preference. Delete a
line only if it is genuinely unrelated to your change, and say so.
-->

## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `bun run release:check` passes locally (versions, lint, typecheck, build,
      unit tests, published declarations, tarball).
- [ ] **Every browser connection still goes through the guard proxy.** No new
      launch path, transport, or fetch bypasses the worker's SOCKS guard
      (`src/guard-proxy.ts`) — the network floor is the security boundary.
- [ ] **No secret value reaches the model sandbox.** New output channels,
      result envelopes, log lines, and MCP/agent tool results go through
      redaction; the vault still fills without returning values to snippet code.
- [ ] **Dependency pins are still mirrored everywhere.** playwright-core,
      tldts, and patchright-core are exact-pinned in
      `package.json`, restated in `src/doctor.ts`, and referenced in
      `.github/workflows/publish-npm.yml`. `bun run check:versions` is green.
- [ ] **Public API changes update `types/*.d.ts` in this same commit.** The
      published declarations are hand-written, not generated —
      `bun run test:types` compiles against them.
- [ ] The two branch-protected CI job names, "Worker copies in sync" and
      "Node tests", are unchanged, and any new action is SHA-pinned with a
      trailing `# vX.Y.Z` comment.
- [ ] No unit test imports `src/worker.ts` or `dist/src/worker.js` directly —
      that module runs import side effects (stdin readline, ready handshake).
- [ ] User-visible behaviour is reflected in `CHANGELOG.md` and, where it
      changes a command or an option, in `docs/` or the help text in
      `src/cli-help.ts`.
- [ ] Nothing private is being committed: no handoff or `internal/` notes, no
      profile, vault, or artifact directory, no routable IP addresses in prose
      (`bun run check:package` enforces the last two for the tarball).

## How it was verified

<!--
Beyond release:check. Name the commands you ran — for example the managed
browser suite (`BETTERWRIGHT_REQUIRE_BROWSER=1 BETTERWRIGHT_CHROMIUM_ROOT=off
bun run test`), a `betterwright doctor` before/after, or the platform you tested on
if the change is platform-specific.
-->
