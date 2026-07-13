# Browser recipes for CAPTCHA interactions

Each block is the body of a `run()` snippet. BetterWright exposes `captcha`
alongside `page`, `snapshot`, and `screenshot`.

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
After the model reads it, fill the answer normally:

```js
await page.locator('input[name*="captcha" i], input[id*="captcha" i]').fill(text);
await page.locator('button[type="submit"]').click();
return snapshot();
```

Always inspect the returned snapshot and `challenges` list. Stop if one native
attempt does not clear the challenge.
