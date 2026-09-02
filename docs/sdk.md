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

## Errors, timeouts, and the worker

Knowing which failures come back as a value and which ones throw is most of
what makes an integration robust.

**Anything that happened inside the browser is a value.** `run()`,
`fillCredential()`, and the live-view calls resolve with an envelope; when the
snippet threw, the page navigated away, the call timed out, or the worker died
mid-call, that envelope is `{ ok: false, error }`. Check `ok` and decide.
Throwing `BrowserError(result.error)` is the conventional way to turn one into
an exception.

**The client throws only when it cannot work at all**, and always as a
`BrowserError` (or a `TypeError` for a bad option at construction):

- the client was closed with `close()` and is then used again;
- the worker process could not start: the error says why, with the exit code
  or signal and the worker's last stderr lines (a missing module, a syntax
  error in a patched install, a permission problem), and it is raised as soon
  as the process exits rather than after a timeout;
- the worker started but never printed its ready handshake within the start
  timeout, 15 s by default. Set `BETTERWRIGHT_WORKER_START_TIMEOUT_MS` higher
  on a cold disk or a small ARM board; the hung process is killed either way.

**Timeouts restart the worker, not the browser.** Each call takes a `timeout`
in seconds (default `defaultTimeout`, 30). When it expires the worker is
restarted, the call resolves `{ ok: false, error: "Execution timed out …" }`,
and the next call spawns a replacement. Calls from other sessions that land
during that restart wait for the replacement; they are not told the browser
has been closed, because it has not. The browser profile, cookies, and
logins are on disk and survive every restart.

**Provider API calls are bounded.** A cloud-provider launch and every
`createProviderSession` / `listProviderSessions` / `getProviderSession` /
`stopProviderSession` call gives the provider 30 s and then fails with a
message that says so. A network failure names its cause
(`getaddrinfo ENOTFOUND …`, `ECONNREFUSED`).

**`withBrowser` owns the lifetime.** It closes the client whether your
function returns or throws. If your function throws and `close()` then fails
as well, your function's error is the one you see. A missing callback or a
non-object options bag is a `TypeError` before any client exists.

## Runnable example

[examples/typescript/sdk.ts](../examples/typescript/sdk.ts) is the code above as
a file you can run with `node examples/typescript/sdk.ts`.
