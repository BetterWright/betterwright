# AgentBatch

AgentBatch is the default way an agent drives BetterWright. A task takes two
calls:

1. **Spec.** Open the page and read its spec — an interactive snapshot whose
   `[ref=eN]` markers, roles, and names are the targets to plan with.
2. **Batch.** Send every step the task needs. The worker runs them back to
   back with Playwright auto-waiting and no pacing between actions, then
   returns per-step results and a fresh snapshot of where the page ended up.

A step that fails stops the batch. The result says which step, keeps the
results of every step that completed, and still carries the final snapshot,
so the next call resumes from `failed.index` instead of re-observing and
re-planning from scratch. Compared with one tool call per click, a form that
used to cost eight model turns costs two, and the actions inside the batch
are separated only by the browser's own round trips.

The same protocol is exposed everywhere BetterWright is driven:

| Surface | Spec call | Batch call |
| --- | --- | --- |
| MCP | `browser_batch {url}` | `browser_batch {steps, allowWrites}` |
| Built-in agent (`exec`) | `batch {url}` | `batch {steps, allowWrites}` |
| Pi | `browser_batch {url}` | `browser_batch {steps, allowWrites}` |
| CLI / skill | `betterwright batch --url <url>` | `betterwright batch --allow-writes -s '<json>'` |
| JS API | `bw.batch({url})` | `bw.batch(steps, {allowWrites: true})` |
| Inside `run()` code | `agentBatch([{action: "goto", url}])` | `agentBatch(steps, {allowWrites: true})` |

Every surface generates the same worker snippet, `return agentBatch(steps,
options)`, so a batch behaves identically wherever it is sent. The snippet
runs through the ordinary `run()` path: the same session lane, timeout,
redaction, artifact quota, and result envelope.

## A complete task

```js
import { BetterWright } from "betterwright";

const bw = new BetterWright();
try {
  // Call 1: the spec.
  const spec = await bw.batch({ url: "https://shop.example/checkout" });
  console.log(spec.result.snapshot);
  // page page-1 https://shop.example/checkout "Checkout"
  // - textbox "Email" [ref=e3]
  // - textbox "Promo code" [ref=e5]
  // - button "Apply" [ref=e6]
  // - button "Place order" [ref=e9]

  // Call 2: the whole task.
  const done = await bw.batch(
    [
      { action: "fill", target: { ref: "e3" }, value: "ada@example.com" },
      { action: "fill", target: { ref: "e5" }, value: "SAVE10" },
      { action: "click", target: { ref: "e6" } },
      { action: "read", target: { role: "status" }, expect: "applied" },
      { action: "click", target: { role: "button", name: "Place order" }, irreversible: true },
      { action: "url", expect: "/orders/" },
      { action: "read", target: { role: "heading", name: "Order confirmed" } },
    ],
    { allowWrites: true, allowIrreversible: true, proof: true },
  );
  console.log(done.result.ok, done.result.steps.at(-1).text, done.result.proof.path);
} finally {
  await bw.close();
}
```

## Steps

A step is `{action, ...fields}`. `id` is optional (it defaults to `s1`,
`s2`, …) and must be unique within the batch. Fields a step's action does not
understand are rejected before the browser moves, so a typo fails fast with a
message naming the step and the field.

| Action | Fields | Result fields |
| --- | --- | --- |
| `goto` | `url`, `waitUntil?` | `url`, `status` |
| `back`, `forward` | — | `url` |
| `reload` | `waitUntil?` | `url` |
| `click`, `dblclick`, `hover` | `target` | — |
| `fill` | `target`, `value` | `filled` (length) |
| `type` | `target`, `value`, `append?` | `typed` (length). Types key by key; clears the field first unless `append`. |
| `press` | `key`, `target?` | `pressed`. Without a target the key goes to the page. |
| `select` | `target`, `value` (string or array) | `selected`. Matches option values or labels. |
| `check`, `uncheck` | `target` | `checked` |
| `scroll` | `target`, or `dx`/`dy` | `scrolled`. A target scrolls into view; deltas turn the wheel. |
| `wait` | exactly one of `target` (+ `state?`), `url`, `text`, `ms` | `waited`, `ms`. `url` and `text` are substrings; `ms` is capped at 10 s. |
| `read` | `target`, `attribute?`, `all?`, `expect?` | `tag`, `text`, `value`, `checked`, `disabled`, `ariaLabel`, `attribute`; with `all`, `count` and `items`. |
| `url` | `expect?` | `url`, `title` |
| `snapshot` | `interactive?` (default true), `ref?`, `selector?`, `diff?`, `depth?`, `maxChars?`, `urls?` | `snapshot` |
| `screenshot` | `kind?` (`proof`, `question`, `debug`), `name?`, `fullPage?`, `annotate?` | `screenshot` `{kind, path, media}` |
| `openPage` | `url?` | `pageId`, `url`. The new page becomes current. |
| `usePage` | `page` (id or index) | `pageId`, `url` |
| `closePage` | `page?` | `closed`, `pageId` |
| `dialog` | `response` (`accept` or `dismiss`), `promptText?` | `prepared`. Arms the next dialog. |
| `overlays` | — | `dismissed`. Closes cookie and promotional overlays only. |

Every step also accepts:

- `optional: true` — a failure is recorded on the step and the batch continues.
- `irreversible: true` — the step needs `allowIrreversible: true` on the batch.
- `timeoutMs` — a per-step budget from 100 to 60000 ms. Unset, actions get
  the worker's 10 s action default and navigations its 30 s navigation
  default.

`read` with `expect` and `url` with `expect` poll until the text, value, or
URL contains the expected substring, so a mutation whose result arrives
asynchronously is verified without a sleep. `wait {text}` and `wait {url}` do
the same for text anywhere on the page or the page URL.

## Targets

A target names exactly one element:

| Field | Meaning |
| --- | --- |
| `ref` | A `[ref=eN]` (or frame-qualified `f1e3`) marker from the spec snapshot. |
| `role` (+ `name`) | Accessible role, optionally filtered by accessible name. |
| `label` | Form control by its label. |
| `text` | Element by visible text. |
| `placeholder` | Input by placeholder. |
| `testId` | `data-testid`. |
| `css` | A CSS selector. |

Exactly one of the seven is required. `exact: true` demands an exact name or
text match instead of a case-insensitive substring; `nth` picks a known
duplicate; `frameName` or `frameUrlIncludes` scopes the target to one already
loaded iframe. Resolution auto-waits like any Playwright locator, and a
target that matches more than one element fails the step rather than acting
on the first — add `exact`, `nth`, or a more specific role to disambiguate.

Refs are assigned by the spec snapshot and go stale when the page changes.
After a navigation inside a batch, target the new page by role, label, or
text, or add a `snapshot` step and continue in the next call.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `allowWrites` | `false` | Required when any step changes page state: `click`, `dblclick`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `dialog`, `overlays`. |
| `allowIrreversible` | `false` | Required for steps marked `irreversible: true`. |
| `allowPasswords` | `false` | Lets `fill`/`type` into a password field, for a password the task itself supplied. Stored and generated credentials use the credential helpers, so the secret never enters model context. |
| `observe` | `"snapshot"` | The final observation: an interactive snapshot, `"diff"` for only what changed since the previous snapshot of that page, or `"none"`. |
| `proof` | `false` | Capture a `proof` screenshot after every step succeeded. A batch that stopped short takes none — the snapshot already shows where it stopped. |
| `settleMs` | `1000` | Before an observation that follows a write or navigation, wait up to this long for the in-flight document, fetch, and XHR requests that step started. 0 disables it. |
| `minIntervalMs` | `0` | Pause between steps, up to 1000 ms. |

The gates are the same ones `controls.batch()` and `webagents.batch()`
enforce, so switching between the three never changes what a model must opt
into. `note` (MCP, Pi, and the built-in agent) and `session` (MCP, JS API)
are surface options and are not part of the batch.

## Results

```json
{
  "protocol": "agent-batch/1",
  "ok": false,
  "completed": 2,
  "total": 4,
  "failed": { "index": 2, "id": "s3", "action": "click", "error": "AgentBatch step \"s3\" target matched 2 elements; use a more precise target or nth." },
  "steps": [
    { "id": "s1", "action": "fill", "ok": true, "filled": 15 },
    { "id": "s2", "action": "select", "ok": true, "selected": ["pro"] },
    { "id": "s3", "action": "click", "ok": false, "error": "AgentBatch step \"s3\" target matched 2 elements; use a more precise target or nth." }
  ],
  "page": { "id": "page-1", "url": "https://shop.example/plans", "title": "Plans" },
  "snapshot": "page page-1 https://shop.example/plans \"Plans\"\n- button \"Save\" [ref=e7]\n- button \"Save\" [ref=e12]",
  "durationMs": 412
}
```

- `ok` is true when every non-optional step succeeded; `completed` counts
  the steps that did. An optional step that failed appears in `steps` with
  `ok: false` and does not set `failed`.
- `failed.index` is where to resume. The steps before it ran; do not send
  them again.
- `snapshot` is the next call's spec. `observeError` replaces it when the
  snapshot itself could not be taken (for example an over-limit tree, with
  the same scoping hints `snapshot()` gives).
- `proof` is the screenshot artifact when `proof: true` and the batch
  succeeded; it also appears in the envelope's `artifacts`.
- The batch result is the `result` of an ordinary `run()` envelope, so
  `console`, `pages`, `challenges`, `skills`, and `warnings` arrive beside it.
  A bot challenge that appears mid-batch is reported the same way it is for
  any snippet.

A spec call is one `goto` step plus the default observation, so its result
has the same shape. Because the spec already lists every actionable control,
the compact `ui` directory that ordinary navigation attaches to a first visit
is skipped for a page a batch has observed; `webagents` discovery still
runs, since a first-party workflow is worth more than either.

## What the batch does not change

- **Every URL passes the navigation policy.** `goto` and `openPage` go
  through the same scheme check and public-search block as `page.goto` in
  snippet code, and every request still crosses the guard proxy.
- **Secrets stay out of results.** A `read` of a password field returns
  `[redacted]` for its value and its `value` attribute; a permitted password
  fill reports only the length; snapshots redact filled password values as
  always; the whole result is redacted like any envelope.
- **Downloads are not granted.** A batch runs under the session's download
  policy; a step that triggers a download needs the host's approval surface
  exactly as a snippet does.
- **Timeouts are the run's.** The batch runs under an ordinary `run()`
  timeout: 120 s over MCP, the remaining wall-clock budget inside the
  built-in agent, and for `bw.batch()` and `betterwright batch` a budget
  sized to the batch — the surface's default (30 s) or 15 s plus 10 s per
  step, whichever is larger, capped at ten minutes. Pass `timeout` (seconds)
  to `bw.batch()` to choose your own.

## When to write code instead

The step vocabulary covers browsing: navigation, forms, waiting, reading,
observing, tabs, and dialogs. Reach for a `browser` snippet when the task
needs what steps cannot express — a computed value, a loop over results,
`Promise.all` across tabs, `site.request()`, a first-party
`webagents.batch()` workflow, `webmcp.invoke()`, `captcha.solve()`, or the
`human.*` helpers. A snippet can still call `agentBatch(steps, options)`
itself, so the two combine freely inside one session.
