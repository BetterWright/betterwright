# Getting started

## Install and set up

BetterWright drives a managed CloakBrowser build through Playwright, so it needs
**Node.js 22+** on your `PATH`. The browser itself is downloaded once by
`setup`.

```bash
npm install betterwright
npx betterwright setup     # downloads the signed managed browser (~200 MB, once)
npx betterwright doctor    # prints what resolved; should end with "BetterWright is ready."
```

If `doctor` reports Node missing, install it from <https://nodejs.org> and rerun
`setup`. If `doctor` reports CloakBrowser missing, rerun
`npx betterwright setup`.

Upgrade with `npm update betterwright` or `npm install betterwright@latest`.
Package updates are intentional rather than automatic, so application lockfiles
continue to control when a new BetterWright version is adopted.

### Managed CloakBrowser backend

Managed launches use CloakBrowser by default. `betterwright setup` asks the
pinned official wrapper to fetch the correct binary directly from CloakHQ's
release source and verify the published checksums with its pinned Ed25519
signature before extraction. BetterWright ships the wrapper integration, not
the separately licensed browser binary, and does not redistribute that binary.

To use a CloakBrowser binary already installed through an official channel,
point `CLOAKBROWSER_BINARY_PATH` at it before starting BetterWright:

```bash
export CLOAKBROWSER_BINARY_PATH="$HOME/.cloakbrowser/chromium-.../chrome"
```

The managed backend keeps one stable fingerprint seed and persistent profile.
That removes several stock automation signals and can reduce false positives;
it cannot guarantee that a site will accept the session or never issue a
challenge.

BetterWright pins the CloakBrowser npm wrapper, while the separately cached
browser binary follows CloakBrowser's signed stable channel. `betterwright
doctor` reports both versions. For a reproducible deployment, set a full
`CLOAKBROWSER_VERSION`; to keep an already installed build from checking for a
newer stable build, set `CLOAKBROWSER_AUTO_UPDATE=false`.

### Explicit Chromium fallback

Use stock Playwright Chromium only when you need compatibility or a deterministic
test browser:

```bash
betterwright setup --chromium
export BETTERWRIGHT_BROWSER=chromium
```

Or select it per client with `browser: "chromium"`.
Supplying `executablePath` also selects this fallback. Stock
Chromium can expose obvious automation signals, including headless branding and
`navigator.webdriver`; it is a degraded fallback, not the recommended backend
for normal agent browsing.

## Your first run

A snippet is a string of async Playwright JavaScript. The last expression is
returned automatically.

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

```js
const bw = new BetterWright();
await bw.run("await page.goto('https://shop.example/cart')", { session: "checkout" });
// …a later turn, same tabs still open…
await bw.run("await page.click('text=Place order')", { session: "checkout" });
```

## Proof of work

Have the agent capture a `proof` screenshot before it claims a task is done, and
return the artifact reference so a UI can show it.

```js
const r = await bw.run("return screenshot({kind: 'proof', name: 'order-confirmed'})");
console.log(r.artifacts[0].media);   // MEDIA:/…/order-confirmed-….png
```

## Local development targets

The default policy reaches `localhost` and the private network, so a dev server
just works. Harden it when the agent runs somewhere its private network is
sensitive:

```js
import { BetterWright, NetworkPolicy } from "betterwright";

// Public internet only — no private network, no loopback.
const bw = new BetterWright({
  policy: new NetworkPolicy({ allowPrivateNetwork: false, allowLoopback: false }),
});
await bw.run("await page.goto('https://example.com')");
```

## Where to go next

- [The browser API](browser-api.md) — every global available inside a snippet.
- [Agent guidance](agent-prompt.md) — make a model drive the browser decisively,
  with configurable guardrails.
- [Attach mode & headed browsing](attach-mode.md) — watch the browser, or drive
  a Chrome you already have open.
- [Network policy](network-policy.md) — controlling what the browser can reach.
- [Credentials](credentials.md) — encrypted storage and trusted host-side use.
- [Native CAPTCHA helpers](captcha.md) — resumable handling for authorized flows.
- [Architecture](architecture.md) — how it works and what it does/doesn't secure.
- [Examples](../examples) — runnable JavaScript scripts.
