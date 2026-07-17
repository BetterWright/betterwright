# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] — 2026-07-17

### Added

- **Annotated screenshots** — `screenshot({annotate: true})` overlays a
  labelled bounding box on every interactive element (including elements inside
  child iframes, offset to page coordinates) before capturing, so what the
  model sees in the image maps directly back to an `aria-ref` it can act on.
  The overlay is removed after capture and the artifact reports an
  `annotations` count.
- **Ref-scoped snapshots** — `snapshot({ref: 'e31'})` zooms into one element's
  subtree using a ref from the previous snapshot, with no CSS selector needed.
- Snapshot headers now include the page title alongside the page id and URL.

### Changed

- Operator guidance rewritten around an explicit reading-escalation ladder
  (interactive snapshot → full snapshot → brief wait and re-snapshot →
  annotated screenshot), ref/URL anti-guessing rules, action–verification
  batching within a single `run()`, a concrete recovery ladder (fresh snapshot
  before retry, inspect the hit target on "obscured" clicks, switch approach
  after two failures), and no-sleep/no-scroll-to-read discipline. The MCP
  `browser` tool description and the pi extension description carry the same
  guidance.

- **Local CAPTCHA solver** — `captcha.solve()` and `captcha.detect()` run entirely
  inside the managed browser with no third-party captcha APIs and no heavy ML
  runtime. Auto-handles checkbox, Turnstile, Cloudflare managed checks, and
  sliders; image grids and text challenges return a 2Captcha-shaped
  `processing` envelope with vision artifacts and tile bounds for the host
  model. Pure helpers are exported as `classifyChallengeStage`,
  `CAPTCHA_STAGES`, and `CAPTCHA_SOLVE_STATUSES`. Challenge reports now include
  `stage`, `autoSolvable`, and `needsVision`.

## [0.5.0] — 2026-07-15

### Added

- `betterwright skill` — prints a paste-ready agent skill: CLI usage followed
  by the operator guidance. `--claude` adds SKILL.md frontmatter so
  `betterwright skill --claude > ~/.claude/skills/browser/SKILL.md` installs a
  native Claude Code skill; the plain output appends cleanly to Codex
  `AGENTS.md` or any agent's system prompt. CLI + skill is now the primary,
  documented integration path (README and SETUP.md restructured around it).
- `betterwright mcp` — the MCP stdio server (`browser`, `browser_download`,
  `browser_doctor`) now ships in the npm package behind the optional
  `@modelcontextprotocol/sdk` peer dependency, with policy read from
  `BETTERWRIGHT_*` environment variables and screenshots returned as native
  MCP image content.

### Changed

- **Network policy defaults opened.** Private networks and loopback are now
  reachable by default so agents can drive local dev servers and intranet
  hosts out of the box (the earlier default blocked them). Cloud-metadata
  endpoints and secret-bearing URLs remain blocked — that floor is not
  configurable. Harden with the new CLI flags `--block-private-network` /
  `--block-loopback`, the `NetworkPolicy` options
  `allowPrivateNetwork: false` / `allowLoopback: false`, or the MCP env vars
  `BETTERWRIGHT_BLOCK_PRIVATE_NETWORK=1` / `BETTERWRIGHT_BLOCK_LOOPBACK=1`.
- The operator guidance now names the JavaScript credential-fill methods
  (`bw.fillCredential`, `bw.generateAndFillCredential`).

### Removed

- **The Python package.** BetterWright is now npm-only; `pip install
  betterwright` is discontinued at 0.4.0 and the PyPI publish workflow is
  deleted. Python agents integrate through the CLI + skill path (shelling out
  to the `betterwright` binary), which provides the same persistent,
  policy-guarded browser without an in-process SDK. This also removes the
  dual-language worker-sync, policy/prompt parity, and wheel machinery; the
  shared policy conformance vectors live on as a JS regression suite.

## [0.4.0] — 2026-07-15

### Added

- Native Pi Coding Agent package integration with persistent `browser` and
  approval-gated `browser_download` tools, screenshot vision blocks, bounded
  step budgets, optional trace recording, and typed JavaScript exports.
- A deterministic Online-Mind2Web harness with 50-task and full 300-task
  manifests, development/holdout partitions, v2 trajectory validation,
  resumable subset runs, and a strict local multimodal judge pinned to the
  benchmark model and reasoning level.
- A recorded 300-task Online-Mind2Web campaign report — 278/300 (92.7%) under
  the local strict judge — with public-safe results, difficulty breakdown, and
  dataset hashes under `benchmarks/online-mind2web/`.

### Changed

- `connectOverCdp` now has a **display-aware default**, mirroring
  `headless: "auto"`. When both a display and a real Google Chrome are present
  (a desktop), BetterWright attaches to that Chrome over CDP by default —
  giving real logins and extensions, with the launch-time network floor
  inactive (only the per-request policy applies). Headless or Chrome-less
  environments (servers, containers, CI) continue to launch the managed Cloak
  sandbox with the floor intact, and a Chrome that fails to attach falls back to
  the sandbox rather than failing. Pass `connectOverCdp: ""` (or
  `connect_over_cdp=""`) to force the launched sandbox regardless.
- `publicSearchPolicy` now defaults to `"allow"` instead of `"block"`. Public
  search-result UIs (Google, Bing, DuckDuckGo) are navigable by default; set
  `publicSearchPolicy: "block"` (or `BETTERWRIGHT_PUBLIC_SEARCH_POLICY=block`) to
  restore routing broad discovery through a host-supplied search tool. Trade-off:
  automating public search UIs is more exposed to bot detection, so hosts that
  rely on the guard should opt back in explicitly.

### Fixed

- Pi start-page navigation failures are recoverable, and the initial failure is
  retained as trace evidence instead of causing every later tool call to fail.
- Challenge detection and Pi trace screenshots follow only the active page, so
  an inactive stale CAPTCHA tab cannot replace the current page's evidence or
  challenge state.
- Local benchmark judging retains the first trajectory frame, preserving proof
  that a run started at the required site and any access failure that justified
  a later fallback.
- The stock-Chromium fallback now uses its own `profile-chromium` directory
  instead of sharing the Cloak `profile`. Because the fallback ships a newer
  Chromium than Cloak, a single shared profile let it silently upgrade the
  profile format, after which the older Cloak binary crashed on launch (an
  opaque `SIGTRAP` in the AppKit window/session-restore path — "the browser
  opens then instantly closes"). Cloak keeps the historical `profile` path so
  existing saved logins survive the upgrade.
- Launching Cloak against a profile already upgraded by a newer Chromium now
  fails with a clear, actionable error (naming the offending version and how to
  reset) instead of crashing during startup.

## [0.3.1] — 2026-07-15

### Added

- First-class npm distribution with typed conditional exports for the public
  JavaScript API and subpath modules.
- Release checks for synchronized versions, worker copies, TypeScript
  declarations, npm tarball contents, clean installation, imports, and CLI use.
- Provenance-ready npm publishing through GitHub Actions after the initial
  package bootstrap.

### Changed

- Browser installation is now an explicit `betterwright setup` step instead of
  a hidden ~200 MB npm `postinstall` download.
- npm CI uses a committed lockfile and reproducible `npm ci` installs.
- `doctor` reports the resolved Cloak browser binary version and tier separately
  from the pinned wrapper version.
- Public npm subpaths now resolve through explicit runtime and declaration
  conditions, including the existing worker entry point.

## [0.3.0] — 2026-07-14

### Added

- Trusted credential fill: `fill_credential` / `fillCredential` and
  `generate_and_fill_credential` / `generateAndFillCredential` type a stored (or
  freshly generated) password into the current page from the worker, outside the
  model sandbox. Supports a `confirm_password_selector` for signup forms and an
  optional `submit_selector`; only non-secret metadata is returned. This replaces
  the previously advertised-but-unimplemented "trusted host-side login handoff".
- `connect_over_cdp="auto"` (and Python `ensure_chrome_cdp`) reuse a running
  debug Chrome or launch a real Google Chrome with a persistent profile, so the
  agent can drive your own password-manager (e.g. 1Password) extension's inline
  autofill in attach mode.
- Examples: `signup_with_generated_password.py` and `onepassword_attach.py`.

### Fixed

- `examples/python/login_with_vault.py` called the disabled model-facing
  `credentials.fill` and never actually filled; it now uses `bw.fill_credential`.

## [0.2.0] — 2026-07-14

### Added

- Approval-gated browser downloads with configurable `ask`, `allow`, and `deny`
  policies in both clients, plus MCP elicitation through `browser_download`.
- `snapshot()` options for cheaper page observation: `interactive` (actionable
  elements only), `diff` (only the lines changed since the previous snapshot),
  `selector` (scope to a CSS selector), and `depth` (limit tree depth).
- Documented that snapshot `[ref=eN]` markers are directly actionable via
  `page.locator('aria-ref=eN')`.
- `captcha.inspect(bounds?)` plus automatic challenge-image artifacts for
  visible bot checks, including checks detected inside child frames and after a
  failed browser snippet.

### Changed

- Result envelopes omit empty `console`/`events`/`artifacts`/`warnings`
  collections instead of sending empty arrays.
- Managed CloakBrowser launches are now the default. Setup downloads the
  separately licensed binary directly through the pinned official wrapper and
  its mandatory signature verification; BetterWright does not redistribute it.
  Stock Chromium remains an explicit compatibility/test fallback.
- Bot challenges are treated as resumable state. Agent guidance now works
  through at most three distinct stages, resumes the original action when the
  challenge clears, and then chooses a human handoff or alternate first-party
  source instead of looping.
- Broad discovery is routed through a host-provided web-search tool rather than
  automated Google or Bing public-search pages. Public result UIs are blocked
  by default, with an explicit trusted-host opt-in.
- Provider response fields and completed widget frames now clear solved
  reCAPTCHA, hCaptcha, and Turnstile state so the original action can resume.

### Security

- Normalize IPv4-mapped IPv6 literals to their embedded IPv4 address before
  policy classification in both clients.
- Evaluate every network authorization independently so method-, path-, and
  request-detail policy decisions cannot reuse an unrelated cached allow.
- Restrict every file-input and path-based script API to canonical files inside
  the artifact directory.
- Disable vault-backed credential filling in model-authored snippets; direct
  `CredentialVault` methods remain available to trusted host code.
- Keep CDP sessions, raw browser handles, and private Playwright properties
  internal to the worker; model snippets continue to receive only guarded
  facades and helpers.
- Redact trusted CDP endpoints from attach failures and block browser-internal
  pages that could reveal debugging pipes, proxy ports, paths, or fingerprint
  flags.
- Cancel oversized downloads through Chromium progress events and bound
  screenshots by pixels and encoded bytes before writing artifact files.
- Deny downloads before ordinary browser runs and close each approved download
  window before the next run; attached browsers fail closed when bounded CDP
  download controls are unavailable.

## [0.1.0] — 2026-07-14

Initial release.

### Added

- Persistent, sandboxed Playwright worker driven by ordinary async JavaScript,
  shared by both the Python and JavaScript clients.
- `BetterWright` client with named sessions and a typed `RunResult` (Python) /
  result envelope (JavaScript).
- `NetworkPolicy` — per-request authorization for navigations, subresources,
  WebSockets, and raw TCP, with a metadata/private-network floor enforced at the
  resolver, transport-proxy, and policy layers.
- `CredentialVault` — AES-256-GCM, origin-scoped credential storage with fill
  helpers that keep passwords out of the model's context, plus output redaction.
- Proof/question/debug screenshot artifacts surfaced as `MEDIA:` references.
- Native `captcha.click`, `captcha.drag`, and `captcha.readText` browser helpers
  for one-shot checkbox, slider, and text-challenge handling without a paid API.
- Human-shaped `human.click`, `human.type`, and `human.scroll` actions, adapted
  from CloakBrowser's MIT-licensed interaction layer.
- Optional use of an explicitly installed CloakBrowser binary through
  `CLOAKBROWSER_BINARY_PATH`, without bundling or downloading that binary.
- Managed dedicated-Chrome attach mode, optional public-search pacing, and
  structured visible bot-challenge reporting.
- A Pi tool-result image adapter that emits the top-level `data` and `mimeType`
  fields expected by Pi's OpenAI Codex provider.
- Screenshot-proof guidance that makes agents inspect and retake unusable images
  before citing them.
- `betterwright` CLI (`setup`, `doctor`, `run`, `repl`) in both
  languages.
