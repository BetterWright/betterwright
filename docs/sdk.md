# The SDK entrypoint

`betterwright/sdk` is the import for driving BetterWright from your own code.
It carries the exports meant for programmatic use, plus one helper,
`withBrowser`, that owns the client's lifetime for you.

The root import, `betterwright`, is unchanged and stays the compatibility
surface. It still exports everything it always has, including lower-level
pieces most integrations never touch (CAPTCHA scoring, challenge detection,
skill loading), so existing code keeps working and nothing has to move.

## Install

```bash
npm install betterwright
npx betterwright setup    # downloads the managed BetterChromium build once
```

Node 22.18 or newer. The package is ESM, so use `import`, or `await import()`
from CommonJS.

## A complete example

```ts
import { BrowserError, withBrowser } from "betterwright/sdk";

const title = await withBrowser({ headless: false }, async (bw) => {
  await bw.run("await page.goto('https://example.com')", { note: "Opening example.com" });

  const result = await bw.run<string>("return page.title()");
  if (!result.ok) throw new BrowserError(result.error);

  await bw.run("return screenshot({ kind: 'proof', name: 'example-home' })");
  return result.result;
});

console.log(title);
```

`withBrowser` constructs a `BetterWright`, awaits your function, and closes the
client in a `finally`, so the worker process and the browser are released even
when the function throws. It resolves with whatever your function returned.
Pass the callback alone, `withBrowser(fn)`, to take the default options.

The string each `run()` call takes is Playwright code, executed inside the
worker sandbox where `page`, `snapshot`, `screenshot`, `human`, and
`credentials` live. [browser-api.md](browser-api.md) documents those globals
and the result envelope `run()` returns.

## What it exports

Browser client:

| Export | What it is |
| --- | --- |
| `withBrowser(options?, fn)` | Run `fn` with a client and close that client afterwards. |
| `BetterWright` | The client itself: `run()`, sessions, live view, downloads, credential filling. Full reference in [javascript.md](javascript.md). |
| `BrowserError` | The error type to throw when a result envelope comes back with `ok: false`. |
| `validateCredentialMatchMode(value)` | Returns the value when it is one of the four credential URL scopes, and throws a `TypeError` otherwise. |

Network policy:

| Export | What it is |
| --- | --- |
| `NetworkPolicy` | The allow/deny rules a client enforces on every request. See [network-policy.md](network-policy.md). |
| `METADATA_ADDRESSES` | The cloud metadata IP addresses in the unliftable network floor. |
| `METADATA_HOSTNAMES` | The hostnames in that same floor. |

Credential vault:

| Export | What it is |
| --- | --- |
| `createLocalCredentialVault(options?)` | The encrypted local vault, including the owner-only reads behind `betterwright vault`. See [credentials.md](credentials.md). |
| `LocalCredentialVault` | The vault class, for passing an instance to the client. |
| `LocalCredentialVaultError` | The error type vault operations throw. |
| `VAULT_CATEGORIES` | The credential categories a record can use. |
| `VAULT_MATCH_MODES` | The URL scopes a stored credential can be filled on. |

Built-in agent:

| Export | What it is |
| --- | --- |
| `runAgentTask(options)` | The task loop behind `betterwright exec`: a task in, one result out. See [agent.md](agent.md). |
| `resolveModel(model, options?)` | Turn a model id, or an object with a `complete` method, into a model adapter. |
| `resolveModelSelection(model, options?)` | The same, for a bare user-typed id: it searches the running and configured endpoint catalogs and resolves only when one source has it. |

Browser providers:

| Export | What it is |
| --- | --- |
| `BROWSER_PROVIDER_NAMES` | The named cloud providers `provider: { provider }` accepts. |
| `REST_BROWSER_PROVIDER_NAMES` | The six of those with create/list/get/stop session APIs. |
| `browserProviderInfo(name)` | Display name, docs URL, API-key env var, and `lifecycle` (`rest` or `connect`), or `null`. |
| `describeCdpUrl(value)` | A CDP URL with its credentials and key-like query values masked, for logging. |
| `createProviderSession(name, options?)` | Start a managed box (`betterwright boxes start`). |
| `listProviderSessions(name, options?)` | List boxes (`betterwright boxes list`). |
| `getProviderSession(name, id, options?)` | Fetch one box. |
| `stopProviderSession(name, id, options?)` | Release a box so the provider stops billing it. |

Bringing your own browser, and what each provider changes about the guard
proxy, is covered in [browser-providers.md](browser-providers.md).

The entrypoint also exports the public types, so
`import type { BetterWrightOptions, RunResult } from "betterwright/sdk"` works
without a second import path.

## Runnable example

[examples/typescript/sdk.ts](../examples/typescript/sdk.ts) is the code above as
a file you can run with `node examples/typescript/sdk.ts`.
