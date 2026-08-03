# Architecture

## The shape of it

```
┌─────────────────────────────┐       JSON lines over stdio       ┌──────────────────────────┐
│ Client (compiled ESM)       │  ──────────  execute  ─────────▶  │ Compiled Node worker     │
│                             │                                   │                          │
│ • owns the worker           │  ◀─────  guard / vault RPC  ────  │ • fork or Cloak browser  │
│ • NetworkPolicy             │  ───────  rpc_response  ───────▶  │ • sandbox (node:vm)      │
│ • vault (local or custom)   │                                   │ • per-session pages      │
│ • result envelope           │  ◀──────────  result  ──────────  │ • transport SOCKS proxy  │
└─────────────────────────────┘                                   └──────────────────────────┘
```

The client and the worker are separate processes. The client owns the worker's
lifetime, sends it snippets to run, and answers the two kinds of callback the
worker makes: `guard` (is this request allowed?) and `vault` (a credential
operation). The worker owns the browser and the sandbox the model's code runs in.

The worker implementation lives at `src/worker.ts`. TypeScript 7 compiles it to
`dist/src/worker.js`, which is what the npm package runs; the client layer stays
thin. The package ships ordinary ESM JavaScript, not a TypeScript runtime loader.

## Why a separate worker process

Playwright is a Node library, and a browser is heavy and long-lived. Running it
in its own process means:

- The browser survives across many `run()` calls — an agent opens a tab in one
  turn and uses it three turns later.
- A hung or crashing snippet takes down the worker, not your agent. Timeouts
  restart the worker cleanly.
- The trust boundary is a process boundary: model code never shares an address
  space with your policy or your vault.

## The RPC loop and why it can't deadlock

A naive design would send a snippet, block until the result, and only then
handle the browser's requests. That deadlocks the moment a snippet navigates:
the navigation inside the worker blocks waiting for the client to authorize it,
while the client blocks waiting for the navigation to finish.

BetterWright avoids this by servicing RPCs on a dedicated reader while a snippet
is in flight. The client's read loop dispatches three message types
independently — `ready`, `rpc_request` (answered right away), and `result`
(handed to the waiting caller). So a navigation's `guard` request is answered
mid-execution, and the snippet proceeds. Snippets themselves are serialized; the
concurrency is only between one snippet and its own authorization traffic.

## Security model

The design goal is that **model-authored code can drive the page but cannot
escape the network policy or read the host.** That is enforced in layers, so no
single mechanism is load-bearing on its own.

### The sandbox (defense in depth, not a boundary)

Snippets run in a `node:vm` context with code generation disabled and a
hand-built set of globals. The Playwright objects the model touches are wrapped
in proxies that remove the escape-hatch surface: request interception (`route`,
`on`, `exposeFunction`, `newCDPSession`), context mutation, raw `page.screenshot`,
and any method that could read BetterWright's own profile or vault or write
outside the artifact directory. There is no `process`, `require`, or `fs`.

The raw browser handle, CDP sessions, and Playwright private properties remain
inside the worker. Launch configuration is trusted host state, never a snippet
global or model-controlled browser-tool option.

We do **not** claim `node:vm` is a security boundary — it isn't, and the
documentation says so in the worker itself. The sandbox raises the cost of
misusing the API and removes the obvious footguns. The controls that are
actually relied upon are below it, at the browser and network layer.

### The network floor (the real boundary)

The controls that hold even if a snippet found a way around the JS facades:

1. **A mandatory transport proxy.** All traffic — including localhost — is
   forced through a loopback SOCKS proxy the worker runs (`bypass: <-loopback>`).
   The proxy authorizes the connect target *and re-authorizes every IP the
   hostname resolved to*, then connects to those exact literals. This closes
   DNS-rebinding and redirect-hop bypasses: Chromium never does a second,
   unguarded lookup. WebRTC is pinned to the proxy path so it can't send UDP
   around it.
2. **The policy, failing closed.** `NetworkPolicy` answers every `guard` the
   worker cannot serve from its short-lived (≤5 s) decision cache. Navigations,
   documents, downloads and WebSocket upgrades always reach it, and only a stock
   policy's host-scoped answers are ever reused — a `custom` hook, a subclass or
   any other `check` implementation is asked every time (see
   [network-policy.md](network-policy.md)). If it errors, the request is denied
   and nothing is cached. Metadata endpoints can't be allowlisted.

These are independent of the sandbox and of each other. See
[network-policy.md](network-policy.md) for the metadata-endpoint rationale in
full.

The worker's loopback SOCKS proxy is its only always-on listener. One opt-in
second listener exists: the [live-view server](live-view.md) (off by default,
`127.0.0.1` + capability token, started only by an explicit host message),
which streams CDP screencast frames to a human viewer and relays their input.
It runs in the worker because that is where the CDP sessions live; it is not
reachable from the model sandbox.

### Secrets

The [credential vault](credentials.md) is built in by default and kept outside
Chromium's profile; hosts may replace or disable it. Login lookup is URL-gated,
the model sees only item metadata, and the worker resolves and fills the secret
without returning it. Generated passwords stay as encrypted provisional entries
behind opaque ids until the agent verifies success and commits them; exact-id
recovery and origin-scoped pending metadata survive a process restart. Values the vault has handled are redacted
from model-visible output as a final net.

The filled value necessarily exists in the page DOM, just as it does after a
browser extension autofills. The vault therefore limits disclosure and
cross-site selection; it is not a security boundary against JavaScript already
running in the matched page or an attacker with same-user filesystem access.

The person who owns the files can read their own passwords back with
[`betterwright vault`](credentials.md#getting-a-password-back-betterwright-vault),
which is what keeps the vault from being a one-way door for anything the agent
generated. That command reaches a separate owner-only API on the vault object;
`handleRequest` — the RPC the worker speaks, and therefore the only surface
model-authored code can address — cannot route to it, so the sandbox still sees
metadata only. The gate on that command (plaintext to a terminal only, always
audited) exists to stop accidental exposure through a redirect or a captured
stdout, not to defend against a shell that is already yours to run. See
[SECURITY.md](../SECURITY.md#the-shell-is-a-trusted-channel).

### Untrusted page content

Text a snippet pulls off a page is data, not instructions. When a large result
is spilled to a file, it is wrapped in an explicit untrusted-data envelope that
tells the model never to follow instructions found inside it. This is a prompt
your agent's system prompt should reinforce — BetterWright marks the boundary; it
can't make the model respect it.

## State on disk

Everything lives under `$BETTERWRIGHT_HOME` (default `~/.betterwright`):

```
~/.betterwright/
├── browser/
│   ├── profile/        default persistent browser profile (cookies, logins)
│   ├── profiles/       named profiles, one directory per identity
│   │   └── <name>/     e.g. profiles/social — plus its <name>.betterwright-lock
│   └── runtime/        ephemeral profiles when a profile is locked (shared)
├── sessions/           saved `exec` transcripts, per session name
│   └── @<name>/        …and per named profile
├── vault/
│   ├── vault.key       owner-only local encryption key
│   ├── vault.enc       authenticated AES-256-GCM record table
│   ├── audit.jsonl     metadata-only credential actions
│   └── vault.lock/     cross-process write lock
├── daemon.sock         session daemon for the default profile
├── daemon-<name>.sock  …one per named profile (plus .json / .log siblings)
└── artifacts/          screenshots, downloads, spilled output (quota-managed)
    └── downloads/
```

### Named profiles

A home has one persistent profile by default, at `browser/profile`. Only one
process can own it at a time; a second concurrent worker gets an isolated
ephemeral profile from `browser/runtime` (a signed-out browser) rather than
corrupting it.

`profile: "<name>"` (CLI `--profile <name>` or `BETTERWRIGHT_PROFILE`, which
the MCP server reads too) selects a **separate identity**: an independent persistent profile at
`browser/profiles/<name>`, with its own cookie jar, its own lock
(`browser/profiles/<name>.betterwright-lock`, a sibling of the directory), its
own [session daemon](sessions.md), and its own `exec` transcripts. Two
identities therefore run at the same time, each fully signed in. Two instances
of the *same* profile still serialize, and the second falls back to an
ephemeral profile exactly as the default profile does today.

This is a different axis from `--session`. Sessions are concurrent lanes inside
one browser sharing one cookie jar — the right tool for parallel work as the
same identity. Profiles are separate cookie jars in separate browsers — the
right tool for a second account.

Omitting `profile` leaves `browser/profile`, its lock, `daemon.sock`, and
`sessions/<name>/` exactly where they were: no migration, no move, no copy.

**Scoped per profile:** the profile directory, its lock, the session daemon
(socket, info file, log), and saved `exec` transcripts.
**Shared across profiles:** the vault, `artifacts/`, `browser/runtime/`, and
the CloakBrowser binary cache — so a credential saved once is reachable from
every profile, and a second copy of Chromium is never downloaded.

Names are validated as a strict allowlist (letters, digits, `.`, `-`, `_`,
starting with a letter or digit; no path separators, `..`, absolute paths,
trailing dots, or Windows reserved device names), and the marker
`.betterwright-lock` is reserved, so a name can neither escape
`browser/profiles/` nor land on another profile's lock directory. An invalid
name fails at construction. Names are as case-sensitive as the filesystem.

The separately licensed CloakBrowser binary is cached by its official wrapper,
not copied into BetterWright's package or home directory. `betterwright setup`
downloads it directly from CloakHQ's release source and verifies the wrapper's
pinned Ed25519 signature before extraction.

Delete the directory to reset everything; delete `browser/profile/` (or one
`browser/profiles/<name>/`) to sign out everywhere in that profile, or `vault/` to remove saved credential items — `vault.key` and
`vault.enc` are only useful together, so back them up or discard them as a
pair. `betterwright vault path` prints these locations.

When `$BETTERWRIGHT_HOME` sits under a path long enough that
`<home>/daemon.sock` would exceed the platform's unix-socket limit (104 bytes
on macOS, 108 on Linux), the session daemon binds a short socket derived from
the home inside an owner-only directory in the system temp dir instead. Nothing
else moves, and the client resolves the same path. A named profile's socket
(`daemon-<name>.sock`) falls back the same way, on a path derived from the home
*and* the profile, so a long name can never produce an unbindable socket or
collide with another profile's.

## Pinned browser integration

The worker, the JS facades it builds, Playwright, and the CloakBrowser wrapper
have to agree, so both wrapper versions are pinned in the package.
`betterwright setup` installs those exact integrations and asks the
official CloakBrowser wrapper for its signed browser build. Bumping either
wrapper is a deliberate, tested BetterWright change.

The external browser binary has a separate lifecycle: by default it follows the
pinned wrapper's signed stable channel and can advance without a BetterWright
package release. `betterwright doctor` reports the resolved binary version and
tier. Reproducible deployments can set a full `CLOAKBROWSER_VERSION`, while
`CLOAKBROWSER_AUTO_UPDATE=false` freezes update checks for an installed build.

Managed CloakBrowser reduces common browser-fingerprint false positives but
does not guarantee undetectability. It is the only browser backend in both
headed and headless modes.

CloakBrowser's forked Chromium already neutralizes the `Runtime.enable` CDP leak
and the `navigator.webdriver` flag, but Playwright still runs `page.evaluate` in
the page's main world, so a main-world trap can observe the agent the moment it
inspects a page. The opt-in `stealthRuntimeFix` (constructor option, `--stealth`,
or `BETTERWRIGHT_STEALTH_RUNTIME_FIX=1`) closes that vector by swapping the driver
for the pre-patched `patchright-core`, which executes snippets in an isolated
world. It is applied by registering a module-resolution hook on the worker
process (`src/stealth-register.ts` → `src/stealth-hooks.ts`) so the redirect
also covers the Cloak wrapper's own bare `import("playwright-core")`. The cost is
that model snippets can no longer read page-defined main-world globals; it is off
by default for that reason.
