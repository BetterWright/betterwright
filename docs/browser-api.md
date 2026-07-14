# The browser API

The string you pass to `run()` executes as an async function inside the worker's
sandbox. This page documents what that code can use: the globals, the helpers,
the return-value handling, and the parts of the Playwright API that are
deliberately removed.

```python
bw.run("""
  await page.goto('https://news.ycombinator.com');
  const titles = await page.locator('.titleline > a').allInnerTexts();
  return titles.slice(0, 5);
""")
```

## Return values

- A single trailing **expression** is returned automatically:
  `bw.run("return page.title()")` and `bw.run("page.title()")` are equivalent.
- A multi-statement block must use `return`.
- The value is serialized to JSON. Playwright handles (`Page`, `Locator`) are
  summarized rather than serialized whole — a `Page` becomes
  `{type: "Page", pageId, url, title, closed}`.
- Large results are spilled to an artifact file and replaced with a
  `{truncated: true, preview, fullOutputPath}` summary. On the Python client,
  `RunResult.truncated` flags this.

## Pages

| Global | Description |
| --- | --- |
| `page` | The current page. Always points at the active page for this session. |
| `pages` | Live array of open pages in this session. |
| `openPage(url?, options?)` | Open a new page, optionally navigating. Returns the page. |
| `usePage(idOrIndex)` | Make another page current; accepts a `pageId` or an index. |
| `closePage(idOrIndex?)` | Close a page (the current one if omitted). |
| `context` | The Playwright `BrowserContext`, with mutating methods removed (see below). |

Pages persist across `run()` calls within the same session, so an agent can
open a tab in one step and act on it in the next. Popups and
`target=_blank` links are adopted automatically and appear in `pages`.

```js
// Work two tabs at once
const [a, b] = await Promise.all([
  openPage('https://example.com'),
  openPage('https://example.org'),
]);
return { a: await a.title(), b: await b.title() };
```

## Reading the page

`snapshot(options?)` returns an accessibility-tree snapshot of the current page —
a compact, model-friendly view far cheaper than full HTML. Every element carries
a `[ref=eN]` marker you can act on directly with an `aria-ref` locator, so there
is no need to reverse-engineer a CSS selector from the snapshot:

```js
return await snapshot({interactive: true}); // "page page-1 https://…\n- button \"Sign in\" [ref=e12]…"
// then, in a later run:
await human.click(page.locator('aria-ref=e12'));
```

Refs are assigned fresh on every snapshot and go stale when the page changes —
re-snapshot after navigations or re-renders before using one.

| Option | Default | Notes |
| --- | --- | --- |
| `interactive` | `false` | Keep only actionable elements (buttons, links, inputs, `cursor: pointer`, …) plus their ancestors. The cheapest way to see what you can do on a page. |
| `diff` | `false` | Return only the `+`/`-` lines changed since the previous same-shaped snapshot of this page, or `(no changes since previous snapshot)`. |
| `selector` | — | Scope the snapshot to a CSS selector, e.g. `{selector: '#main'}`. |
| `depth` | — | Limit tree depth. |
| `maxChars` | `10000` | Truncation limit, capped at 20000. |
| `timeout` | `10000` | Milliseconds. |

Prefer `snapshot({interactive: true})` for deciding what to click and
`snapshot({diff: true})` for checking what an action changed; take a full
`snapshot()` only when you need to read page content wholesale. For anything
Playwright can read — text, attributes, computed state — use the normal
`page.locator(...)` API.

## Human-shaped interactions

The frozen `human` global emits visible actions with curved pointer movement,
bounded key timing, and eased wheel steps instead of machine-perfect bursts:

```js
await human.click(page.getByRole('button', {name: 'Continue'}));
await human.type('#email', 'person@example.com');
await human.scroll(650); // negative values scroll upward
```

`human.click(target, options?)` and `human.type(target, text, options?)` accept a
selector, Locator, ElementHandle, or `{x, y, width, height}` bounds. Typing clears
the field by default; pass `{clear: false}` to append, or set `minDelay` and
`maxDelay`. `human.scroll(deltaY, options?)` accepts `steps`, while the object
form also accepts `deltaX`.

These helpers reduce behavioral false positives; they do not make stock
Chromium undetectable. Keep one stable persistent profile, avoid bursty public
search traffic, and respect a site's rate limits.

## Screenshots and artifacts

![A completed task with a proof checkmark and captured screenshots](assets/proof.png)

`screenshot(options)` captures the current page and records it as an artifact.

| Option | Default | Notes |
| --- | --- | --- |
| `kind` | `"debug"` | `"proof"`, `"question"`, or `"debug"` — how the host UI should treat it. |
| `name` | `"<kind>.png"` | A `.png`/`.jpg` extension is added if you omit one. |
| `fullPage` | `false` | Capture the full scrollable page. |
| `type` | `"png"` | `"png"` or `"jpeg"`. |
| `quality` | `80` | JPEG only. |

It returns `{kind, path, media}` where `media` is `MEDIA:<absolute path>`. The
`MEDIA:` convention lets a host surface render the file when the agent cites it.
To feed a screenshot straight to a vision model, use the Python client's
`RunResult.screenshots()` and `Artifact.data_url()` (a `data:image/png;base64,…`
URL); the MCP server already returns screenshots as native image content. Never
hand a host the non-image artifacts from `RunResult.files()` (downloads, spilled
output) as images — that is what triggers "unsupported image MIME type" errors.
The image kinds carry intent:

- **`proof`** — evidence a task reached its visible end state. Capture one before
  claiming success.
- **`question`** — the state behind a question you are asking the user (an MFA
  prompt, an ambiguous choice). The session holds its pages open longer while a
  `question` is outstanding.
- **`debug`** — a look at the current state; no special handling.
- **`captcha`** — a tightly cropped text challenge from `captcha.readText()`.

`artifactPath(name)` returns a writable path inside the session's artifact
directory for files you create yourself (a `page.pdf({path})`, for example).
Writes are confined to that directory.

Artifacts are subject to a per-session quota (100 MB by default); the oldest are
evicted first, and a warning is recorded when that happens.

## Bot-challenge detection

Every result envelope includes a `challenges` list. When a page visibly presents
a CAPTCHA or bot check, BetterWright records its page, provider, URL, and routing
advice there and repeats the advice in `warnings`. It does not act automatically.
Agents should not retry the page or rotate through public search engines; use a
host-provided research tool, navigate directly to a first-party site, or make one
native attempt when that page is truly required.

The `captcha` global provides:

- `captcha.click(bounds)` for a checkbox-style widget.
- `captcha.drag(from, to, {steps})` for a slider or puzzle handle.
- `captcha.readText(bounds?)` for a cropped image that the host model can read.

Click and drag return a post-action accessibility snapshot. Always check the
result envelope's `challenges` list and stop if the challenge remains. See
[captcha.md](captcha.md) for recipes and limits.

## State

`state` is a plain object that persists across `run()` calls within a session —
somewhere to stash a value you computed in one step and need in the next. It is
per-session and never leaves the worker.

```js
state.startedAt = Date.now();          // step 1
return Date.now() - state.startedAt;   // a later step
```

## Dialogs

`alert`/`confirm`/`prompt` dialogs are handled by preparing a response before
the action that triggers them:

```js
dialogs.acceptNext("optional prompt text");   // or dialogs.dismissNext()
await page.click («the button that opens the dialog»);
```

## Credentials

The `credentials` helpers manage non-secret metadata in the
[encrypted vault](credentials.md). Secret-bearing fill operations are disabled
inside model-authored `run()` snippets.

```js
await credentials.save({ username: "alice", password: "…" });
await credentials.list();                          // metadata only, no passwords
await credentials.update({ id, label: "work" });
await credentials.remove({ id });
```

All operations are scoped to the current page's origin, which must be `http(s)`.
See [credentials.md](credentials.md) for the full contract.

## Console

`console.log/info/warn/error` from your snippet are captured (not printed to a
terminal) and returned alongside the result — up to 20 messages. Page-side
`console` events are not captured here; read them with Playwright's
`page.on(...)` equivalents via explicit waits if you need them.

## What is removed

Model code gets Playwright's page-driving surface, not the APIs that would let
it escape the policy or read the host. These are absent by design and return
`undefined` (or throw) if accessed:

- **Interception and eventing** — `route`, `routeWebSocket`, `unroute`, `on`,
  `once`, `addListener`, `exposeFunction`, `exposeBinding`, `newCDPSession`.
  Request routing is how the policy is enforced; handing it to model code would
  defeat it.
- **Context mutation** — `context.newPage`, `context.cookies`,
  `context.storageState`, `context.close`, `context.tracing`. Use `openPage`.
- **`page.screenshot`** — use the `screenshot()` helper so captures are tracked
  as artifacts.
- **Filesystem reach** — `setInputFiles`, `FileChooser.setFiles`,
  `addInitScript({path})`, and tag helpers can only read existing files inside
  BetterWright's artifact directory. Browser-created files can only be written
  there.
- **Node internals** — there is no `process`, `require`, `import`, or `fs`. The
  snippet runs in a `node:vm` context with code generation disabled.

The [architecture doc](architecture.md) explains why this is defense in depth
layered on top of the browser-level controls, not a claim that the `vm` boundary
is itself a security boundary.
