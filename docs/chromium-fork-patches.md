# Chromium Fork Fingerprint Patch Set

Build-side patches for the pinned BetterWright Chromium 150 fork. The JS
layer (`src/fork-identity.mjs`) already masks UA, UA-CH, `navigator.platform`,
and screen geometry via launch flags + CDP emulation. The surfaces below are
only reachable from Chromium source — patch them so the binary is coherent
even where CDP cannot reach (service workers, WebGL, canvas, fonts).

All values come from a real capture machine: MacBook Pro 14" (Mac16,8), Apple
M4 Pro, 12 cores / 24 GB, macOS 26.6, display 1800x1169 @2x, running genuine
Google Chrome 150.0.7871.129. Gate every patch on
`--fingerprint-platform=macos` (the flag the launcher passes) and key
per-profile variation to `--fingerprint=<seed>`.

## 1. Platform identity at source (replaces the CDP stopgap)

Once these land, the CDP `Emulation.setUserAgentOverride` layer can be
retired for the fork — source is authoritative, and service workers inherit
it automatically.

**`components/embedder_support/user_agent_utils.cc`**

- `GetUserAgent()`: when masked, force
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<major>.0.0.0 Safari/537.36`
  — and never emit the `Headless` marker in `--headless` mode (the stock
  headless UA is an instant tell).
- `GetUserAgentMetadata()`: `platform = "macOS"`,
  `platform_version = "26.6.0"`, `architecture = "arm"`, `model = ""`,
  `bitness = "64"`, `mobile = false`.
- Brand list (`GenerateBrandVersionList` / `GetBrandVersionList`): emit the
  real consumer-Chrome triple —
  `Not;A=Brand v8(.0.0.0)`, `Chromium v<major>`, `Google Chrome v<full>`.

**`third_party/blink/renderer/core/frame/navigator_id.cc`**

- `NavigatorID::platform()`: return `"MacIntel"` when masked. (Real Apple
  Silicon Chrome still reports `MacIntel` — do not invent `MacARM`.)

## 2. WebGL

**`third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc`**

In `WebGLRenderingContextBase::getParameter`, intercept
`UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL` (extension
`WEBGL_debug_renderer_info`) when masked:

```cpp
case GLenum(Extensions3D::kUnmaskedVendor):
  return String("Google Inc. (Apple)");
case GLenum(Extensions3D::kUnmaskedRenderer):
  return String("ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, "
                "Unspecified Version)");
```

Leave `VENDOR`/`RENDERER` returning `WebKit` / `WebKit WebGL` — that is what
real Chrome returns for the non-debug parameters. Also patch the WebGL2 path
(`webgl2_rendering_context_base.cc` shares the base implementation; verify
the single interception covers both) and GPU process info strings if any
diagnostic surface exposes the real GL renderer (e.g. `chrome://gpu` is not
web-visible, but `WEBGL_debug_renderer_info` via WebGL1 contexts is).

## 3. Canvas noise (unique but stable per profile)

Goal: a canvas hash that is unique to this profile+seed and **stable across
restarts** — per-session randomization is itself a detection signal.

A shared renderer helper
(`third_party/blink/renderer/platform/graphics/fingerprint_noise.{h,cc}`)
applies FNV-1a over the `--fingerprint` seed + splitmix64 per pixel; ±1 on one
color channel per pixel, alpha untouched. Hook it at every readback surface:

- `image_data_buffer.cc` — `ImageDataBuffer::FarbleIfEnabled()` copies the
  readback and re-points `pixmap_` (covers `toDataURL`, `toBlob`,
  `OffscreenCanvas.convertToBlob`, audits). Never writes into `peekPixels`
  memory (that is the live canvas backing store).
- `base_rendering_context_2d.cc` — `getImageData` after a successful
  `readPixels`.
- `webgl_rendering_context_base.cc` — WebGL `readPixels` (RGBA/
  UNSIGNED_BYTE).

Acceptance, verified on a Linux x64 host: identical `canvasHash`/
`getImageDataHash`/`webglReadPixelsHash` across two cold starts with one
seed; all three change with a different seed.

## 4. Audio

`offline_audio_context.cc` — `FireCompletionEvent()` applies
`ApplyFingerprintAudioNoise` (±5e-7, seed+channel keyed) to every channel of
the rendered buffer. Must be stable per profile and distinct per seed.

## 5. Hardware surfaces

- `navigator_base.cc`: `hardwareConcurrency` → `12` when masked. (The CDP
  `Emulation.setHardwareConcurrencyOverride` stopgap covers pages only.)
- `navigator_device_memory.cc`: `deviceMemory` → `16` — the bucketed value
  real Chrome reports on the 24 GB capture machine.

## 6. Screen geometry

`ui/ozone/platform/headless/headless_screen.cc`: with the Mac mask, bounds
**3600×2338 physical** + `TLBR(78,0,162,0)` insets under
`--force-device-scale-factor=2` → CSS `1800×1169`, `availHeight 1049`,
`dpr 2`. Do not regress the physical-pixel math.

## 7. Fonts (the hardest Linux→Mac tell)

- `scripts/assemble-mac-fonts.sh` (run on macOS) copies 36 mac-metric fonts
  (Helvetica/Helvetica Neue, Arial set, Times NR set, Courier New, Georgia,
  Verdana, Trebuchet, Menlo, Monaco, SFNS, Palatino, Futura, Avenir Next,
  Apple Color Emoji…) into `artifacts/linux-x64/fonts/ttf`.
- The worker generates an absolute-path `fonts.conf` in the profile runtime
  dir and launches the fork with `FONTCONFIG_FILE` pointing at it
  (`src/fork-identity.mjs: prepareForkFontsConfig`, gated on the Mac mask).
- Acceptance, verified on a Linux x64 host: `fc-list` enumerates 470 faces;
  `measureText` widths differ per family (Helvetica Neue 291 / Menlo 247 /
  Georgia 307 / Palatino 307 / Avenir Next 304) instead of collapsing to one
  fallback.

## 8. Build flags

`out/LinuxStatic` builds with `proprietary_codecs=true`,
`ffmpeg_branding="Chrome"`, `is_component_build=false`, `target_cpu="x64"`.

## Acceptance

The headless Linux x64 fork behind residential egress must return a **real
Google SERP** (`sorryUrl:false, unusualTraffic:false, resultish:true`) for the
same query a genuine Mac passes, once **timezone and locale match the egress
IP** (e.g. `timezone: "Asia/Singapore", locale: "en-US"` for a Singapore exit
— or `geoip: true` with an upstream proxy). A UTC timezone paired with a
residential exit IP in another region is a coherence break on its own, even
with every other surface patched.

## Validation after build

```bash
BETTERWRIGHT_CHROMIUM_PATH=/path/to/linux-x64/chrome \
  node scripts/stealth-report.mjs --live
```

Probe checklist: `navigator.platform` → `MacIntel`; UA/UA-CH macOS in both
page and service-worker requests; WebGL debug strings as above; canvas hash
stable across two launches with the same profile, different across two
profiles; `screen.availHeight` 1049; `fc-list | wc -l` inside the browser
matches the bundled set; no `Headless` in UA under `--headless`.
