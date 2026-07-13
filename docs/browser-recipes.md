# Browser recipes — detect, extract, inject

Each block below is the body of a `run()` snippet (globals: `page`, `pages`,
`context`, `snapshot`, `screenshot`, `artifactPath`) and returns the data the
next step needs. Keep the sitekey/action in the return value; pass them to
`CaptchaSolver`; then inject the returned token with the matching block.

## 1. Detect which captcha is present

```js
() => {
  const out = { recaptcha_v2: null, recaptcha_v3: null, hcaptcha: null, turnstile: null, image: false };
  // reCAPTCHA (v2 checkbox/invisible, and v3) — sitekey lives on .g-recaptcha or in a render call
  const gr = document.querySelector('.g-recaptcha, [data-sitekey][class*="recaptcha"], iframe[src*="recaptcha"]');
  if (gr) {
    const k = gr.getAttribute?.('data-sitekey');
    const src = gr.getAttribute?.('src') || '';
    out.recaptcha_v2 = { sitekey: k || (src.match(/[?&]k=([^&]+)/)?.[1] ?? null),
                          invisible: gr.getAttribute?.('data-size') === 'invisible' };
  }
  // hCaptcha
  const hc = document.querySelector('.h-captcha, [data-sitekey], iframe[src*="hcaptcha"]');
  if (hc && (hc.className.includes('h-captcha') || (hc.getAttribute('src')||'').includes('hcaptcha')))
    out.hcaptcha = { sitekey: hc.getAttribute?.('data-sitekey') || null };
  // Cloudflare Turnstile
  const ts = document.querySelector('.cf-turnstile, [data-sitekey][class*="turnstile"]');
  if (ts) out.turnstile = { sitekey: ts.getAttribute?.('data-sitekey') || null,
                            action: ts.getAttribute?.('data-action') || null };
  // Plain image captcha heuristic
  out.image = Boolean(document.querySelector('img[src*="captcha" i], img[alt*="captcha" i], img[id*="captcha" i]'));
  return out;
}
```

If a sitekey comes back `null` but a widget exists, it is usually rendered by JS.
Read it from the grecaptcha/hcaptcha config instead:

```js
() => window.___grecaptcha_cfg?.clients &&
      Object.values(window.___grecaptcha_cfg.clients)
        .flatMap(c => Object.values(c))
        .map(o => o?.sitekey).filter(Boolean)[0] || null
```

## 2. Extract an image captcha for `--image`

```js
async () => {
  const img = document.querySelector('img[src*="captcha" i], img[alt*="captcha" i], img[id*="captcha" i]');
  if (!img) return { ok: false };
  const el = await page.$(`#${CSS.escape(img.id)}`) || (await page.$('img[src*="captcha" i]'));
  const path = artifactPath('captcha.png');
  await el.screenshot({ path });      // crops to just the captcha image
  return { ok: true, path };
}
```

**Vision first for image captchas:** hand that `path` to whatever vision model
your agent already has and ask it to transcribe the characters — it's free and
usually enough. Only when the read is unreadable or low-confidence, fall back to
the paid service: `CaptchaSolver().image(path)` (or
`betterwright captcha --type image --image <path>`).

## 3. Inject the solved token

### reCAPTCHA v2 / v3
```js
(token) => {
  // Fill every g-recaptcha-response field (v2 and v3 use the same textarea id family)
  document.querySelectorAll('textarea[id^="g-recaptcha-response"], textarea[name="g-recaptcha-response"]')
    .forEach(t => { t.value = token; t.dispatchEvent(new Event('change', { bubbles: true })); });
  if (!document.querySelector('textarea[name="g-recaptcha-response"]')) {
    const ta = document.createElement('textarea');
    ta.name = 'g-recaptcha-response'; ta.style.display = 'none'; ta.value = token;
    document.forms[0]?.appendChild(ta);
  }
  // Fire the site's callback if it declared one
  try {
    const cfg = window.___grecaptcha_cfg?.clients || {};
    Object.values(cfg).flatMap(c => Object.values(c))
      .forEach(o => { if (typeof o?.callback === 'function') o.callback(token); });
  } catch {}
  return true;
}
```
Then submit the form (`page.click('button[type=submit]')` or `form.requestSubmit()`).

### hCaptcha
```js
(token) => {
  document.querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]')
    .forEach(t => { t.value = token; t.dispatchEvent(new Event('change', { bubbles: true })); });
  return true;
}
```

### Cloudflare Turnstile
```js
(token) => {
  let f = document.querySelector('input[name="cf-turnstile-response"]');
  if (!f) { f = document.createElement('input'); f.type = 'hidden';
            f.name = 'cf-turnstile-response'; document.forms[0]?.appendChild(f); }
  f.value = token;
  document.querySelectorAll('input[name="g-recaptcha-response"]').forEach(i => i.value = token);
  return true;
}
```

### Image captcha
Type the returned `text` into the answer field and submit:
```js
(text) => { document.querySelector('input[name*="captcha" i], input[id*="captcha" i]').value = text; return true; }
```

## 4. Passing a token back into the browser

Each `run()` call is one snippet, so pass the solved token into the injection
snippet by interpolating it as a string literal (a CAPTCHA token is not a
secret). The full flow across three steps:

1. **Detect:** `bw.run(detect_snippet).value` → `{recaptcha_v2: {sitekey: "6Lc…"}}`
2. **Solve:** `CaptchaSolver().recaptcha_v2("6Lc…", url).token` → `"03AG…"`
3. **Inject:** `bw.run(inject_snippet_with_token)` then submit the form.
