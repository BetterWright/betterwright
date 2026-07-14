# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Approval-gated browser downloads with configurable `ask`, `allow`, and `deny`
  policies in both clients, plus MCP elicitation through `browser_download`.
- `snapshot()` options for cheaper page observation: `interactive` (actionable
  elements only), `diff` (only the lines changed since the previous snapshot),
  `selector` (scope to a CSS selector), and `depth` (limit tree depth).
- Documented that snapshot `[ref=eN]` markers are directly actionable via
  `page.locator('aria-ref=eN')`.

### Changed

- Result envelopes omit empty `console`/`events`/`artifacts`/`warnings`
  collections instead of sending empty arrays.

### Security

- Normalize IPv4-mapped IPv6 literals to their embedded IPv4 address before
  policy classification in both clients.
- Evaluate every network authorization independently so method-, path-, and
  request-detail policy decisions cannot reuse an unrelated cached allow.
- Restrict every file-input and path-based script API to canonical files inside
  the artifact directory.
- Disable vault-backed credential filling in model-authored snippets; direct
  `CredentialVault` methods remain available to trusted host code.
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
