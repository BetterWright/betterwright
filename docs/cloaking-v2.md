# Cloaking V2

Cloaking V2 keeps BetterWright's managed browser identity coherent across the
two layers that sites score. For the opt-in Chromium 150/V8 inspector fork, see
[chromium-fork.md](chromium-fork.md).

1. **Chromium layer** - CloakBrowser's source-level patches, a stable
   fingerprint seed, native locale/timezone flags, and binary-specific native
   geometry handling.
2. **IP layer** - an optional upstream egress proxy chained through the local
   policy guard, with locale/timezone resolved to match the egress geography.

The model API is unchanged: snippets, snapshots, `human.*`, `captcha.*`,
credentials, and proof captures work as before.

## Native surfaces

V2 deliberately does not monkey-patch browser APIs in the page world. The
managed binary remains authoritative for canvas, WebGL, audio, fonts, plugins,
hardware, automation markers, and client hints.

| Surface | V2 behavior |
| --- | --- |
| Geometry | Native Cloak geometry plus BetterWright's build-specific viewport compatibility |
| Locale | `--lang`, `--fingerprint-locale`, and Accept-Language |
| Timezone | `--fingerprint-timezone`, so `Intl` and `Date` agree |
| GPU, plugins, hardware | CloakBrowser source-level fingerprint patches |
| JavaScript APIs | Left native; no replacement getters or functions |
| Service workers | Allowed natively on both managed-browser backends; traffic still crosses the policy guard |

That last row is important. Fresh stock Chrome 150 leaves `chrome.runtime`
unavailable to ordinary web pages and can initially enumerate zero speech
voices. An earlier V2 init pack forced those values and made a synthetic probe
look perfect, but live reCAPTCHA checks stalled. Removing the page-world shims
restored server-verified `0.9` in both true-headless and headed modes.

## Launch modes

- **Headless** (default): a real `--headless` Cloak process with a realistic
  desktop viewport. This is not an off-screen headed substitute.
- **Headed** (`--headed`): a normal visible browser window.
- **Headed-invisible** (`headedInvisible: true` / `--headed-invisible`): a
  headed window parked off-screen for workflows that explicitly need native
  window compositing.

## Egress proxy

```js
const browser = new BetterWright({
  upstreamProxy: "socks5://user:pass@residential-egress:1080",
  geoip: true,
});
```

- Supports `http://` and `socks5://` upstreams with optional credentials.
- Every connection is still policy-checked and DNS-validated locally.
- The guard tunnels to the validated literal IP, preserving DNS-rebinding
  protection while the target observes the upstream IP.
- WebRTC is forced onto the proxied path.
- `geoip: true` resolves locale/timezone through the upstream. Explicit
  `locale` and `timezone` values always win.

## Verification

Compile the harness first with `npm run build:harness`.

```bash
node scripts/stealth-report.js
node scripts/stealth-report.js --live
node scripts/stealth-report.js --live --site recaptcha-v3-score
```

The local fixture checks roughly 30 browser surfaces against stock-Chrome
behavior. Live acceptance uses server-verified score endpoints:

| Check | True headless | Headed |
| --- | --- | --- |
| Local fixture | stock-Chrome parity | stock-Chrome parity |
| `antcpt.com/score_detector` | 0.9 | 0.9 |
| `democaptcha.com` | 0.9 | 0.9 |

`recaptcha-demo.appspot.com` is not an acceptance gate. Its widget currently
reports that the site exceeded its Enterprise free quota, so an unresolved
request there does not establish browser detection.

A direct MV3 extension probe and the normal Playwright-backed BetterWright
runtime both return `0.9` on healthy endpoints. This falsifies the premise that
merely attaching CDP causes universal refusal. BetterWright therefore retains
the full `run()` API rather than replacing it with a smaller extension-only
interpreter.

Interactive CAPTCHA issuance is a separate gate. In the current public-demo
runs, Turnstile remained at `processing` without a token in both modes, while
reCAPTCHA v2 escalated to an image grid that requires vision. The report prints
`tokenIssued` explicitly so those outcomes cannot be mistaken for a pass.

Sites frequently preload invisible Enterprise CAPTCHA providers before a form
is submitted. BetterWright reports those frames only after their iframe becomes
visible or the page presents an explicit blocking verification prompt, so a
dormant provider cannot derail an otherwise normal signup or login flow.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `cloakV2` | `true` | Native coherent-identity layer. CLI: `--no-cloak-v2` |
| `upstreamProxy` | - | `http://` / `socks5://` egress proxy. CLI: `--upstream-proxy` |
| `geoip` | `false` | Locale/timezone from egress IP. CLI: `--geoip` |
| `locale` | - | Explicit BCP 47 locale. CLI: `--locale` |
| `timezone` | - | Explicit IANA timezone. CLI: `--timezone` |
| `headedInvisible` | `false` | Off-screen headed window. CLI: `--headed-invisible` |
| `stealthRuntimeFix` | `false` | Optional patchright isolated-world execution |
