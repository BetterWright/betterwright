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
betterwright run … --browser kernel --session-id sess_1
betterwright run … --browser wss://browser.example.com/devtools/abc
```

`BETTERWRIGHT_CDP_URL` is the host-level shorthand for `{ cdpUrl }`.

## Configuring a default

Passing `--browser` on every call gets old. `betterwright configure` writes the
choice once, into the `browser` section of `<BETTERWRIGHT_HOME>/config.json`,
and every later launch picks it up. Run it with no flags on a terminal and it
lists the current setting, the built-in providers, any custom ones you added,
a custom CDP endpoint, and your own Chromium binary, then offers to connect
once so you find out immediately whether the key works.

The same choices are available without prompting:

```bash
betterwright configure --show                      # current setting (--json for scripts)
betterwright configure --browser steel --key-env STEEL_API_KEY
betterwright configure --browser browserbase --browser-key bb_live_…
betterwright configure --connect kernel --key-env KERNEL_API_KEY
betterwright configure --disconnect kernel
betterwright configure --browser wss://browser.example.com/devtools/abc
betterwright configure --browser /opt/chrome/chrome  # a local binary
betterwright configure --managed                   # back to the managed fork
betterwright configure --test                      # connect and print the version
```

`--connect` writes the key into `browser.accounts` without changing which
browser a launch uses. That is how you keep the managed fork as the default
and still run `betterwright boxes` against Kernel, Browserbase, Steel, Anchor,
Hyperbrowser, or Browser Use. Setting `--browser <name>` with a key connects
the account as well. `--managed` / `--reset` clears only the launch default;
connected accounts stay until `--disconnect`.

Precedence for one launch, first hit wins:

1. the explicit `provider` option, or `--browser` on the command line
2. `BETTERWRIGHT_CDP_URL`
3. the configured default
4. the managed BetterChromium fork

### Custom named providers

Any service that speaks CDP can have a name of its own, so it works as
`--browser <name>` everywhere a built-in provider does:

```bash
betterwright configure --add my-cloud \
  --cdp-url 'wss://cdp.my-cloud.example/connect?token=${apiKey}' \
  --key-env MY_CLOUD_TOKEN --display-name "My Cloud" --docs https://my-cloud.example/docs
betterwright configure --remove my-cloud
```

`${apiKey}` in the connect URL (and in any header value) is replaced with the
key at launch. A template with no `${apiKey}` needs no key at all.

### Where keys are stored

`--browser-key` stores the key in `config.json`, which is written owner-only
(mode 0600) because of exactly this. `--key-env NAME` stores only the variable
name, so the key stays in your environment and out of the file; the launch
fails with a clear message when the variable is unset. Provider credentials
are redacted from result envelopes either way.

`--show --json` reports connected accounts with stored keys masked as `***`.

## Managing boxes

Six of the nine named providers expose a real session lifecycle (create, list,
get, stop) over REST, matching their official SDKs. The other three allocate a
browser only for the duration of a WebSocket connection, so there is nothing
to start or stop.

```bash
betterwright configure --connect kernel --key-env KERNEL_API_KEY
betterwright boxes start --browser kernel
betterwright boxes list
betterwright boxes show <id> --browser kernel
betterwright boxes stop <id> --browser kernel
betterwright run --browser kernel --session-id <id> -c "return page.url()"
```

`--json` is safe for scripts: CDP URLs go through the same credential masking
as logs, and the API key is never in the payload. `--status` is passed through
as the provider's list filter (Browserbase `RUNNING` / `COMPLETED`, …).

From code, the same REST calls are `createProviderSession`,
`listProviderSessions`, `getProviderSession`, and `stopProviderSession` on
`betterwright/sdk`.

Browserless, Bright Data, and Oxylabs stay connect-only: `boxes start` (and
list/show/stop) refuses them with a message that says to connect instead.

## Named providers

| Provider      | `provider:`      | API key env var          | Launch / boxes |
| ------------- | ---------------- | ------------------------ | -------------- |
| Browser Use   | `browser-use`    | `BROWSER_USE_API_KEY`    | Launch is a connect URL (`sessionOptions.proxyCountryCode` sets egress). Boxes speak the v4 browsers API. `--session-id` GETs that browser and attaches. |
| Kernel        | `kernel`         | `KERNEL_API_KEY`         | Launch mints via `POST /browsers` and releases on close. `--session-id` attaches without taking ownership. `boxes` uses the same browsers API. |
| Browserbase   | `browserbase`    | `BROWSERBASE_API_KEY`    | Sessions released on close (`REQUEST_RELEASE`). `sessionOptions` passes create-session fields. |
| Steel         | `steel`          | `STEEL_API_KEY`          | Launch is `wss://connect.steel.dev`. Boxes speak the Sessions API. `--session-id` GETs the session, then reconstructs the connect URL. |
| Anchor        | `anchor`         | `ANCHOR_API_KEY`         | Sessions minted via `POST /api/v1/sessions` and deleted on close. |
| Hyperbrowser  | `hyperbrowser`   | `HYPERBROWSER_API_KEY`   | Sessions minted via `POST /api/session` and stopped on close. |
| Browserless   | `browserless`    | `BROWSERLESS_API_KEY`    | Connect-only. Launch options (`blockAds`, …) are `sessionOptions` query params. |
| Bright Data   | `brightdata`     | `BRIGHTDATA_BROWSER_AUTH`| Connect-only. Key is the zone credential `brd-customer-…-zone-…:password`. |
| Oxylabs       | `oxylabs`        | `OXYLABS_BROWSER_AUTH`   | Connect-only. Key is `USERNAME:PASSWORD`; params (`p_cc=US`, …) are `sessionOptions` query params. |

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
- **Sessions can keep billing.** Providers whose *launch* path mints a REST
  session (Kernel, Browserbase, Anchor, Hyperbrowser) release that session
  when the browser closes. Attaching to an existing box (`--session-id` /
  `sessionOptions.sessionId`) never takes that ownership: disconnect does
  not stop the box. Steel and Browser Use still launch through a connect
  URL, so a launch does not create a billed REST session — use
  `betterwright boxes start` / `stop` when you want one. Browserless, Bright
  Data, and Oxylabs have no session ids; the browser lasts as long as the
  WebSocket. The launch warning names the cases that can keep billing after
  disconnect. A box started with `boxes start` is billed until `boxes stop`
  (or the provider's own timeout), even if BetterWright is not attached.

Provider credentials (the API key, and any credentials embedded in the CDP
URL) are registered with the worker's redaction set at launch, so they appear
as `[redacted]` in every result envelope, event, and artifact path.

## `sessionOptions`

For REST-minting launches (Kernel, Browserbase, Anchor, Hyperbrowser) and for
`boxes start` on every REST-lifecycle provider, `sessionOptions` is sent as
the create-session body verbatim, so new provider features (proxy geography,
keepAlive, profile IDs, screen size) work without a BetterWright release.
`sessionOptions.sessionId` (or `id`) on a REST-lifecycle provider GETs that
box and attaches instead of minting. For connect-URL launches (Browser Use
and Steel without a session id, plus Browserless and Oxylabs) selected fields
become query parameters as documented above.

## Doctor

`betterwright doctor` reports the resolved provider under **Browser →
Provider** — the kind, the provider name, and the masked endpoint — and marks
remote providers as `warn` so the guard-proxy boundary is never invisible.
