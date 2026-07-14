# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `publicSearchPolicy` now defaults to `"allow"` instead of `"block"`. Public
  search-result UIs (Google, Bing, DuckDuckGo) are navigable by default; set
  `publicSearchPolicy: "block"` (or `BETTERWRIGHT_PUBLIC_SEARCH_POLICY=block`) to
  restore routing broad discovery through a host-supplied search tool. Trade-off:
  automating public search UIs is more exposed to bot detection, so hosts that
  rely on the guard should opt back in explicitly.

### Fixed

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
