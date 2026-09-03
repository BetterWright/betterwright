# The browser API

The string you pass to `run()` executes as an async function inside the worker's
sandbox. This page documents what that code can use: the globals, the helpers,
the return-value handling, and the parts of the Playwright API that are
deliberately removed.

```js
await bw.run(`
  await page.goto('https://news.ycombinator.com');
  const titles = await page.locator('.titleline > a').allInnerTexts();
  return titles.slice(0, 5);
`);
```

## Return values

- A single trailing **expression** is returned automatically:
  `bw.run("return page.title()")` and `bw.run("page.title()")` are equivalent.
- A multi-statement block must use `return`.
- The value is serialized to JSON. Playwright handles (`Page`, `Locator`) are
  summarized rather than serialized whole — a `Page` becomes
  `{type: "Page", pageId, url, title, closed}`.
- Large results are spilled to an artifact file and replaced with a
  `{truncated: true, preview, fullOutputPath}` summary.

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
a compact, model-friendly view far cheaper than full HTML. The header line
carries the page id, URL, and title. Every element carries a `[ref=eN]` marker
you can act on directly with an `aria-ref` locator, so there is no need to
reverse-engineer a CSS selector from the snapshot:

```js
return await snapshot({interactive: true}); // "page page-1 https://… \"Sign in\"\n- button \"Sign in\" [ref=e12]…"
// then, in a later run:
await human.click(page.locator('aria-ref=e12'));
```

The tree covers the whole page, not just the viewport: off-screen elements are
included (locator actions scroll to their target on their own, so never scroll
just to read), and child-iframe contents appear inline with frame-qualified
refs like `f1e2` that work in `aria-ref` locators exactly like main-frame refs.

Refs are assigned fresh on every snapshot and go stale when the page changes —
re-snapshot after navigations or re-renders before using one, and never guess a
ref you have not seen in the current snapshot.

Filled `<input type="password">` values are replaced with `[redacted]` in the
snapshot (username and other fields read normally), so a routine read never
pulls a just-typed or extension-filled secret into model context.

The tree is compressed before it reaches the model: bare `generic` wrappers
are unwrapped, text-only paragraphs and small text-only containers collapse to
single lines, refs and cursor hints that cannot serve as action targets are
dropped, nameless images disappear, names are capped at 100 characters, and
link `/url` lines are omitted (pass `{urls: true}` to keep them, or read an
href via `page.locator('aria-ref=eN').getAttribute('href')`). This typically
halves the size of a real page's tree without losing anything actionable.

| Option | Default | Notes |
| --- | --- | --- |
| `interactive` | `false` | Keep only actionable elements (buttons, links, inputs, `cursor: pointer`, …) plus their ancestors. The cheapest way to see what you can do on a page. |
| `diff` | `false` | Return only the `+`/`-` lines changed since the previous same-shaped snapshot of this page, or `(no changes since previous snapshot)`. |
| `ref` | — | Scope the snapshot to one element's subtree by its ref from the previous snapshot, e.g. `{ref: 'e31'}` — no CSS selector needed. |
| `selector` | — | Scope the snapshot to a CSS selector, e.g. `{selector: '#main'}`. |
| `depth` | — | Limit tree depth. |
| `urls` | `false` | Keep `- /url:` property lines on links. |
| `maxChars` | `10000` | Size limit, capped at 20000. An over-limit snapshot returns an error with the actual size and scoping hints instead of a silently cut-off tree. |
| `timeout` | `10000` | Milliseconds. |

Escalate reading only as far as the task needs: `snapshot({interactive: true})`
to decide what to click, a full `snapshot()` to read content wholesale,
`snapshot({diff: true})` to check what an action changed, and
`screenshot({annotate: true})` when only the visual layout can answer the
question. For anything Playwright can read — text, attributes, computed
state — use the normal `page.locator(...)` API.

### Same-origin application data

The frozen `site` global exposes application assets and first-party requests
without raw HTML dumps or repeated browser restarts:

| Method | Description |
| --- | --- |
| `site.assets()` | Scripts, stylesheets, fetches, and XHRs discovered in the DOM or network log. |
| `site.requests(options?)` | Recent request metadata, filterable by `urlIncludes` and `resourceType`. |
| `site.read(url, options?)` | Read a same-origin text asset; `find`, `contextChars`, and `maxMatches` return bounded literal excerpts. |
| `site.request(url, options?)` | Same-origin GET/HEAD/POST/PUT/PATCH/DELETE with optional `json`, `body`, `headers`, and `response: "json"`. BetterWright copies matching browser cookies into the guarded request and returns response cookies to the session. |

Cross-origin URLs and credential-bearing headers are rejected. Request and
response bodies are bounded to 1 MB. This surface is useful for any web app
whose visible UI is backed by a first-party JSON API or client bundle; it does
not contain site-specific puzzle or endpoint knowledge.

## Batch-native WebAgents workflows

A participating origin publishes `/webagents.md` containing one fenced
`webagents` JSON block. A raw JSON mirror may instead live at
`/.well-known/webagents.json`. BetterWright parses the document outside the
model sandbox and returns only a compact normalized directory:

````md
# Agent actions

```webagents
{"version":"0.1","workflow":{"endpoint":"/api/agent/workflow","maxOperations":16,"parallel":true,"references":true,"pacing":{"minIntervalMs":150,"maxConcurrency":2}},"actions":{"search":{"description":"Search products","effect":"read","inputSchema":{"type":"object"}},"add_to_cart":{"description":"Add one product","effect":"write"}}}
```
````

After opening the page, discover once and submit the whole dependency graph in
one browser call:

```js
const directory = await webagents.discover();
if (!directory.available) return directory;

const result = await webagents.batch([
  {id: 'find', action: 'search', input: {query: 'wireless keyboard'}},
  {
    id: 'cart',
    action: 'add_to_cart',
    dependsOn: ['find'],
    input: {productId: {$ref: 'find.results.0.id'}},
  },
], {allowWrites: true});
return {result, state: await snapshot({diff: true})};
```

`webagents.discover({refresh?})` caches positive and negative discovery per
page origin. A manifest whose path scopes omit the current page is retried after
navigation so later app sections can expose their own actions. Raw Markdown
prose never enters model context. The returned action directory and workflow
result carry `trust: "untrusted_external_data"`.
After the first call that opens a supporting origin, BetterWright also attaches
that normalized directory once as `webagents` on the result envelope. This
makes the fast path discoverable even when the caller initially requested a
snapshot instead of discovery; unsupported sites add no model-context field.

`webagents.batch(operations, options?)` (or the equivalent single object
`webagents.batch({operations, ...options})`) accepts at most 32 declared operations
(or the site's lower advertised maximum). IDs must be unique; `action` is
preferred while `name` is accepted as a compatibility alias. `dependsOn`
references must exist and form an acyclic graph. Inputs and total payloads are
bounded JSON objects. The endpoint is same-origin and executes through the
existing guard proxy with the browser's matching cookies; response cookies are
returned to the browser session.

Action directories may include bounded `outputSchema` objects so reference
paths are explicit without reconnaissance. References automatically add their
operation dependency. Effectful operations are serialized in list order, while
independent reads can still run in parallel; a read after a write observes the
latest ordered state. A site may publish bounded `workflow.pacing` with a
`minIntervalMs` from 0–2000 and a `maxConcurrency` no greater than its operation
limit. BetterWright carries those normalized limits in the single workflow
request so generic site executors can space internal operations without adding
model or browser round trips. The site remains responsible for enforcing its
own rate limits and may always run more conservatively. After a successful
workflow containing writes, BetterWright reloads the active page once, waits
for DOM/load, and gives client hydration a short bounded settle before
returning. This stays compatible with polling and streaming apps that never
become network-idle while still making the refreshed state available to a
screenshot or DOM assertion in the same browser call. Pass `refresh:false` only
when the live UI updates itself.
Actions may also declare up to 16 `pathPrefixes`; BetterWright keeps only those
matching the active page and omits the scope metadata, so multi-app origins do
not spend model tokens advertising irrelevant actions.

Actions declare `effect: "read"`, `"write"`, or `"irreversible"`. Writes require
`allowWrites: true`; irreversible actions separately require
`allowIrreversible: true`, which should be set only after the user's request and
any configured guardrail authorize the consequence. These declarations are
site-controlled hints, not security claims. On missing or invalid discovery,
continue through WebMCP or ordinary browser interaction.

## Page-published WebMCP tools

Some pages publish typed first-party tools through Chromium's WebMCP API. Use
those tools when available instead of reconstructing the same operation from a
series of DOM clicks:

```js
const tools = await webmcp.tools();
const search = tools.find((tool) => tool.name === 'search');
if (!search) return {available: false};

return webmcp.invoke(
  search.name,
  {query: 'wireless mouse'},
  {frameId: search.frameId},
);
```

`webmcp.tools({timeout})` returns a fresh snapshot on every call. Each descriptor
has `name`, `description`, `frameId`, `trust: "untrusted_external_data"`, optional `inputSchema`, optional
`backendNodeId`, and advisory `annotations` (`readOnly`, `untrustedContent`,
`autosubmit`). Same-named tools in separate frames stay separate; invoking by
name alone fails closed until `frameId` disambiguates them.

`webmcp.invoke(name, input?, options?)` freshly discovers the tool, validates a
JSON-object input, invokes it, and awaits the terminal `Completed`, `Canceled`,
or `Error` result in one browser call. Options are:

| Option | Default | Notes |
| --- | --- | --- |
| `frameId` | — | Required only when more than one frame publishes the same name. Copy it from `webmcp.tools()`. |
| `discoveryTimeout` | `1000` | Tool-registration wait in milliseconds, capped at 10000. |
| `timeout` | `30000` | Terminal-result wait in milliseconds, capped at 120000. A timeout requests cancellation before returning an error. |
| `allowAutosubmit` | `false` | Must be `true` for a tool that declares `autosubmit: true`; set it only when the user's request authorizes submission. |

Tool descriptors and outputs are controlled by the page. Annotations are hints,
not security claims, and every invocation result carries
`trust: "untrusted_external_data"`. BetterWright also bounds serialized inputs,
schemas, and outputs to 1 MB and applies the normal result redaction before they
leave the worker. Page traffic caused by a WebMCP call stays behind the same
guard proxy and network policy as UI actions.

BetterWright enables `WebMCPTesting,DevToolsWebMCPSupport` for every local
Chromium it launches. A remote/CDP or cloud browser owns its own launch flags;
start it with
`--enable-features=WebMCPTesting,DevToolsWebMCPSupport` when that provider does
not already enable WebMCP.

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
`maxDelay`. After typing, `human.type` reads the field back. Success requires the
requested text to be inserted in full, so a prefix, an unchanged field, or
an overlapping partial append is not a hit.
If that check fails — typical of Draft.js and other rich-text editors that
swallow synthetic key events — it restores the original value when appending,
retries with `insertText`, and throws if the field still did not accept the
text.
`human.scroll(deltaY, options?)` accepts `steps`, while the object
form also accepts `deltaX`.

These helpers and the managed engines reduce behavioral and
browser-fingerprint false positives; they do not guarantee undetectability.
Keep one stable persistent profile and respect a site's rate limits. For broad
discovery, use the host's web-search tool and open returned results here rather
than automating Google or Bing's public search UI.

## Screenshots and artifacts

![A completed task with a proof checkmark and captured screenshots](https://raw.githubusercontent.com/BetterWright/betterwright/main/docs/assets/proof.png)

`screenshot(options)` captures the current page and records it as an artifact.

| Option | Default | Notes |
| --- | --- | --- |
| `kind` | `"debug"` | `"proof"`, `"question"`, or `"debug"` — how the host UI should treat it. |
| `name` | `"<kind>.png"` | A `.png`/`.jpg` extension is added if you omit one. |
| `annotate` | `false` | Draw a labelled box over every interactive element, so what you see maps back to a ref you can act on. |
| `fullPage` | `false` | Capture the full scrollable page. |
| `type` | `"png"` | `"png"` or `"jpeg"`. |
| `quality` | `80` | JPEG only. |

`{annotate: true}` takes a fresh boxes-annotated snapshot, overlays each
interactive element's bounding box labelled with its ref — including elements
inside child iframes, offset to page coordinates — captures, then removes the
overlay. The returned artifact gains an `annotations` count, and the refs shown
in the image are current, so `page.locator('aria-ref=…')` acts on exactly what
you see. Use it as the last step of reading escalation: when the accessibility
tree cannot answer a layout question, or to visually confirm what a ref points
at before a consequential click.

It returns `{kind, path, media}` where `media` is `MEDIA:<absolute path>`. The
`MEDIA:` convention lets a host surface render the file when the agent cites it.
To feed a screenshot straight to a vision model, read the image artifact at its
`path` (the `betterwright/pi` adapter and the MCP server already return
screenshots as native image content). Never
hand a host the non-image artifacts (downloads, spilled
output) as images — that is what triggers "unsupported image MIME type" errors.
The image kinds carry intent:

- **`proof`** — evidence a task reached its visible end state. Capture one before
  claiming success.
- **`question`** — the state behind a question you are asking the user (an MFA
  prompt, an ambiguous choice). The session holds its pages open longer while a
  `question` is outstanding.
- **`debug`** — a look at the current state; no special handling.
- **`captcha`** — an automatically captured challenge image or a capture from
  `captcha.inspect()` / `captcha.readText()`.

`artifactPath(name)` returns a writable path inside the session's artifact
directory for files you create yourself (a `page.pdf({path})`, for example).
Writes are confined to that directory.

Artifacts are subject to a per-session quota (100 MB by default); the oldest are
evicted first, and a warning is recorded when that happens.

## Bot-challenge detection

Every result envelope includes a `challenges` list. When a page visibly presents
a CAPTCHA or bot check, including one inside a child frame, BetterWright records
its page, provider, URL, and routing advice there and repeats the advice in
`warnings`. It also attaches a `captcha` image when the page can be captured.
Challenge reporting survives a failed snippet so the next turn can continue
from the same page and profile.

Treat a challenge as resumable state, not a generic navigation error. Inspect
the attached image and current snapshot, choose the appropriate helper, and
check the fresh result after every action. If the same stage rejects an action,
stop native challenge attempts immediately and use a host-provided research
tool, an alternate first-party source, or human help. Otherwise, continue
through at most three distinct stages before taking that handoff; never repeat a
failed action or rotate identities. When the challenge clears, verify the
current application state. Replay the original action only if it is idempotent
or the state proves it did not already complete; never duplicate a submission,
purchase, or message.

The `captcha` global provides:

- `captcha.inspect(bounds?)` for a challenge image the host model can inspect.
- `captcha.click(bounds)` for a checkbox-style widget.
- `captcha.clickTiles(indexes)` to apply numbered image-grid picks.
- `captcha.drag(from, to, {steps})` for a slider or puzzle handle.
- `captcha.readText(bounds?)` for a cropped image that the host model can read.
- `captcha.solve({ tiles: [indexes] })` to click those tiles, verify, and re-check.

Click and drag use shaped pointer movement and return a post-action
accessibility snapshot. Always check the result envelope's `challenges` list
before choosing the next distinct stage. See [captcha.md](captcha.md) for
recipes and limits.

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

## Overlays, controls, and media

Three more frozen globals verify page state that a snapshot alone answers
poorly. Each works across all child frames of the current page and returns
plain JSON; frames with nothing to report are omitted.

| Global | Description |
| --- | --- |
| `overlays.dismiss()` | Close obstructing cookie-consent and promotional overlays — for cookie banners it prefers a reject/essential-only button and falls back to accept; promos get close/no-thanks. Only layers whose text matches consent or promo patterns are considered, so a task-critical dialog is never dismissed. Returns `{dismissed: [{kind, label}]}` — `kind` is `"cookie"` or `"promotion"`, `label` is the clicked control's label. |
| `controls.inspect()` | Report the exact state of every form control — inputs, selects, textareas, and ARIA checkbox/combobox/listbox/radio/slider/spinbutton/switch roles. Returns `{frames: [{url, controls}]}`; each control carries `type`, `label`, `value` (`[redacted]` for passwords), `checked`, `selected`/`pressed`/`ariaChecked`, `min`/`max`/`step`, `disabled`, `visible`, and `options` for selects. Use it to prove a required filter or facet is actually active rather than inferring that from the results. |
| `controls.directory()` | Return the token-small semantic action directory BetterWright automatically attaches as `result.ui` after first navigation on a site without a first-party workflow. Controls include a copyable target, supported actions, current value/options, duplicate context, and frame scope; `evidence` contains visible status/result summaries. |
| `controls.batch()` | Execute one guarded semantic UI transaction on a site without a first-party batch protocol. Targets use ARIA ref, role/name, label, text, placeholder, test id, or CSS; an optional unique frame name/URL fragment scopes an iframe. Interactions auto-wait and ambiguous targets fail closed. |
| `agentBatch(steps, options?)` | Run an [AgentBatch](agent-batch.md) from inside a snippet: the same steps, targets, gates, and result as `bw.batch()`, the MCP `browser_batch` tool, and `betterwright batch`. Also accepts `agentBatch({steps, ...options})`. |
| `media.inspect()` | Report every `<video>` and `<audio>` element with its playback state. Returns `{frames: [{url, media}]}`; each item carries `kind`, `title` (aria-label, title attribute, or nearby caption/heading), `source`, `paused`, `ended`, `currentTime`, `duration`, `readyState`, `visible`, plus the frame's `documentTitle` and visible `headings`. Use it to match what is actually playing against the requested item before claiming playback. |

### Semantic UI batches for ordinary sites

After a first navigation, BetterWright synthesizes `result.ui` directly from
the live page when no WebAgents workflow is available. It is deliberately much
smaller than a full accessibility snapshot and contains only actionable visible
controls plus bounded visible evidence. Copy its targets verbatim rather than
reconstructing selectors or taking a snapshot.

`controls.batch(operations, options?)` also accepts
`controls.batch({operations, ...options})`. It is the default fast fallback
after WebAgents and WebMCP:

```js
return controls.batch({
  operations: [
    {id: 'query', action: 'fill', target: {label: 'Search'}, value: 'keyboard'},
    {id: 'submit', action: 'click', target: {role: 'button', name: 'Search', exact: true}},
    {id: 'verify', action: 'read', target: {role: 'heading', name: 'Results'}},
  ],
  allowWrites: true,
});
```

Supported actions are `click`, `fill`, `select`, `check`, `uncheck`, `press`,
`read`, and `readUrl`. Targets use exactly one of `ref`, `role`, `label`,
`text`, `placeholder`, `testId`, or `css`; `name` refines a role, `exact`
selects exact accessible matching, and `nth` explicitly resolves a known
duplicate. Add `frameName` or `frameUrlIncludes` to target one already loaded
iframe. Open shadow roots work through Playwright's normal locator behavior.

Interaction actions require `allowWrites:true`. Mark a consequential operation
with `irreversible:true` to also require `allowIrreversible:true`. A batch that
interacts must end in `read` or `readUrl`; the last result is the transaction's
verification boundary and must supply a non-empty expected substring in
`value`. The batch fails unless that expected text, form value, or URL is
observed on the final operation's specified target (`readUrl` checks the active
page URL). Page-wide directory evidence never substitutes for that target.
Password fields reject `fill` by default. A credential
provided explicitly in the current task may use `allowPasswordFill:true`;
stored or generated credentials must use the trusted credential helpers so the
secret never enters model context. Operations run in list order with a 40 ms
default minimum interval (configurable from 0–1000 ms), Playwright auto-waiting,
a unique-match check immediately before every action, and stop-on-first-error
semantics. The result is `{protocol:'ui-batch/1', pageUpdated, durationMs,
results}`.

The MCP `browser_batch` tool exposes the same path without model-authored
JavaScript. Passing `{url}` opens an unvisited page and returns its action
directory. Passing `operations` executes them, briefly waits for relevant
navigation/fetch and semantic state to settle, then returns refreshed
`controls` and `evidence`. Put the required expected result in the `value` of
the final `read`/`readUrl`; the final proof screenshot is captured only after
that visible result is observed. For a password explicitly supplied in
the task, set `allowPasswords:true`; saved and generated credentials still use
`browser_login`.

This helper removes extra model/tool turns, not network or application time.
For a target omitted by the bounded directory, take one
`snapshot({interactive:true})`, then compile the observed ref or accessible
name into the batch. Do not guess targets.

`controls.batch()` is the guarded transaction for a directory a site
published or BetterWright synthesized. For everyday browsing — navigation,
forms, waiting, reading, tabs — the default is [AgentBatch](agent-batch.md),
whose `agentBatch()` global shares these targets and gates and adds the rest
of the vocabulary plus a structured, resumable result.

## Credentials

The `credentials` helpers manage records in the
[encrypted vault](credentials.md). Metadata is readable; secret values are
filled, never returned.

```js
await credentials.inspect();                       // detected field roles, no values
await credentials.list();                          // metadata only, no passwords
const accounts = await credentials.list({ text: "work", category: "login" });
if (accounts.length !== 1) return { accounts, needsAccountSelection: true };
await credentials.fill({ id: accounts[0].id, submit: true }); // detect and fill
const pending = await credentials.generateAndFill({ username: "alice", submit: true });
await credentials.listPending();                   // recoverable metadata only
await credentials.commitGenerated({ pendingId: pending.pendingId }); // only after verified success
await credentials.update({ id, label: "work" });
await credentials.remove({ id });
```

Do not put a password in model-authored `bw.run()` source. `credentials.save()`
is reserved for a trusted host-authored snippet receiving a user-supplied
secret through an application-controlled channel; agent code should use the
metadata-only lookup and trusted fill/generate operations above. Generated
passwords never enter either host or model source.

All operations are gated to the current HTTP(S) site. Login items use PSL-backed
base-domain matching by default, with per-item `host`, `exact-origin`, and
`never` modes; HTTPS records never downgrade to HTTP. `list()` accepts a
`{text, category}` filter; `category` defaults to `login`, with `credit-card`,
`identity`, `api-credential`, `secure-note`, and `ssh-key` available for other
records.

`fill` selects by `{id}` or `{username}` (or the only clear match), detects the
username/current-password/submit controls across child frames and open shadow
roots, and types with trusted human-shaped input. Detection fails closed on
multiple plausible forms; explicit selectors or current aria refs remain
available. `generateAndFill` detects new-password and confirmation fields,
fills the saved current password during rotation, and returns a 60-second
normal-window opaque pending id. The encrypted provisional entry remains
recoverable by that exact id across worker restarts, and across a recreated host
when it returns to the matching site origin. `listPending()` exposes only
recovery metadata and never makes provisional items available to normal
`list()` or `fill()`. A post-generation page or worker failure includes a secret-free
`pendingCredential` recovery object. Commit it only after the site visibly
accepts the signup or rotation; discard it on failure. Rotation commits back to
the same record id and preserves its URL scope; new records accept `matchMode`
to narrow their URL scope.

For an ambiguous rotation form, pass `currentPasswordSelector`,
`passwordSelector`, and `confirmPasswordSelector` together; the worker pins all
three exact handles and their origin before reading either password.

The same operations are available to the host as `bw.fillCredential(...)` /
`bw.generateAndFillCredential(...)`, followed by
`commitGeneratedCredential(...)` / `discardGeneratedCredential(...)`;
`bw.listPendingCredentials()` recovers interrupted attempts. The same trusted
fill path is used by the
MCP/Pi `browser_login` tool. Agent-facing APIs never return the value, and the
redaction net scrubs handled values from outputs. Like extension autofill, the
value does exist in the live DOM after filling. See
[credentials.md](credentials.md) for the full contract.

## Console

`console.log/info/warn/error` from your snippet are captured (not printed to a
terminal) and returned alongside the result — up to 20 messages. Page-side
`console` and uncaught exceptions are not copied into that envelope; collect
them on the current call with Playwright's usual listeners:

```js
const messages = [];
const errors = [];
page.on("console", (message) => messages.push({
  type: message.type(),
  text: message.text(),
}));
page.on("pageerror", (error) => errors.push(error.message));
await page.setContent(`<script>
  console.warn("from the page");
  throw new Error("page boom");
</script>`);
return { messages, errors };
```

`page.once` and `page.off` work for the same two events. Listeners last for
this snippet only — including console and pageerror events that Playwright
delivers just after the command that produced them — and the next `run()` /
`browser` call starts clean. One-shot waits (`page.waitForEvent("console")`)
still work.

## What is removed

Model code gets Playwright's page-driving surface, not the APIs that would let
it escape the policy or read the host. These are absent by design and return
`undefined` (or throw) if accessed:

- **Interception and unrestricted eventing** — `route`, `routeWebSocket`,
  `unroute`, `exposeFunction`, `exposeBinding`, `newCDPSession`,
  `removeAllListeners`, and `page.on` / `once` / `off` for every event except
  `console` and `pageerror`. Request routing is how the policy is enforced;
  handing it to model code would defeat it. Other Playwright events stay
  inside the worker.
- **Browser and CDP internals** — the raw browser object, private Playwright
  properties, and CDP sessions stay inside the worker. Attach-mode endpoints
  are trusted host configuration and are not exposed as snippet globals.
- **Context mutation** — `context.newPage`, `context.cookies`,
  `context.storageState`, `context.addCookies`, `context.clearCookies`,
  `context.setStorageState`, `context.close`, `context.tracing`. Use `openPage`;
  trusted host code can import an identity with
  [Cookie Sync](cookie-sync.md).
- **Raw network credentials** — full and name-addressed request/response header
  methods are absent. Playwright's filtered `headers()` remains available, as
  do request/response timing, status, URL, resource type, and request-body
  inspection.
- **`page.screenshot`** — use the `screenshot()` helper so captures are tracked
  as artifacts.
- **Filesystem reach** — `setInputFiles`, `FileChooser.setFiles`,
  `addInitScript({path})`, and tag helpers can only read existing files inside
  BetterWright's artifact directory. Browser-created files can only be written
  there.
- **Node internals** — there is no `process`, `require`, `import`, or `fs`. The
  snippet runs in a `node:vm` context with code generation disabled.

For deterministic page tests, call `page.addInitScript` before navigation to
install page-local `fetch` or XHR mocks, use `page.setContent` for fixture HTML,
or serve a local fixture from the trusted host. `addInitScript` can affect the
page's initial scripts, but it cannot replace the navigation response itself;
that request always stays on the worker-owned guarded route.

The [architecture doc](architecture.md) explains why this is defense in depth
layered on top of the browser-level controls, not a claim that the `vm` boundary
is itself a security boundary.
