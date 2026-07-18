# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.6] — 2026-07-18

### Fixed

- Removed Chromium's `--host-resolver-rules` launch argument and marked the
  managed browser as a test-type process so Cloak/Playwright's required root and
  container arguments no longer produce persistent command-line warning bars.
  The transport proxy and `NetworkPolicy` continue to enforce metadata blocking.

## [0.8.5] — 2026-07-18

### Changed

- **Cache-aware cost reporting.** `usage.inputTokens` now means fresh input: the
  provider's total input minus `cacheReadTokens` on every turn. The full final
  prompt size remains available as `usage.context`. Both `betterwright exec` and
  the interactive console show cache reads in their summaries, and show cache
  writes only when a provider reports a positive real count. The JSON result
  continues to expose the provider-reported cache read/write totals; cache writes
  are never derived from fresh input.

## [0.8.2] — 2026-07-18

### Changed

- **Slimmer run summary.** The one-line summary now shows just input, output, and
  context — `done in 6 steps, 7 tool calls, 11.4s, 46,880 in / 1,330 out · context
  20,000`. Input/output are cumulative across turns; `context` is the prompt size
  at the end of the task.
- **Cache tokens read from each provider's real fields** (no longer derived) and
  kept in the JSON `usage` as `cacheReadTokens` / `cacheWriteTokens`: the Responses
  API's `input_tokens_details.cached_tokens` / `cache_write_tokens`, the Chat
  Completions `prompt_tokens_details` equivalents, and Anthropic's
  `cache_read_input_tokens` / `cache_creation_input_tokens`. Note: the codex
  ChatGPT backend surfaces cache *reads* but always returns `0` for cache writes,
  which is why cache is left out of the one-line summary (it's still in the JSON).
- **Dropped `usage.totalTokens`** from the result and the summary line — input and
  output tokens price differently, so a combined total was misleading.
- **Renamed `usage.contextTokens` → `usage.context`**.

### Added

- **The interactive console now carries the conversation across tasks.** A
  follow-up task remembers what earlier tasks did and can refer back to them
  without repeating the work — not just the browser session (which already
  persisted), but the transcript too. `/new` clears the memory (and the browser)
  to start fresh. `runAgentTask` gained a `history` option (a prior call's
  `transcript`) that seeds this; `betterwright exec` stays single-shot. The
  Anthropic adapter now coalesces adjacent same-role turns so a continued session
  stays a valid request.
- **`--reasoning` as an alias for `--effort`** (and `/reasoning` for `/effort` in
  the interactive console) — the reasoning-effort control under its more intuitive
  name. `--effort` continues to work unchanged.

## [0.8.1] — 2026-07-18

### Added

- **Runs now report the time they took.** `runAgentTask` returns `durationMs`
  (task wall-clock, excluding teardown of a browser it created for itself), and
  both `betterwright exec` and the interactive console include it in their cost
  summary. It is also part of the `exec` stdout JSON.
- **Cache and end-of-task context in the usage report.** Alongside input/output
  totals, `usage` now carries `cacheReadTokens` and `cacheWriteTokens` (the cached
  portion of the input — OpenAI-style backends report only cache reads, so writes
  stay `0`) and `contextTokens`, the prompt size at the end of the task (the last
  turn's input — how much context the model was holding when it finished). The
  summary line reads e.g. `done in 6 steps, 7 tool calls, 11.4s, 48,210 tokens
  (46,880 in / 1,330 out · 40,000 cache read · 2,000 cache write) · ctx 20,000`.

## [0.8.0] — 2026-07-18

### Added

- **Interactive agent console (`betterwright` with no subcommand).** The
  counterpart to `aside` on its own: a REPL where you type natural-language tasks
  and watch BetterWright's own agent loop drive the browser to complete them. Each
  step streams as it happens, then the answer, the proof-screenshot path, and a
  one-line cost summary. **One browser session persists across tasks**, so a later
  task builds on where an earlier one left off (still signed in, tabs open). Meta
  commands: `/model`, `/effort`, `/new`, `/clear`, `/help`, `/exit`. The usual
  `--model`, `--model-id`, `--effort`, `--session`, `--headed`, and network flags
  apply.
- **`ask` tool for interactive runs.** When `runAgentTask` is given an `askUser`
  handler (the interactive console wires this to the prompt), the loop exposes an
  `ask` tool so the agent can put a question to the user mid-task — a code it
  cannot obtain, a consequential choice with no reasonable default, or genuine
  ambiguity — offering short concrete options and continuing on the reply. The
  operator guidance switches to an interactive posture accordingly. `betterwright
  exec` has no user watching, so it runs without the `ask` tool and never stalls.
- **`betterwright exec` now reports what the run cost.** The result JSON carries
  `toolCalls` (how many `browser`/`login`/`ask`/`done` calls the model issued) and
  `usage` (`{ inputTokens, outputTokens, totalTokens }`, summed across turns), and
  the final stderr line prints a one-line summary — e.g. `done in 6 steps, 7 tool
  calls, 48,210 tokens (46,880 in / 1,330 out)`. `runAgentTask` returns the same
  fields. Token counts come from each provider's usage block (Anthropic cache
  tokens fold into the input total); a field is `0` when a provider omits usage.

### Fixed

- **`--model` (and `runAgentTask`'s `model`) now accepts a bare model id.**
  Passing a model id such as `--model gpt-5.6-sol` no longer errors with
  `Unknown model`; the backend is inferred from the id's prefix (`gpt-*`/`o*` →
  codex, `grok-*` → grok, `claude-*` → claude) and the id is used as the model id
  (an explicit `--model-id` still wins). Adapter names (`claude`/`codex`/`grok`)
  work exactly as before.

## [0.7.0] — 2026-07-18

### Added

- **Built-in agent harness (`betterwright exec`)** — BetterWright can now drive
  itself. Alongside the existing "bring your own agent" model (an external
  harness driving BetterWright through `run()`, MCP, or Pi — the `aside repl`
  shape), it now ships its own browser-tuned agent loop that a model plugs into
  (the `aside exec` shape). `betterwright exec "<task>" --model claude|codex|grok`
  runs a natural-language task to completion: observe with `snapshot`, act,
  verify with `snapshot({diff})`, capture proof, finish. The model is a small
  pluggable interface (`{ complete({system, messages, tools}) }`), so the three
  built-in adapters — `claude` (Anthropic SDK, an optional peer dependency),
  `codex` (the ChatGPT-backend Responses API over codex OAuth creds from
  `~/.codex`, or OpenAI-compatible with an API key), and `grok`
  (OpenAI-compatible over grok OAuth creds) — are just defaults; pass your own
  object to drive the loop with any model or agent. New `betterwright/agent`
  export (`runAgentTask`, `resolveModel`, `claudeModel`, `codexModel`,
  `grokModel`, `openaiModel`) and a `login` tool inside the loop when a vault is
  configured. See [docs/agent.md](docs/agent.md).
- **Native OAuth sign-in (`betterwright auth --login codex|grok`)** — the built-in
  agent's `codex` and `grok` backends now authenticate through BetterWright's own
  OAuth 2.0 PKCE flow instead of depending on an external router. `auth --login
  codex` opens the "Sign in to Codex with ChatGPT" consent page, captures the
  redirect on a loopback server, and stores the tokens in `~/.codex/auth.json`
  (shared with the codex CLI); `auth --login grok` does the same for xAI
  (SuperGrok / X Premium+), storing to `~/.grok/auth.json`. The adapters then call
  the ChatGPT backend (codex) and xAI's OpenAI-compatible endpoint (grok)
  directly, refreshing the access token per request. `betterwright auth --status`
  reports the signed-in accounts. New `betterwright/auth` export (`loginProvider`,
  `loadCodexAuth`, `loadGrokAuth`, `codexAccessToken`, `grokAccessToken`).
- **Skill packs** — on-demand site and provider knowledge a host agent reads
  when it is relevant, instead of one static prompt carrying everything. Packs
  ship in `skills/` (`credential-manager`, `1password`, `bitwarden`, `github`)
  as `SKILL.md` files with `autoInject` keyword/URL triggers. Every run result
  now carries a `skills` array of packs whose `autoInject.url` matches an open
  page (`{name, description, path}`), and the operator prompt tells the agent to
  read the pack before improvising site-specific behavior. New CLI
  `betterwright skills list|show <name>`, user packs under
  `$BETTERWRIGHT_HOME/skills` overriding packaged ones, and a `betterwright/skills`
  export (`listSkills`, `readSkill`, `matchSkillsForUrl`, `matchSkillsForText`,
  `skillHintsForPages`, `parseSkillDocument`). See [docs/skills.md](docs/skills.md).
- **`browser_login` on MCP and Pi** — trusted credential fill is no longer
  SDK-only. Both the MCP server and the native Pi package expose a
  `browser_login` tool that fills a saved or freshly generated credential
  (`generate: true` for signup) without the secret ever being returned; the fill
  runs as a dedicated worker message, never as model JavaScript. The fill is
  **origin-scoped** — like an unlocked password-manager extension (and like
  Aside's vault), it can only fill the credential for the page's current origin,
  not harvest other sites' secrets. It requires a configured vault: pass one to
  `runMcpServer(env, { vault })` or via Pi `browserOptions.vault`; without a
  vault (e.g. plain `npx betterwright mcp`), logins go through a password-manager
  extension's autofill instead — see the `1password`/`bitwarden` skill packs.
- **Credential categories and search** — `credentials.list({text, category})`
  filters the current origin's records, and `credentials.save({category})`
  stores non-login records (`credit-card`, `identity`, `api-credential`,
  `secure-note`, `ssh-key`) that carry their own metadata instead of a password.

### Changed

- The operator prompt now steers the agent to ask through its **host's** own
  question mechanism with short, secret-masked options, and to read a hinted
  skill pack (and always the `credential-manager` pack before a login, signup,
  or checkout).
- The `exec` harness batches multi-page work into a single `browser` call
  (`parallel_tool_calls`), closing most of the step-count gap with Aside on
  multi-step navigation and search tasks (see
  [benchmarks/exec-headtohead](benchmarks/exec-headtohead/REPORT.md)).
- **Removed the vestigial local OAuth-router machinery.** After native OAuth
  login shipped, the auto-spawned `grok-codex-router` bridge was dead weight; the
  codex/grok adapters now resolve through an API key, a `betterwright auth` OAuth
  session, or an explicit `CODEX_BASE_URL` / `GROK_BASE_URL` base URL only.
- Repo-wide readability pass across the runtime source: duplicated blocks folded
  into local helpers, dead code and unused parameters removed, and house style
  (nullish coalescing, guard shape, single-source `codexHome`) made consistent.

### Fixed

- **`snapshot()` no longer leaks filled password values.** Playwright's aria
  snapshot includes input values, so a snapshot taken after a password was typed
  (by the agent or a password-manager extension) surfaced the secret in the
  model-facing tree. Password-input values are now replaced with `[redacted]`
  (other fields read normally) before the snapshot is stored, diffed, or
  returned. Found by the AsideWright head-to-head benchmark.
- **OAuth login hardening.** The loopback callback server is now closed on a
  sign-in timeout (no leaked port), token refresh is single-flight so concurrent
  requests rotate the refresh token only once and validates that a fresh access
  token was actually returned, and a non-JSON token-endpoint response surfaces a
  readable error instead of a `SyntaxError`.

## [0.6.1] — 2026-07-17

### Added

- **Runtime.enable stealth (opt-in)** — `new BetterWright({ stealthRuntimeFix: true })`,
  the `--stealth` CLI flag, or `BETTERWRIGHT_STEALTH_RUNTIME_FIX=1` route the
  driver through the pre-patched `patchright-core` drop-in so every `run()`
  snippet executes in an isolated world. This defeats main-world automation
  detection (rebrowser's `mainWorldExecution` test goes from flagged to
  untriggered) that the managed Cloak browser leaves open — Cloak already
  neutralizes the `Runtime.enable` and `navigator.webdriver` signals, but
  `page.evaluate` otherwise still runs in the page's main world. A module-
  resolution hook applies the swap process-wide, including the Cloak wrapper's
  own `import("playwright-core")`. Trade-off (surfaced as a run warning while
  active): snippets can no longer read page-defined main-world globals such as
  `window.__NEXT_DATA__`; DOM access, clicks, and typing are unaffected.
  `patchright-core` is an optional dependency, pinned to the same 1.61.x line as
  `playwright-core`; `betterwright doctor` reports `stealth_available`. Off by
  default.

### Changed

- Headed and headless runs now always launch the managed CloakBrowser with the
  same persistent profile and full network floor. The desktop default no longer
  diverts headed sessions into ordinary Google Chrome over CDP.
- Browser integration CI now installs and exercises CloakBrowser directly,
  including a headed Xvfb smoke, instead of using Playwright's stock test
  Chromium as the broad-suite backend.

### Removed

- Removed the stock-Chromium backend, `executablePath`, Chrome CDP attach mode,
  the `betterwright/chrome` export, and `betterwright setup --chromium`.
  Legacy options and environment variables fail clearly instead of weakening
  the managed Cloak launch.

### Fixed

- `--headed`, `headless: false`, `headless: "auto"` on desktops, and
  `BETTERWRIGHT_HEADLESS=0` now exercise actual headed CloakBrowser rather than
  an unrelated Chrome launch path.

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
