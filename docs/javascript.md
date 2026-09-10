# JavaScript API reference

```js
import { BetterWright, NetworkPolicy, BrowserError } from "betterwright";
```

The package is ESM (`"type": "module"`). Use `import`, or `await import()` from
CommonJS.

## `BetterWright`

```js
new BetterWright({
  home,             // state dir; default $BETTERWRIGHT_HOME or ~/.betterwright
  profile,          // optional named identity; sessions within it share cookies
  policy,           // a NetworkPolicy; default: safe policy
  vault,            // optional { handleRequest(action, payload, origin), redact? }
  browser: "chromium-fork", // the managed BetterChromium fork (the default)
  provider: undefined, // bring your own: { executablePath } | { cdpUrl } |
                       // { provider: "browserbase", apiKey } — see
                       // docs/browser-providers.md
  headless: "auto", // visible with a display, headless on servers/CI
  publicSearchPolicy: "allow", // default; set "block" to force host-tool search
  searchMinIntervalMs: 0,
  defaultTimeout: 30,   // per-snippet seconds, min 5
  downloadPolicy: "ask", // "ask" (default), "allow", or "deny"
  stealthRuntimeFix: false, // isolated-world driver; evades main-world detection
  parkBackgroundPages: true, // pause idle headless pages between calls
});
```

The default browser is the managed [Chromium fork](chromium-fork.md)
artifact, installed by `betterwright setup` on macOS arm64 / Linux x64 /
Windows x64. `provider` swaps in a caller-supplied local Chromium binary
(still on the guard proxy) or a remote CDP browser from a cloud provider
(outside it — the launch warning says so). Headed and headless modes keep
BetterWright's persistent profile and policy while reducing common
stock-browser automation signals; they do not guarantee undetectability.

Public Google, Bing, and DuckDuckGo result UIs are permitted by default; prefer
routing broad discovery through the host's search tool anyway, and set
`publicSearchPolicy: "block"` (or `BETTERWRIGHT_PUBLIC_SEARCH_POLICY=block`) to
have the worker enforce that. `searchMinIntervalMs` spaces public-search
navigations while they are permitted.

Ad and tracker blocking is on by default. Pass `adBlock: false` to disable it;
an explicit option overrides `BETTERWRIGHT_AD_BLOCK`. First enabled use downloads
the filter lists, and blocking disables service workers in new contexts without
weakening network policy. See [ad blocking](ad-blocking.md) for caching and
restart requirements.

Idle headless pages are parked after a short delay between calls by default.
Timers, animation frames, and animation timelines pause while parked and resume
before the next execution. Set `parkBackgroundPages: false` or
`BETTERWRIGHT_PARK_BACKGROUND_PAGES=0` if the application must keep progressing
between calls. Headed sessions, sessions with a live view, and actively recording
pages are not parked.

To control a host-owned Electron tab instead of launching a managed browser,
pass a `hostTarget` created by `betterwright/electron`. The adapter keeps the
tab on the network guard and leaves its lifetime with the host. See
[Electron hosting](electron-host.md) for the required dedicated session,
pre-start network configuration, approved uploads, and cancellation setup.

Model-authored snippets cannot access CDP, the raw browser object, or
`newCDPSession`.

`stealthRuntimeFix` (off by default; also `--stealth` or
`BETTERWRIGHT_STEALTH_RUNTIME_FIX=1`) runs every snippet in an isolated world via
the optional `patchright-core` driver, so `page.evaluate` no longer trips
main-world automation detection. The managed fork already hides the
`Runtime.enable` and `navigator.webdriver` signals; this closes the remaining
main-world-execution vector. Trade-off: snippets can no longer read page-defined
main-world globals (e.g. `window.__NEXT_DATA__`, `dataLayer`) — DOM queries,
clicks, and typing are unaffected, and a run warning flags when it is active.
Install the optional dependency (`npm install patchright-core`) to use it;
`betterwright doctor` reports `stealth_available`.

| Method | Description |
| --- | --- |
| `run(code, { session, note, timeout, approvedDownloads, signal }) => Promise<envelope>` | Execute one snippet. Calls within a session are queued; different sessions may execute concurrently. |
| `close() => Promise<void>` | Shut the worker down. Idempotent. |
| `closeSession(session?) => Promise<{ ok, closed, pagesClosed, error? }>` | Close one session's pages and forget its state without closing other sessions or the browser. |
| `syncCookies(options) => Promise<CookieSyncResult>` | Import cookies from a local browser into this identity. See [Cookie Sync](cookie-sync.md). |
| `startLiveView(options?) => Promise<LiveViewStatus>` | Start or reuse a live viewer; returns its URL and status. See [live view](live-view.md). |
| `stopLiveView()`, `liveViewStatus() => Promise<LiveViewStatus>` | Stop the viewer or read its status. |
| `waitForHandoff(options?) => Promise<HandoffResult>` | Wait for a human to finish or cancel a live-view handoff. |
| `waitForAsk(options?) => Promise<AskResult>` | Wait for a human's answer in live-view chat. |
| `liveViewPostChat(options?) => Promise<{ ok, message?, error? }>` | Post a chat message to the live viewer. |
| `liveViewDrainChat() => Promise<LiveViewDrainChatResult>` | Read and drain pending human chat messages. |
| `vaultStatus() => Promise<status>` | Read vault availability and protection state without unlocking it. |
| `unlockVault({ password }) => Promise<status>` | Unlock this browser's vault instance from a trusted host. Never expose the password to model code. |
| `lockVault() => Promise<status>` | Revoke cached unlocks across processes sharing the master-protected vault directory. |
| `policy` | The active `NetworkPolicy`. |

Call `close()` in a `finally`, or use `withBrowser` from
[`betterwright/sdk`](sdk.md) to own that lifetime for you.

### Cancellation

Pass an `AbortSignal` as `run(code, { signal })`. If the signal is already
aborted before dispatch, the snippet does not execute. Aborting dispatched
work stops and drains the worker; other in-flight sessions in that worker
also stop. The client remains reusable, but the managed browser context and
in-memory session state are lost, as on a [timeout](sdk.md#errors-timeouts-and-the-worker).

Cancellation failures carry an `errorCode`, normally `BW_ABORTED`. A
dispatched operation reports `effectMayHaveCommitted: true`: cancellation
cannot undo a submission, payment, or other effect already performed by the
page. Verify application state before replaying an interrupted operation.

### Download approval

`downloadPolicy: "ask"` is the default. Ordinary `run()` calls execute while
browser downloads are denied. A trusted host must obtain explicit user approval
first and then mark only that run with `{ approvedDownloads: true }`:

```js
if (await hostUi.confirm("Allow this download?")) {
  await bw.run("await page.locator('#download').click()", {
    approvedDownloads: true,
  });
}
```

Use `downloadPolicy: "allow"` to remove the approval gate while keeping byte and
artifact quotas. Use `"deny"` to block downloads even from approved runs. The
approval bit is worker transport metadata; model-authored browser code cannot set
it from inside the sandbox.

### The result envelope

`run()` resolves with the worker's envelope directly:

| Field | Description |
| --- | --- |
| `ok` | Whether the snippet completed. |
| `result` | The bounded summary of the snippet's return value, or a spill-file descriptor. See [return values](browser-api.md#return-values). |
| `error` | Error message when `ok` is `false`. |
| `errorCode` | Optional machine-readable error code, such as `BW_ABORTED` for cancellation. |
| `effectMayHaveCommitted` | Cancellation cannot undo page effects; `true` means dispatched work may already have performed them. |
| `console` | Captured snippet `console.*` calls. Page-side logs use `page.on("console")`. |
| `events` | Page lifecycle events. |
| `artifacts` | `[{ kind, path, media, size? }]`. |
| `pages` | Open pages, each summarized. |
| `challenges` | Visible CAPTCHA/bot checks with page, provider, URL, and routing advice. |
| `warnings` | Non-fatal notices. |
| `webagents` | One-time compact action directory when the active origin supports WebAgents. |
| `ui` | Optional compact semantic action directory or bounded failure evidence. |
| `skills` | Optional metadata hints for skill packs matching an open page. |
| `profileMode` | Whether the browser is using a persistent or ephemeral profile. |
| `pendingCredential` | Secret-free recovery metadata for an interrupted generated credential. |
| `envelopeTruncated` | Present when the envelope was reduced to fit transport limits. |
| `durationMs` | Time spent in the worker. |

In TypeScript, a successful `run<T>()` envelope has `result: T | SpilledRunOutput`,
not unconditionally `T`. `SpilledRunOutput` is exported as a type from both
`betterwright` and `betterwright/sdk`. After checking `ok`, narrow the result
before using it; for a string result:

```ts
const output = await bw.run<string>("return page.title()");
if (!output.ok) throw new BrowserError(output.error);
if (typeof output.result === "string") {
  console.log(output.result);
} else {
  console.log(output.result.preview, output.result.fullOutputPath);
}
```

```js
const bw = new BetterWright();
try {
  const r = await bw.run("await page.goto('https://example.com'); return page.title()");
  if (!r.ok) throw new BrowserError(r.error);
  console.log(r.result);                    // "Example Domain"
  const shot = await bw.run("return screenshot({ kind: 'proof' })");
  console.log(shot.artifacts[0].media);     // "MEDIA:/…/proof-….png"
} finally {
  await bw.close();
}
```

For broad discovery, use the host's web-search tool and open returned results in
BetterWright instead of automating Google or Bing's public search UI. See
[headed and headless browsing](attach-mode.md).

### Pi tool-result images

Pi custom tools expect image content as top-level `data` and `mimeType` fields,
not the `source` wrapper used by Pi user messages. The adapter keeps that detail
out of extension code and ignores downloads or spilled JSON artifacts:

```js
import { piImageContent } from "betterwright/pi";

const result = await bw.run("return screenshot({ kind: 'proof' })");
return {
  content: [
    { type: "text", text: JSON.stringify(result) },
    ...(await piImageContent(result)),
  ],
  details: {},
};
```

### Native CAPTCHA helpers

Browser snippets receive `captcha.inspect(bounds?)`, `captcha.click(bounds)`,
`captcha.clickTiles(indexes)`, `captcha.drag(from, to)`, `captcha.readText(bounds)`,
and `captcha.solve({ tiles })`. Detected challenges also attach a `captcha` image
automatically. For an image grid, open the numbered crop and call
`captcha.solve({ tiles: [indexes] })`. Treat a challenge as resumable:
inspect the fresh result after each action. Replacement photo grids are the
same image-grid stage — keep picking. A rejected Verify requires an immediate
alternate first-party source or human handoff; otherwise continue through at
most three distinct challenge types before taking that handoff. When
the challenge clears, verify current application state and replay the original
action only if it is idempotent or state proves it did not already complete.
Never duplicate a submission, purchase, or message. No solver dependency or API
key is required. See [captcha.md](captcha.md).

### Human-shaped actions

Use `human.click(target)`, `human.type(target, text)`, and `human.scroll(deltaY)`
for visible UI actions that should not arrive as perfectly timed bursts. See the
[browser API](browser-api.md#human-shaped-interactions) for accepted targets and
options.

### Page-published tools

For an origin that publishes `/webagents.md`, call
`webagents.discover()` and submit a bounded operation DAG with
`webagents.batch()`. This can replace a sequence of browser/model turns with one
same-origin workflow request. Writes require `allowWrites: true`; use ordinary
WebMCP or browser interaction when discovery reports `available: false`. See
the [WebAgents browser API](browser-api.md#batch-native-webagents-workflows).

When neither protocol is present, the first navigation result includes a
compact `ui` action directory. Copy its normalized targets into one
`controls.batch()` transaction; state changes return refreshed controls and
visible evidence. Use an interactive snapshot only if the directory omitted a
required target. The helper retains Playwright auto-waiting, rejects ambiguity
and password fills by default, requires explicit write opt-in, and accepts a
mutation only when the final `read`/`readUrl` supplies and observes a non-empty
expected value. See
[semantic UI batches](browser-api.md#semantic-ui-batches-for-ordinary-sites).

Use `webmcp.tools()` to discover typed tools registered by the current page and
`webmcp.invoke(name, input, options)` to call one. BetterWright refreshes the
tool list before invocation, fails closed on ambiguous frames or an unapproved
`autosubmit` annotation, labels every page-controlled result as untrusted, and
cancels timed-out calls. See the
[WebMCP browser API](browser-api.md#page-published-webmcp-tools).

## `NetworkPolicy`

```js
new NetworkPolicy({
  allowPrivateNetwork: false,
  allowLoopback: false,
  allowHosts: [],
  blockHosts: [],
  custom,                    // (url, details) => decision | null
});
```

`policy.check(url, details) => { allowed, reason? }`. The rules are documented
in [network-policy.md](network-policy.md).

## Credential vault

`new BetterWright()` enables the encrypted local vault under
`$BETTERWRIGHT_HOME/vault` by default. Agent code can search metadata and use
selector-free form detection without receiving a secret:

```js
await bw.run(`
  const accounts = await credentials.list({text: "work"});
  if (!accounts.length) return {filled: false, reason: "no-match"};
  if (accounts.length > 1) return {filled: false, reason: "ambiguous", accounts};
  return credentials.fill({id: accounts[0].id, submit: true});
`);
```

For signup or rotation, `generateAndFill` returns an opaque pending id. Verify
the site's success state before calling `commitGenerated`; call
`discardGenerated` after a failure. `listPending()` recovers secret-free
provisional metadata after an interrupted host process. See
[credentials.md](credentials.md).

Pass a custom object to replace the local store with another secret source:

```js
new BetterWright({
  vault: {
    async handleRequest(action, payload, origin) {
      /* list|list-pending|save|update|remove|fill|generate|commit|discard */
    },
  },
});
```

A custom adapter may also provide `redact(value)` as a second host-side
scrubbing pass. It must actually replace every secret the adapter has returned;
omit the hook rather than implementing a no-op.

`bw.fillCredential({id, submit: true})` and
`bw.generateAndFillCredential({...})` use the same worker-side detection. A host
commits or discards generated values after verification with
`commitGeneratedCredential()` / `discardGeneratedCredential()`, and recovers
interrupted attempts with `listPendingCredentials()`. Use explicit
selectors only when detection reports ambiguity. Rotation forms can pin
`currentPasswordSelector`, `passwordSelector`, and `confirmPasswordSelector`
together. Set `vault: false` (or `null`) to disable credential helpers entirely.

### Reading secrets back (trusted hosts only)

For a master-protected local vault, unlock the instance before reading records.
Trusted hosts can call `ownerSetupMaster(password)`, `ownerUnlock(password)`,
`ownerLock()`, and `ownerStatus()` on the local vault object. The default unlock
lifetime is 15 minutes; `createLocalCredentialVault({ autoLockMs })` configures
it, and `dispose()` clears cached key material while preserving redaction.
Separate SDK instances must unlock independently; CLI `vault unlock` unlocks
only the selected persistent daemon, not every SDK process. Locking prevents
subsequent vault access but does not sign out existing browser sessions.

`ownerSettings()` and `ownerConfigure({ agentUse, offerSave, autosave })` manage
saved-login preferences. Human autosave requires capture (`offerSave`) to be
enabled; agent access and human saving are independent. See
[master-password controls](credentials.md#master-password-and-lock-state) for
setup, backup requirements, and the trusted-input boundary.

Everything above is deliberately incapable of returning a secret. When your
host needs to act for the *person* who owns the vault — the same job
[`betterwright vault`](credentials.md#getting-a-password-back-betterwright-vault)
does — the local vault object exposes an owner-only API:

```js
import { createLocalCredentialVault } from "betterwright/vault";

const vault = createLocalCredentialVault({ home: process.env.BETTERWRIGHT_HOME });

const { credentials, pendingCredentials } = await vault.ownerList({ query: "github" });
const { secret } = await vault.ownerReveal(credentials[0].id);   // audited
await vault.ownerRemove(credentials[0].id);
const { entries } = await vault.ownerAudit({ limit: 50 });
```

These are **not** part of `handleRequest`, so the browser worker — and
therefore model-authored snippet code — cannot reach them however a snippet is
written. Never surface them as a model-callable tool, and never put a revealed
value into a prompt, a log, or a tool result. `ownerReveal` writes an
`owner-reveal` entry to the metadata-only audit log; a custom vault adapter
does not need to implement any of this.

## Sessions

Pass `{ session: "name" }` to `run()`. Each session is an isolated set of pages
and `state`; snippets in the same session share tabs across calls. Calls are
ordered within each session, while separate sessions may run concurrently.
Sessions share the browser's cookie jar and identity: they are separate work
lanes, not separate logins.

```js
await bw.run("await page.goto('https://a.example')", { session: "a" });
await bw.run("await page.goto('https://b.example')", { session: "b" });
```

Use `new BetterWright({ profile: "work" })` for a separate persistent browser
identity. Profiles have separate cookie jars, but share the home directory's
vault, artifacts, and browser cache. See [sessions and profiles](sessions.md).
Call `bw.closeSession("a")` to discard only that session's pages and state;
`bw.close()` shuts down the client and all its sessions.

## `agentSystemPrompt`

```js
import { agentSystemPrompt } from "betterwright";

agentSystemPrompt(guardrails?) => string
```

Operator guidance for a browser agent's system prompt. Guardrail fields:
`confirmBeforePurchase`,
`confirmBeforeIrreversible`, `forbidPurchases`, `forbidAccountCreation`,
`spendingLimit`, `extraRules`, and `passwordManager`. See
[agent-prompt.md](agent-prompt.md).
