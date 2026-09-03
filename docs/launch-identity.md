# Launch identity

Launch identity keeps BetterWright's managed browser coherent across the two
layers that sites score. It replaces the old "Cloaking V2" layer; the browser
is always the managed BetterChromium fork (see
[chromium-fork.md](chromium-fork.md)). For a browser that is not the managed
fork, see [browser-providers.md](browser-providers.md).

1. **Chromium layer** - the fork's source-level patches, a stable
   fingerprint seed, and native locale/timezone flags.
2. **IP layer** - an optional upstream egress proxy chained through the local
   policy guard, with locale/timezone resolved to match the egress geography.

The model API is unchanged: snippets, snapshots, `human.*`, `captcha.*`,
credentials, and proof captures work as before.

## The fork presents the host it runs on

The identity layer deliberately does **not** mask the operating system. A
Linux host is a Linux browser: `navigator.platform`, the UA, UA-CH client
hints, screen geometry, and GPU strings all report the real platform, kept
coherent by the fork's source patches. Masking a Linux process as a consumer
Mac made every mismatch (fonts, WebGL renderer, media codecs, worker
behavior) a separate tell; the fork's patches keep a headless Linux browser
coherent *as* a Linux desktop browser instead. The explicit `platform` option
remains for pinning a specific identity, but nothing defaults away from the
host.

The identity layer does not monkey-patch browser APIs in the page world. The
managed binary remains authoritative for canvas, WebGL, audio, fonts,
plugins, hardware, automation markers, and client hints.

| Surface | Behavior |
| --- | --- |
| Geometry | Native fork geometry; headed-invisible parks a real window off-screen |
| Locale | `--lang`, `--fingerprint-locale`, and Accept-Language |
| Timezone | `--bw-timezone`, so `Intl` and `Date` agree |
| Platform | `--fingerprint-platform=<host>` — the real host OS |
| GPU, plugins, hardware | Fork source-level fingerprint patches |
| JavaScript APIs | Left native; no replacement getters or functions |
| Service workers | Allowed natively; traffic still crosses the policy guard |

Forcing page-world values made a synthetic probe look perfect once, but live
reCAPTCHA checks stalled. Leaving the APIs native restored server-verified
`0.9` in both true-headless and headed modes.

## Launch modes

- **Headless** (default): a real `--headless` fork process with a realistic
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

Compile the harness first with `bun run build`.

```bash
bun research/stealth-report.ts
bun research/stealth-report.ts --live
bun research/stealth-report.ts --live --site recaptcha-v3-score
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

Interactive CAPTCHA issuance is a separate gate. In the current public-demo
runs, Turnstile remained at `processing` without a token in both modes, while
reCAPTCHA v2 escalated to an image grid that requires vision. The report prints
`tokenIssued` explicitly so those outcomes cannot be mistaken for a pass.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `launchIdentity` | `true` | Coherent locale/timezone identity layer. CLI: `--no-launch-identity` |
| `upstreamProxy` | - | `http://` / `socks5://` egress proxy. CLI: `--upstream-proxy` |
| `geoip` | `false` | Locale/timezone from egress IP. CLI: `--geoip` |
| `locale` | - | Explicit BCP 47 locale. CLI: `--locale` |
| `timezone` | - | Explicit IANA timezone. CLI: `--timezone` |
| `platform` | host | Identity platform pin (default: the real host OS). CLI: `--platform` |
| `headedInvisible` | `false` | Off-screen headed window. CLI: `--headed-invisible` |
| `stealthRuntimeFix` | `false` | Optional patchright isolated-world execution |
