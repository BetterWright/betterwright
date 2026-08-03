# Native CAPTCHA helpers

![A puzzle piece completing a "verify you are human" challenge](https://raw.githubusercontent.com/BetterWright/betterwright/main/docs/assets/captcha.png)

BetterWright solves simple CAPTCHAs **inside the existing browser session**. It
does not send sitekeys, tokens, screenshots, or API keys to a third-party
solving service, and it does not load a heavy local ML runtime. The automatic
solver is open-source, self-hosted by definition (it runs in your managed
browser), and keeps a small memory footprint: ordinary DOM inspection plus the
same human-shaped mouse motion used elsewhere.

> Use these helpers only for a legitimate flow you are authorized to complete.
> Never rotate identities or repeat a failed action. A rejected repeat of the
> same stage requires an immediate alternate source or human handoff; otherwise,
> work through at most three distinct stages before taking that handoff.

When BetterWright detects a visible challenge, the result contains a structured
`challenges` entry (including `stage`, `autoSolvable`, and `needsVision`) and,
when capture succeeds, an attached `captcha` image. This also happens when the
browser snippet itself failed. Keep the same page and profile, inspect that
state, and continue on the next turn.

## Automatic solver (preferred)

`captcha.solve(options?)` is the 2Captcha-shaped entry point that stays fully
local:

```js
return await captcha.solve({ timeoutMs: 45_000, maxStages: 3 });
```

`timeoutMs` is in **milliseconds** (clamped to 3000–180000) — unlike the host
`run()` timeout, which is in seconds. `timeout` is accepted as an alias with
the same millisecond unit; prefer `timeoutMs` so the unit stays visible.

| Field | Meaning |
| --- | --- |
| `status` | `ready` (cleared), `processing` (needs vision / another stage), or `error` |
| `request` / `requestId` | Local solve id (2Captcha-style request handle) |
| `provider` | `recaptcha`, `hcaptcha`, `turnstile`, `cloudflare`, `bing`, `google`, `generic`, … |
| `stage` | `checkbox`, `turnstile`, `managed_challenge`, `image_grid`, `slider`, `text`, … |
| `cleared` | `true` when the challenge is gone or a response token is present |
| `token` | Response token when a widget wrote one into the page |
| `tiles` | Image-grid tile bounds for host vision (when `status === "processing"`) |
| `artifact` | Attached captcha PNG (`MEDIA:…`) for vision stages |
| `attempts` | Per-stage action log |
| `local` / `externalApi` | Always `true` / `false` — no remote solver |

### What auto-solves without vision

| Stage | Strategy |
| --- | --- |
| Checkbox (reCAPTCHA / hCaptcha / generic) | Human-shaped click on the widget |
| Cloudflare Turnstile | Click the widget, wait for `cf-turnstile-response` |
| Managed Cloudflare check | Click verify if present, then wait for clearance |
| Slider / puzzle handle | Human-shaped drag across the track |

### What still needs the host model

| Stage | What `solve()` returns |
| --- | --- |
| Image grid (“select all images with …”) | `status: "processing"`, screenshot + `tiles[]` bounds |
| Text CAPTCHA | `status: "processing"`, tight crop + instruction |

Example vision handoff for an image grid:

```js
const first = await captcha.solve();
if (first.status === "ready") return first;
if (first.status === "processing" && first.tiles?.length) {
  // Host vision picks matching tile indexes from the attached artifact.
  for (const index of [0, 3, 5]) {
    const tile = first.tiles[index];
    if (tile) await captcha.click(tile.bounds);
  }
  await human.click(page.getByRole("button", { name: /verify/i }));
  return captcha.solve();
}
return first;
```

### Detection only

```js
return await captcha.detect();
// { present, challenge, classification, widgets, tokens, cleared, url }
```

## Manual helpers

Every `run()` snippet has a frozen `captcha` global:

| Helper | Purpose | Result |
| --- | --- | --- |
| `captcha.solve(options?)` | Local automatic multi-stage solver | Solve envelope (`ready` / `processing` / `error`) |
| `captcha.detect()` | Structured widget + stage report | Detection object |
| `captcha.inspect(bounds?)` | Capture the whole page or a challenge region for the agent's vision | `captcha` image artifact |
| `captcha.click(bounds)` | Click a checkbox-style widget | Fresh accessibility snapshot |
| `captcha.drag(from, to, {steps: 20})` | Smoothly drag a slider or puzzle handle | Fresh accessibility snapshot |
| `captcha.readText(bounds?)` | Capture only a text challenge for the agent's existing vision | `captcha` image artifact |

`bounds` uses CSS pixels: `{x, y, width, height}`. `from` and `to` use
`{x, y}`. The click helper targets the left side of the supplied widget bounds,
where checkbox challenges normally place their control.

## Checkbox challenge

```js
// Preferred: let the local solver find and click the widget.
return captcha.solve();

// Manual fallback:
const frame = page.locator('iframe[title*="challenge" i], iframe[src*="captcha" i]').first();
const bounds = await frame.boundingBox();
if (!bounds) throw new Error('CAPTCHA widget is not visible');
return captcha.click(bounds);
```

The returned snapshot (manual path) is captured after the click. The result
envelope also contains BetterWright's current `challenges` report. If the
checkbox opens an image grid, that is a new stage; call `captcha.solve()` again
or inspect rather than clicking the checkbox again.

## Slider or puzzle drag

```js
return captcha.solve(); // auto-drags when a slider stage is classified

// Manual fallback:
const handle = page.locator('[role="slider"], .slider-handle').first();
const bounds = await handle.boundingBox();
if (!bounds) throw new Error('Slider handle is not visible');
const from = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
return captcha.drag(from, {x: from.x + 280, y: from.y}, {steps: 24});
```

## Text challenge

```js
const solved = await captcha.solve();
if (solved.status === "processing") {
  // Host vision reads solved.artifact, then:
  // await page.locator('input[name*="captcha" i]').fill(text);
  // await page.locator('button[type="submit"]').click();
  // return captcha.solve();
}
return solved;
```

## Image-grid challenge (reCAPTCHA / hCaptcha)

A checkbox click frequently escalates to an image grid — "select all images with
bicycles". There is no separate solver dependency: use the vision handoff from
`captcha.solve()` or the existing capture primitives. Treat the escalation as
the next distinct stage, not a dead end.

```js
const shot = await captcha.inspect();
const tree = await snapshot();   // rows of button [ref=…] tiles + a Verify button
return tree;
```

On the next turn, having looked at the screenshot, click each matching tile and
submit in one pass:

```js
for (const ref of ['f4e14', 'f4e30', 'f4e37']) {   // the tiles your vision picked
  await human.click(page.locator(`aria-ref=${ref}`));
}
await human.click(page.getByRole('button', {name: 'Verify'}));
return captcha.solve();          // confirm it cleared or classify the next stage
```

Inspect the fresh `challenges` report after Verify. A replacement set of tiles
or another prompt is a new stage; a rejected repeat of the same grid is not.
If the same stage rejects an action, stop native challenge attempts immediately
and use an alternate first-party source or request human help. Otherwise,
continue through no more than three distinct stages before taking that handoff.
When the challenge clears, verify the current application state before resuming.
Replay the original action only if it is idempotent or the state proves it did
not already complete; never duplicate a submission, purchase, or message.

## When detection runs

Every `run()` result is scanned for a challenge, but the scan is staged. Stage 1
always reads the main frame — its title, its body text, its filled provider
response fields, and the geometry and (same-origin) text of its child frames.
Stage 2 reads every frame individually, which costs a round trip per frame and
so runs only when something already points at a challenge:

- a provider frame or main-document URL (reCAPTCHA, hCaptcha, Turnstile, the
  Cloudflare challenge platform, Google `/sorry`, Bing challenge paths);
- main-frame or same-origin-frame text that the detector matches;
- a 403, 429 or 503 document response — main frame **or** subframe — within the
  last 10 seconds;
- a challenge still unresolved at the end of the previous `run()`;
- any frame stage 1 could not read (cross-origin) whose URL is challenge-shaped
  — the commercial vendors that do not name a provider in their frame URL
  (DataDome, Arkose/FunCaptcha, AWS WAF, PerimeterX, GeeTest) as well as
  self-hosted `…/captcha/…`, `…/challenge…`, `…/verify…` endpoints;
- up to three unreadable cross-origin frames regardless of what their URLs say.

`captcha.solve()` and `captcha.detect()` never stage: they always read every
frame.

**Accepted limitation.** A page carrying **more than three** cross-origin frames
whose URLs are entirely unremarkable, where one of them is a challenge
identifiable only by its text, is not detected automatically. Text is the only
evidence in that case and reading it is exactly the per-frame cost the staging
exists to avoid. Call `captcha.detect()` explicitly if you are working a page
you expect to challenge you from an opaque embedded frame.

## Efficiency

The solver adds no worker processes, ONNX/TensorFlow runtimes, or OCR binaries.
Peak cost is a few short Playwright frame queries, optional PNG screenshots
already budgeted by BetterWright's artifact quota, and ordinary mouse events.
Host vision (when needed for image grids) reuses the model you already run the
agent with — it is not a second paid captcha API.

## Limits

These helpers reproduce normal mouse interaction, wait for provider response
fields (`g-recaptcha-response`, `h-captcha-response`, `cf-turnstile-response`),
and provide a token-efficient vision crop. They do not manufacture reCAPTCHA,
hCaptcha, or Turnstile tokens offline, send challenges to a third-party solver,
or guarantee that a provider will accept the managed browser. An invisible or
scored challenge may have no native interaction to perform; preserve the page
and request human help instead of looping or changing identity.

Public unit and browser fixtures cover the local pipeline end-to-end. Live
provider demos (Google reCAPTCHA, hCaptcha, Cloudflare Turnstile) succeed when
the provider accepts the session; bot-scoring may still block headless or
datacenter IPs regardless of correct clicks.
