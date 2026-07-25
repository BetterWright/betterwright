# CAPTCHA recipes

Try `captcha.solve()` first — the local automatic solver documented in
[captcha.md](captcha.md) handles checkbox, Turnstile, managed-challenge, and
slider stages without any of the code below. These recipes are the manual
fallbacks for when `solve()` reports a stage it cannot finish or you need
finer control.

Each block is the body of a `run()` snippet. BetterWright exposes `captcha`
alongside `page`, `snapshot`, and `screenshot`. A detected challenge normally
arrives with a `captcha` image already attached; use `captcha.inspect(bounds?)`
when you need a fresh or tighter view.

## Find likely widgets

```js
const candidates = await page.locator([
  'iframe[title*="captcha" i]',
  'iframe[title*="challenge" i]',
  'iframe[src*="recaptcha" i]',
  'iframe[src*="hcaptcha" i]',
  '.cf-turnstile',
  '[role="slider"]',
  'img[src*="captcha" i]'
].join(',')).evaluateAll(elements => elements.map(element => {
  const r = element.getBoundingClientRect();
  return {tag: element.tagName, x: r.x, y: r.y, width: r.width, height: r.height};
}));
return candidates;
```

## Click a checkbox-style widget once

```js
const widget = page.locator('iframe[title*="challenge" i], iframe[src*="captcha" i]').first();
const bounds = await widget.boundingBox();
if (!bounds) throw new Error('Challenge widget is not visible');
return captcha.click(bounds);
```

## Drag a slider smoothly

```js
const handle = page.locator('[role="slider"], .slider-handle').first();
const box = await handle.boundingBox();
if (!box) throw new Error('Slider handle is not visible');
const from = {x: box.x + box.width / 2, y: box.y + box.height / 2};
return captcha.drag(from, {x: from.x + 280, y: from.y}, {steps: 24});
```

## Attach a text challenge to Pi vision

```js
const image = page.locator('img[src*="captcha" i], img[alt*="captcha" i]').first();
const bounds = await image.boundingBox();
if (!bounds) throw new Error('CAPTCHA image is not visible');
return captcha.readText(bounds);
```

The browser result contains only the crop, not a redundant full-page image.
After the model reads the text, fill that text challenge's answer normally:

```js
await page.locator('input[name*="captcha" i], input[id*="captcha" i]').fill(text);
await page.locator('button[type="submit"]').click();
return snapshot();
```

## Inspect a non-text widget

For a checkbox, image grid, or other non-text challenge, capture the visible
region for visual inspection. Do not run the text-fill recipe against it:

```js
const widget = page.locator('iframe[title*="challenge" i], .cf-turnstile').first();
const bounds = await widget.boundingBox();
return captcha.inspect(bounds || undefined);
```

Always inspect the returned snapshot and `challenges` list after each action.
The staging rules — when a change of form counts as a new stage, when to stop
and hand off, and what may safely be replayed afterwards — are in
[captcha.md](captcha.md).
