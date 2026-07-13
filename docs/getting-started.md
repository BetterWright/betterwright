# Getting started

## Install and set up

BetterWright drives a real Chromium through Playwright, so it needs **Node.js
18+** on your `PATH`. The browser itself is downloaded once by `setup`.

### Python

```bash
pip install betterwright
betterwright setup      # downloads the pinned Playwright + Chromium (~150 MB, once)
betterwright doctor     # prints what resolved; should end with "BetterWright is ready."
```

### JavaScript

```bash
npm install betterwright   # the postinstall step downloads Chromium
npx betterwright doctor
```

If `doctor` reports Node missing, install it from <https://nodejs.org> and rerun
`setup`. If it reports Chromium missing, rerun `betterwright setup`.

## Your first run

A snippet is a string of async Playwright JavaScript. The last expression is
returned automatically.

```python
from betterwright import BetterWright

with BetterWright() as bw:
    result = bw.run("await page.goto('https://example.com'); return page.title()")
    print(result.ok)       # True
    print(result.value)    # "Example Domain"
```

```js
import { BetterWright } from "betterwright";

const bw = new BetterWright();
const result = await bw.run("await page.goto('https://example.com'); return page.title()");
console.log(result.ok, result.result);   // true "Example Domain"
await bw.close();
```

## Sessions

A session is an independent set of pages and `state`. Use one per concurrent
task; snippets in the same session share the same tabs across calls.

```python
with BetterWright() as bw:
    checkout = bw.session("checkout")
    checkout.run("await page.goto('https://shop.example/cart')")
    # …a later turn, same tabs still open…
    checkout.run("await page.click('text=Place order')")
```

## Proof of work

Have the agent capture a `proof` screenshot before it claims a task is done, and
return the artifact reference so a UI can show it.

```python
r = bw.run("return screenshot({kind: 'proof', name: 'order-confirmed'})")
print(r.artifacts[0].media_reference)   # MEDIA:/…/order-confirmed-….png
```

## Local development targets

The default policy blocks `localhost`. Opt in when you're driving a dev server:

```python
from betterwright import BetterWright, NetworkPolicy

with BetterWright(policy=NetworkPolicy(allow_loopback=True)) as bw:
    bw.run("await page.goto('http://localhost:5173')")
```

## Where to go next

- [The browser API](browser-api.md) — every global available inside a snippet.
- [Agent guidance](agent-prompt.md) — make a model drive the browser decisively,
  with configurable guardrails.
- [Network policy](network-policy.md) — controlling what the browser can reach.
- [Credentials](credentials.md) — logging in without leaking passwords.
- [CAPTCHA solving](captcha.md) — unblocking authorized flows.
- [Architecture](architecture.md) — how it works and what it does/doesn't secure.
- [Examples](../examples) — runnable Python and JavaScript scripts.
