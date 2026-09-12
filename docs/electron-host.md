# Embedding BetterWright in Electron

Import `betterwright/electron` only in Electron's main process. Electron is an
optional peer, not part of the managed browser's runtime. Install the optional
`ws` dependency when using this adapter.

```js
import { app, BrowserWindow } from "electron";
import { BetterWright } from "betterwright";
import { configureElectronNetwork, createElectronHostTarget } from "betterwright/electron";

configureElectronNetwork(); // Before app.ready.
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    webPreferences: {
      partition: "persist:agent-browser",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await window.webContents.loadURL("about:blank");
  const takeover = new AbortController();
  const browser = new BetterWright({
    hostTarget: createElectronHostTarget({
      contents: window.webContents,
      signal: takeover.signal,
    }),
    headless: false,
    parkBackgroundPages: false,
  });
  // Batch known steps; each call returns one result, not duplicated text/JSON.
  await browser.run("await page.goto('https://example.com'); return await page.title();");
  await browser.close(); // Disconnects; does not close the window.
});
```

## Ownership and Network Safety

- Use a dedicated session. The adapter rejects sessions already used by another
  WebContents or active lease. Do not add unrelated windows to it later.
- Load at least `about:blank` before connecting, so the renderer exists.
- The session uses BetterWright's policy-checked SOCKS proxy, including loopback
  traffic. Existing connections are closed before attachment. QUIC and
  nonproxied WebRTC UDP are disabled before Electron starts.
- The CDP endpoint is loopback-only, authenticated, single-client and single-tab.
  Global tab creation, tab closure, certificate overrides and unrestricted
  cookie access are denied. There is no global debugging port.
- After disconnect, the session still points at the closed guard, rather than
  silently falling back to direct traffic. Reconnect before reusing it online.
- If attachment fails or the debugger detaches, the next explicit browser run
  can reconnect after the previous connection drains. No failed action is replayed.
  Replacing a revoked connection restarts the worker and resets its in-memory
  snippet state; the host tab survives.
- Downloads are denied. Popup presentation, window layout, preview bounds,
  navigation chrome and native authentication belong to the host application.
  Adopt a popup through a separate host-controlled connection and session, not
  an unrestricted browser CDP endpoint.

## Input, Clipboard and Cancellation

Hidden views temporarily disable background throttling during a run. Native
input is serialized, uses the page's zoom factor, focuses the exact guest and
restores previous focus. Copy/paste uses the system clipboard; no clipboard
contents are automatically returned to the model. Do not blanket-grant web
pages clipboard-read permission.

Connect the host's human-takeover detector to an AbortController. Use
`expectAgentInput` to exclude only matching dispatched events from that detector,
not all input during automation. Abort stops the worker and drains the target
connection before returning. It never retries. `effectMayHaveCommitted` warns
that an action already sent to the page cannot be undone. Create a new signal
and target for an explicitly authorized resume.

File uploads require the same exact absolute staged paths in the adapter's
`uploadFiles` and BetterWright's `hostUploadFiles`. Symlinks, arbitrary paths and
in-memory file payloads are rejected. Keep staged files private and immutable
until the operation finishes.

`page.pdf()` uses Electron's native printing API, including custom paper sizes,
margins, headers, footers, tagging and outlines. PDF streams belong only to the
leased page. At most 16 streams and 100 MiB of PDF data can remain open; closing a
stream or disconnecting releases its retained data. Printing child targets is
not supported.

## Credentials

Host-owned pages outlive the worker. Their credential API is metadata-only;
trusted host code must own filling and submission. Do not move credentials into
model-authored JavaScript, even temporarily. `betterwright/capture` exposes the
capture engine for a trusted host's Playwright context, including a metadata-only
native save prompt callback. Await `dispose()` before installing a replacement.

`LocalCredentialVault({keyProvider})` accepts a fresh 32-byte `Uint8Array` or
`Buffer` from a host key store. BetterWright zeroes the supplied storage and does
not write it to disk. Keep captured secrets in the host's redaction set using
`trackRedactionSecret`; reset only after their pages are destroyed.

## Verification

Run `bun run test` for the managed browser suite, `bun run test:electron` for the
isolated Electron fixture, and `bun run test:electron:packaged` for ASAR. The
latter tests hidden input, zoom, batching, clipboard, approved uploads, network
denial, cancellation and tab survival. It writes a synthetic proof image to
`artifacts/electron-e2e/native-browser.png`. No personal browser profile or real
account is required.

The existing `full-stack-e2e-review` skill and proof screenshot support remain
available. Hosts still implement their own subagent scheduling and chat image
rendering; BetterWright supplies browser evidence, not a chat UI.

## Migrating from `hostOwnedTarget` + `provider` (2.4.x)

2.4.x accepted a hand-rolled loopback CDP bridge:

```js
const connection = await openMyConnection(contents); // host code
const browser = new BetterWright({
  provider: connection.provider,   // { cdpUrl, headers }
  hostOwnedTarget: true,
  downloadPolicy: "deny",
  credentialCapture: false,
});
```

Since 2.5.0 the adapter owns that bridge. The equivalent is:

```js
configureElectronNetwork(); // before app.ready
const browser = new BetterWright({
  hostTarget: createElectronHostTarget({ contents, signal: takeover.signal }),
  headless: false,
  parkBackgroundPages: false,
});
```

Behavior differences to expect:

- The leased session's traffic now passes through BetterWright's policy-checked
  SOCKS guard (`session.setProxy`), including subresource loads that bypass
  Playwright routing. The old `provider:` path was the documented guard
  exception; the adapter closes it. `configureElectronNetwork()` must run
  before `app.ready` so QUIC and non-proxied WebRTC UDP cannot leak around it.
- `downloadPolicy: "deny"` and `credentialCapture: false` are implied on host
  targets and no longer need to be passed. Downloads are denied by the adapter
  itself (`will-download`), before the worker's CDP byte limit.
- `hostUploadFiles` still applies, matched against the adapter's `uploadFiles`.
- `syncCookies` works on a leased tab with `cookieImport: true` in the adapter
  options; it needs no `cloudConsent`, reports `target: "host"`, and returns
  `cookieImportDomains` for scoping the granted session access.
- `browser.run(code, { automaticUI: false })` omits the automatic UI catalog
  on calls that do not need it; it defaults to on.
- The hand-rolled bridge (capability-authenticated loopback WebSocket, CDP
  allowlist, per-tab cookie scoping) is upstream's `electron-connection.ts` —
  delete the local copy once migrated.
