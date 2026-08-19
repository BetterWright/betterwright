# Browser providers

BetterWright's default browser is always the managed BetterChromium fork —
the pinned, source-patched Chromium that `betterwright setup` installs and
every launch keeps on the guard proxy. When you need a different browser —
your own Chromium build, or a cloud browser from a provider — the `provider`
option is the opt-in escape hatch.

Exactly one kind per launch:

```ts
// 1. A caller-supplied local Chromium binary. Still launched locally, still
//    policy-enforced through the guard proxy — but the managed fork's
//    fingerprint patches are not in this binary, and the launch warning says so.
new BetterWright({ provider: { executablePath: "/opt/chrome/chrome" } });

// 2. Any CDP WebSocket endpoint (a locally forwarded port, a tunnel, a
//    self-hosted browserless, …). `headers` ride the WebSocket handshake.
new BetterWright({
  provider: {
    cdpUrl: "wss://browser.internal.example.com/devtools/browser/abc",
    headers: { "x-api-key": "…" },
  },
});

// 3. A named cloud provider: BetterWright mints a session over the
//    provider's REST API and attaches to the CDP endpoint it returns.
new BetterWright({
  provider: {
    provider: "browserbase",
    apiKey: "bb_live_…", // or BROWSERBASE_API_KEY
    sessionOptions: { proxies: true }, // passed through verbatim
  },
});
```

CLI equivalents (shared by `run`, `repl`, and `exec`):

```bash
betterwright run … --browser browserbase --browser-key bb_live_…
betterwright run … --browser wss://browser.example.com/devtools/abc
```

`BETTERWRIGHT_CDP_URL` is the host-level shorthand for `{ cdpUrl }`.

## Named providers

| Provider      | `provider:`      | API key env var          | Key format / notes |
| ------------- | ---------------- | ------------------------ | ------------------ |
| Browser Use   | `browser-use`    | `BROWSER_USE_API_KEY`    | Connect URL mints a browser per connection; `sessionOptions.proxyCountryCode` sets the egress country. |
| Kernel        | `kernel`         | `KERNEL_API_KEY`         | Sessions minted via `POST /browsers` and released on close. |
| Browserbase   | `browserbase`    | `BROWSERBASE_API_KEY`    | Sessions released on close. `sessionOptions` passes Browserbase's create-session fields. |
| Steel         | `steel`          | `STEEL_API_KEY`          | Default session per connection; `sessionOptions.sessionId` pins an existing one. |
| Anchor        | `anchor`         | `ANCHOR_API_KEY`         | Sessions end when the connection drops. |
| Hyperbrowser  | `hyperbrowser`   | `HYPERBROWSER_API_KEY`   | Sessions stopped on close. |
| Browserless   | `browserless`    | `BROWSERLESS_API_KEY`    | Launch options (`blockAds`, …) are `sessionOptions` query params. |
| Bright Data   | `brightdata`     | `BRIGHTDATA_BROWSER_AUTH`| Key is the zone credential `brd-customer-…-zone-…:password` (scraping browser endpoint). |
| Oxylabs       | `oxylabs`        | `OXYLABS_BROWSER_AUTH`   | Key is `USERNAME:PASSWORD`; params (`p_cc=US`, …) are `sessionOptions` query params. |

Anything else that speaks plain CDP — self-hosted browserless, Lightpanda, a
tunneled `chrome --remote-debugging-port` — works through `{ cdpUrl }`.

Because CDP exposes the whole browser, a remote endpoint must use `wss://`;
plaintext `ws://` is accepted only for loopback (`localhost`, `127.0.0.1`,
`::1`), where the traffic never leaves the host.

## What changes with a remote browser

A remote browser runs on the provider's side of the WebSocket:

- **The guard proxy cannot see its traffic.** The network floor in
  SECURITY.md — per-connection policy, DNS-rebinding re-validation — only
  exists for browsers BetterWright launches. The launch result carries a
  warning that says exactly this, and `betterwright doctor` reports the
  provider browser as `warn`, never `ok`.
- **Model-side boundaries still apply.** Vault redaction, trusted credential
  filling, and download controls are enforced in the worker, not the network,
  so they are unchanged. `installContextGuard`'s Playwright routing still
  runs over the CDP connection where the provider supports it.
- **Profile persistence is the provider's.** The local profile dir, the
  launch identity flags, and the fingerprint seed only exist for locally
  launched browsers.
- **WebMCP feature flags are the provider's.** BetterWright enables
  `WebMCPTesting,DevToolsWebMCPSupport` for browsers it launches locally. An
  attached or cloud browser must start Chromium with
  `--enable-features=WebMCPTesting,DevToolsWebMCPSupport`; otherwise
  `webmcp.tools()` returns an actionable unsupported-feature error.
- **Sessions can keep billing.** Providers with a session-stop API (Kernel,
  Browserbase, Hyperbrowser) are released when the browser closes. Providers
  without one (Browser Use, Steel, Anchor, Browserless, Bright Data, Oxylabs)
  end on disconnect or by their own timeout; the launch warning names it.

Provider credentials (the API key, and any credentials embedded in the CDP
URL) are registered with the worker's redaction set at launch, so they appear
as `[redacted]` in every result envelope, event, and artifact path.

## `sessionOptions`

For REST-minting providers (Kernel, Browserbase, Anchor, Hyperbrowser),
`sessionOptions` is sent as the create-session body verbatim, so new provider
features (proxy geography, keepAlive, profile IDs, screen size) work without
a BetterWright release. For connect-URL providers (Browser Use, Steel,
Browserless, Oxylabs) selected fields become query parameters as documented
above.

## Doctor

`betterwright doctor` reports the resolved provider under **Browser →
Provider** — the kind, the provider name, and the masked endpoint — and marks
remote providers as `warn` so the guard-proxy boundary is never invisible.
