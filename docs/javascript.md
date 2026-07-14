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
  executablePath,   // explicit Chromium binary; otherwise CLOAKBROWSER_BINARY_PATH
  headless = true,
  defaultTimeout = 30,   // per-snippet seconds, min 5
});
```

| Method | Description |
| --- | --- |
| `run(code, { session, note, timeout }) => Promise<envelope>` | Execute one snippet. Calls are queued and run one at a time. |
| `close() => Promise<void>` | Shut the worker down. Idempotent. |
| `policy` | The active `NetworkPolicy`. |

There is no context-manager sugar in JS — call `close()` in a `finally`.

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

For long-lived desktop agents, `ensureChromeCdp()` starts or reuses a dedicated
Google Chrome profile. Pair it with `searchMinIntervalMs` to keep public-search
navigations from occurring in rapid bursts; see [attach mode](attach-mode.md).

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

Browser snippets receive `captcha.click(bounds)`, `captcha.drag(from, to)`, and
`captcha.readText(bounds)`. The first two return a fresh accessibility snapshot;
the last emits a cropped image artifact for the host model's existing vision.
No solver dependency or API key is required. See [captcha.md](captcha.md).

### Human-shaped actions

Use `human.click(target)`, `human.type(target, text)`, and `human.scroll(deltaY)`
for visible UI actions that should not arrive as perfectly timed bursts. See the
[browser API](browser-api.md#human-shaped-interactions) for accepted targets and
options.

## `NetworkPolicy`

```js
new NetworkPolicy({
  allowPrivateNetwork = false,
  allowLoopback = false,
  allowHosts = [],
  blockHosts = [],
  blockSecretBearingUrls = true,
  custom,                    // (url, details) => decision | null
});
```

`policy.check(url, details) => { allowed, reason? }`. The rules match the Python
policy exactly; see [network-policy.md](network-policy.md).

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

The method receives the same `action`/`payload`/`origin` the Python
`CredentialVault.handle_request` does, so the two can share a backend if you
expose one. Secret-bearing fill methods fail inside `run()`; use them only from
trusted host code. Omit `vault` to run without credential management helpers.

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

Operator guidance for a browser agent's system prompt — identical text to the
Python `agent_system_prompt`. Guardrail fields: `confirmBeforePurchase`,
`confirmBeforeIrreversible`, `forbidPurchases`, `forbidAccountCreation`,
`spendingLimit`, `extraRules`. See [agent-prompt.md](agent-prompt.md).
