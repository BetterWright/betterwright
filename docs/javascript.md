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
  policy,           // a NetworkPolicy; default: safe policy
  vault,            // optional { handleRequest(action, payload, origin), redact? }
  browser: "cloak", // managed default; "chromium" is the explicit fallback
  executablePath,   // explicit binary; also selects the Chromium fallback
  headless: "auto", // visible with a display, headless on servers/CI
  connectOverCdp,   // host-only attach endpoint; see attach mode
  publicSearchPolicy: "allow", // default; set "block" to force host-tool search
  searchMinIntervalMs: 0,
  defaultTimeout: 30,   // per-snippet seconds, min 5
  downloadPolicy: "ask", // "ask" (default), "allow", or "deny"
});
```

The managed Cloak backend is the default. It keeps BetterWright's persistent
profile and policy while reducing common stock-browser automation signals; it
does not guarantee undetectability. `browser: "chromium"` is useful for tests
and compatibility, but stock Chromium exposes more automation signals. Set
`BETTERWRIGHT_BROWSER` to choose a process-wide default.

Public Google, Bing, and DuckDuckGo result UIs are permitted by default; prefer
routing broad discovery through the host's search tool anyway, and set
`publicSearchPolicy: "block"` (or `BETTERWRIGHT_PUBLIC_SEARCH_POLICY=block`) to
have the worker enforce that. `searchMinIntervalMs` spaces public-search
navigations while they are permitted.

`connectOverCdp` is a trusted host configuration option, not part of the browser
tool given to the model. Model-authored snippets cannot access CDP, the raw
browser object, or `newCDPSession`.

| Method | Description |
| --- | --- |
| `run(code, { session, note, timeout, approvedDownloads }) => Promise<envelope>` | Execute one snippet. Calls are queued and run one at a time. |
| `close() => Promise<void>` | Shut the worker down. Idempotent. |
| `policy` | The active `NetworkPolicy`. |

There is no context-manager sugar in JS — call `close()` in a `finally`.

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
| `result` | The snippet's return value. |
| `error` | Error message when `ok` is `false`. |
| `console` | Captured `console.*` calls. |
| `events` | Page lifecycle events. |
| `artifacts` | `[{ kind, path, media, size? }]`. |
| `pages` | Open pages, each summarized. |
| `challenges` | Visible CAPTCHA/bot checks with page, provider, URL, and routing advice. |
| `warnings` | Non-fatal notices. |
| `durationMs` | Time spent in the worker. |

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

For long-lived desktop agents, `ensureChromeCdp()` can start or reuse a dedicated
Google Chrome profile for host-controlled attach mode. For broad discovery, use
the host's web-search tool and open returned results in BetterWright instead of
automating Google or Bing's public search UI. See [attach mode](attach-mode.md).

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
`captcha.drag(from, to)`, and `captcha.readText(bounds)`. Detected challenges
also attach a `captcha` image automatically. Treat a challenge as resumable:
inspect the fresh result after each action. A rejection at the same stage
requires an immediate alternate first-party source or human handoff; otherwise,
continue through at most three distinct stages before taking that handoff. When
the challenge clears, verify current application state and replay the original
action only if it is idempotent or state proves it did not already complete.
Never duplicate a submission, purchase, or message. No solver dependency or API
key is required. See [captcha.md](captcha.md).

### Human-shaped actions

Use `human.click(target)`, `human.type(target, text)`, and `human.scroll(deltaY)`
for visible UI actions that should not arrive as perfectly timed bursts. See the
[browser API](browser-api.md#human-shaped-interactions) for accepted targets and
options.

## `NetworkPolicy`

```js
new NetworkPolicy({
  allowPrivateNetwork: false,
  allowLoopback: false,
  allowHosts: [],
  blockHosts: [],
  blockSecretBearingUrls: true,
  custom,                    // (url, details) => decision | null
});
```

`policy.check(url, details) => { allowed, reason? }`. The rules are documented
in [network-policy.md](network-policy.md).

## Providing a vault

The JS client has no built-in credential store. To enable non-secret
`credentials` management helpers inside snippets, pass an object implementing
the vault RPC contract:

```js
new BetterWright({
  vault: {
    async handleRequest(action, payload, origin) { /* list|save|update|remove */ },
    redact(value) { return value; },   // optional: scrub secrets from output
  },
});
```

To fill a login or signup form, the vault must handle the `fill`
(and, for `generateAndFillCredential`, `generate`) action returning a `secret`;
call `bw.fillCredential({...})` / `bw.generateAndFillCredential({...})` from host
code, which types the password and any `confirmPasswordSelector` outside the
sandbox and returns only metadata. Secret-bearing fill methods fail inside
`run()`. Omit `vault` to run without credential management helpers.

## Sessions

Pass `{ session: "name" }` to `run()`. Each session is an isolated set of pages
and `state`; snippets in the same session share tabs across calls.

```js
await bw.run("await page.goto('https://a.example')", { session: "a" });
await bw.run("await page.goto('https://b.example')", { session: "b" });
```

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
