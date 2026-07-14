# Architecture

## The shape of it

```
┌─────────────────────────────┐       JSON lines over stdio       ┌──────────────────────────┐
│ Client (Python or JavaScript)│  ────────  execute  ───────────▶ │ Bundled Node worker      │
│                             │                                   │                          │
│ • owns the worker           │  ◀────  guard / vault RPC  ─────  │ • managed Cloak browser  │
│ • NetworkPolicy            │  ───────  rpc_response  ────────▶ │ • sandbox (node:vm)      │
│ • CredentialVault          │                                   │ • per-session pages      │
│ • RunResult                │  ◀─────────  result  ───────────── │ • transport SOCKS proxy  │
└─────────────────────────────┘                                   └──────────────────────────┘
```

The client and the worker are separate processes. The client owns the worker's
lifetime, sends it snippets to run, and answers the two kinds of callback the
worker makes: `guard` (is this request allowed?) and `vault` (a credential
operation). The worker owns the browser and the sandbox the model's code runs in.

Python and JavaScript clients share the same Node worker implementation. The npm
package loads `src/worker.mjs`; the Python wheel bundles a synchronized copy at
`betterwright/_worker/worker.mjs`. `scripts/sync-worker.mjs` keeps the worker and
its helper modules byte-for-byte aligned, while both client layers stay thin.

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
inside the worker. `connectOverCdp` / `connect_over_cdp` is trusted host launch
configuration, never a snippet global or model-controlled browser-tool option.

We do **not** claim `node:vm` is a security boundary — it isn't, and the
documentation says so in the worker itself. The sandbox raises the cost of
misusing the API and removes the obvious footguns. The controls that are
actually relied upon are below it, at the browser and network layer.

### The network floor (the real boundary)

The controls that hold even if a snippet found a way around the JS facades:

1. **Browser resolver rules.** The Chromium-derived managed browser is launched
   with `--host-resolver-rules` mapping
   cloud-metadata hostnames and link-local ranges to `NOTFOUND`. WebRTC is
   pinned to the proxy path so it can't send UDP around it.
2. **A mandatory transport proxy.** All traffic — including localhost — is
   forced through a loopback SOCKS proxy the worker runs (`bypass: <-loopback>`).
   The proxy authorizes the connect target *and re-authorizes every IP the
   hostname resolved to*, then connects to those exact literals. This closes
   DNS-rebinding and redirect-hop bypasses: Chromium never does a second,
   unguarded lookup.
3. **The policy, failing closed.** `NetworkPolicy` answers every `guard`. If it
   errors, the request is denied. Metadata endpoints can't be allowlisted.

These are independent of the sandbox and of each other. See
[network-policy.md](network-policy.md) for the metadata-endpoint rationale in
full.

### Secrets

The [credential vault](credentials.md) stores passwords encrypted, scoped to an
origin, outside Chromium's profile. Secret-bearing fill operations are not
available to model-authored snippets because arbitrary DOM access would make the
filled value readable. As a last line, values the vault has handled are redacted
from `run()` output. The vault's stated limit: it defends against accidental
disclosure, not against an attacker who can already read your files.

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
│   ├── profile/        persistent browser profile (cookies, logins)
│   └── runtime/        ephemeral profiles when the main one is locked
├── artifacts/          screenshots, downloads, spilled output (quota-managed)
│   └── downloads/
├── vault/              credentials.enc, vault.key, audit.jsonl
└── node/               pinned Playwright + CloakBrowser wrappers for pip installs
```

The separately licensed CloakBrowser binary is cached by its official wrapper,
not copied into BetterWright's package or home directory. `betterwright setup`
downloads it directly from CloakHQ's release source and verifies the wrapper's
pinned Ed25519 signature before extraction.

Delete the directory to reset everything; delete `vault/` to drop stored
credentials; delete `browser/profile/` to sign out everywhere.

## Pinned browser integration

The worker, the JS facades it builds, Playwright, and the CloakBrowser wrapper
have to agree, so both wrapper versions are pinned in the Python and JavaScript
packages. `betterwright setup` installs those exact integrations and asks the
official CloakBrowser wrapper for its signed browser build. Bumping either
wrapper is a deliberate, tested BetterWright change.

The external browser binary has a separate lifecycle: by default it follows the
pinned wrapper's signed stable channel and can advance without a BetterWright
package release. `betterwright doctor` reports the resolved binary version and
tier. Reproducible deployments can set a full `CLOAKBROWSER_VERSION`, while
`CLOAKBROWSER_AUTO_UPDATE=false` freezes update checks for an installed build.

Managed CloakBrowser reduces common browser-fingerprint false positives but
does not guarantee undetectability. Stock Chromium remains an explicit
compatibility/test fallback and may expose obvious automation signals.
