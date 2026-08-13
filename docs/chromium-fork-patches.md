# Chromium fork patch set

The pinned BetterChromium 151 fork carries a small set of source patches
on top of upstream Chromium. This page is the reference for what each one
changes and why it lives in the browser source rather than in the JS layer.
Install, discovery, and the runtime options are in
[chromium-fork.md](chromium-fork.md).

`src/fork-identity.ts` masks the user agent, UA-CH, `navigator.platform`, and
screen geometry through launch flags and CDP emulation. The surfaces below are
reachable only from Chromium source, so the binary stays coherent where CDP
cannot follow: service workers and other non-page contexts, WebGL, canvas
readback, audio rendering, and font enumeration.

Every patch is gated on `--fingerprint-platform=macos`, the flag the launcher
passes, and per-profile variation is keyed to `--fingerprint=<seed>`. The masked
values are the ones genuine Google Chrome 151.0.7922.108 reports on Apple
silicon under macOS 26.6 — the same table `src/fork-identity.ts` applies from
the launch side, so both layers describe one machine rather than two.

## 1. Platform identity at the source

**`components/embedder_support/user_agent_utils.cc`**

- `GetUserAgent()` returns
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<major>.0.0.0 Safari/537.36`
  when masked, and never emits the `Headless` marker under `--headless` — the
  stock headless user agent is an immediate tell.
- `GetUserAgentMetadata()` reports `platform = "macOS"`,
  `platform_version = "26.6.0"`, `architecture = "arm"`, `model = ""`,
  `bitness = "64"`, `mobile = false`.
- The brand list (`GenerateBrandVersionList` / `GetBrandVersionList`) emits the
  consumer-Chrome triple: `Not;A=Brand v8(.0.0.0)`, `Chromium v<major>`,
  `Google Chrome v<full>`.

**`third_party/blink/renderer/core/frame/navigator_id.cc`**

`NavigatorID::platform()` returns `"MacIntel"` when masked. Real Apple silicon
Chrome reports `MacIntel` too; there is no `MacARM` to invent.

Because these are source values, service workers and other non-page contexts
inherit them, which the CDP emulation layer cannot reach.

## 2. WebGL

**`third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc`**

`WebGLRenderingContextBase::getParameter` intercepts the
`WEBGL_debug_renderer_info` parameters when masked:

| Parameter | Masked value |
| --- | --- |
| `UNMASKED_VENDOR_WEBGL` | `Google Inc. (Apple)` |
| `UNMASKED_RENDERER_WEBGL` | `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)` |

`VENDOR` and `RENDERER` keep returning `WebKit` and `WebKit WebGL`, which is
what real Chrome returns for the non-debug parameters. The WebGL2 context
inherits the same base implementation, so one interception covers both.

Chromium 151 no longer guarantees an automatic software WebGL fallback. The
r1 Linux BetterChromium binary cannot initialize its bundled SwANGLE renderer
when no accessible `/dev/dri` render device exists, leaving WebGL blocked. The
BetterWright launcher therefore keeps native BetterChromium on GPU-capable
hosts and automatically selects managed CloakBrowser on GPU-less Linux. That
backend supplies a working software-rendered WebGL context without opting into
Chromium's lower-security `--enable-unsafe-swiftshader` switch.

## 3. Canvas noise

The goal is a canvas hash that is unique to a profile and seed and **stable
across restarts** — per-session randomization is itself a detection signal.

A shared renderer helper
(`third_party/blink/renderer/platform/graphics/fingerprint_noise.{h,cc}`)
applies FNV-1a over the `--fingerprint` seed plus splitmix64 per pixel: ±1 on
one color channel, alpha untouched. It is hooked at each readback surface:

- `image_data_buffer.cc` — `ImageDataBuffer::FarbleIfEnabled()` copies the
  readback and re-points `pixmap_`, covering `toDataURL`, `toBlob`,
  `OffscreenCanvas.convertToBlob`, and audits. It never writes into
  `peekPixels` memory, which is the live canvas backing store.
- `base_rendering_context_2d.cc` — `getImageData`, after a successful
  `readPixels`.
- `webgl_rendering_context_base.cc` — WebGL `readPixels` (RGBA /
  UNSIGNED_BYTE).

On Linux x64, `canvasHash`, `getImageDataHash`, and `webglReadPixelsHash` are
identical across two cold starts with one seed, and all three change with a
different seed.

## 4. Audio

`offline_audio_context.cc` — `FireCompletionEvent()` applies
`ApplyFingerprintAudioNoise` (±5e-7, keyed on seed and channel) to every channel
of the rendered buffer, so the audio fingerprint is stable per profile and
distinct per seed.

## 5. Hardware surfaces

- `navigator_base.cc` — `hardwareConcurrency` reports `12` when masked. (The
  CDP `Emulation.setHardwareConcurrencyOverride` path covers pages only.)
- `navigator_device_memory.cc` — `deviceMemory` reports `16`, Chrome's bucketed
  value for the masked configuration.

## 6. Screen and window geometry

`ui/ozone/platform/headless/headless_screen.cc` reports bounds of **3600×2338
physical** with `TLBR(78,0,162,0)` insets. Under
`--force-device-scale-factor=2` that resolves to CSS `1800×1169`,
`availHeight 1049`, `dpr 2` — the menu bar and Dock accounted for, as on the
machine being described.

Linux Ozone headless does not have a native browser frame, and its Aura
top-level and content bounds can be empty during initial synchronous page
reads. Under the macOS mask only,
`RenderWidgetHostViewAura::GetBoundsInRootWindow()` returns the captured
`1800×1168` maximized frame while content bounds are empty, preserving the
reported origin. Once content bounds exist, it retains their width and adds 86
CSS px of vertical browser chrome, so the observed `1800×1082` viewport reaches
the same outer size. This keeps early and later `window.outerWidth/outerHeight`
reads coherent and nonzero, one pixel below the `1800×1169` screen height as is
plausible for maximized macOS bounds. Unmasked Linux and all non-Linux behavior
are unchanged.

## 7. Native platform-exposure surfaces

Two renderer features also follow the macOS identity on Linux, without page
scripts or prototype overrides:

- `chrome_content_browser_client.cc` sets Blink's preferred content and root
  scrollbar color schemes to dark. This makes `prefers-color-scheme: dark` part
  of the captured identity without enabling force-dark page transformations.
  The Playwright launch context reinforces the native source preference through
  its native `colorScheme: "dark"` media-emulation option, not a page shim.
- `layout_theme.cc` maps the `ActiveText` CSS system color to macOS system blue
  (`#007aff` in light appearance, `#0a84ff` in the captured dark appearance),
  instead of exposing Linux's red active-link color.
- `chrome_content_renderer_client.cc` enables Blink Web Share when
  `--fingerprint-platform=macos`; stock Linux remains disabled, while upstream
  Android, ChromeOS, Windows, and macOS behavior is unchanged. This exposes the
  native Blink API surface, but Linux still has no macOS share-sheet backend,
  so availability does not guarantee a successful platform share operation.

## 8. Fonts

Font metrics are the strongest Linux-to-macOS tell, and nothing in the JS layer
can fake them:

- `research/assemble-mac-fonts.sh`, run on macOS, copies 36 mac-metric fonts
  (Helvetica and Helvetica Neue, the Arial and Times New Roman sets, Courier
  New, Georgia, Verdana, Trebuchet, Menlo, Monaco, SFNS, Palatino, Futura,
  Avenir Next, Apple Color Emoji, …) into `artifacts/linux-x64/fonts/ttf`.
  Apple-licensed fonts are not redistributed in the public artifact.
- The worker writes an absolute-path `fonts.conf` into the profile runtime
  directory and launches the fork with `FONTCONFIG_FILE` pointing at it
  (`prepareForkFontsConfig` in `src/fork-identity.ts`, gated on the macOS mask).

With that set in place, `fc-list` enumerates 470 faces and `measureText` widths
differ per family (Helvetica Neue 291, Menlo 247, Georgia 307, Palatino 307,
Avenir Next 304) instead of collapsing onto a single fallback.

## 9. Linux font-data file sharing

[`patches/chromium-151/font-data-file-sharing.patch`](../patches/chromium-151/font-data-file-sharing.patch)
applies from the Chromium source root. It was validated against Chromium
`e69b30bba288603e514cffb4c79c359cac68e923` and Skia
`bee4c917220040e147f14964635ff92ce6c5a3f6`.

Upstream, `getResourceName()` is unimplemented on Linux and ChromeOS, so
`FontDataService` always falls back to copying a complete font into an anonymous
shared memory region. The patch lets Skia's FontConfig-backed typefaces expose
their backing file identity, so the service can hand renderers a read-only font
file handle instead. TTC indices, variation coordinates, synthetic styles, the
fallback for typefaces that are not file-backed, and renderer-side per-file
mapping are all unchanged. The patch also promotes the service's unit tests to a
standalone `font_data_service_unittests` target and moves the Linux
expectations from the memory-region fallback to the file-handle path, while the
explicit memory-fallback tests keep asserting valid shared regions.

This matters most with the bundled mac-metric collection above, where the old
fallback held large font mappings alongside deleted `/tmp/.org.chromium.*`
copies.

## 10. Linux renderer soft limit

[`patches/chromium-151/renderer-process-soft-limit.patch`](../patches/chromium-151/renderer-process-soft-limit.patch)
applies from the Chromium source root and makes four the Linux fork's default
**soft** renderer-process limit, keeping `--renderer-process-limit` as an
explicit override. Chromium's memory-derived default allows dozens of renderers
in a small sandbox, duplicating substantial same-site V8 and Blink state without
adding useful parallelism on four vCPUs.

The default is set through `RenderProcessHost::SetMaxRendererProcessCount()`
during Linux startup — the same global-override path as the command-line switch
— rather than `ContentBrowserClient::GetMaxRendererProcessCountOverride()`,
because Chromium 151's `RemoveRendererProcessLimit` feature can bypass
calculated and embedder limits while deliberately preserving explicit global
overrides.

Site Isolation and process locks are untouched. Once four renderer hosts exist,
Chromium's existing `GetExistingProcessHost()` path may reuse only a *suitable*
renderer: distinct locked sites, origins, profiles, storage partitions, and
cross-origin-isolated contexts still get their own processes and may exceed the
soft limit. The result is bounded same-site process sharing, and the deliberate
tradeoff is that co-resident same-site tabs share renderer crash and debugger
fate. Chromium's own
`SitePerProcessBrowserTest.MainFrameProcessReuseWhenOverLimit` and
`SubframeProcessReuseWhenOverLimit` cover that invariant.

On the compiled Linux artifact, summed Chromium PSS fell 29.62%, 29.81%,
25.96%, and 28.50% at 1, 5, 10, and 20 same-site tabs against the PGO control.
Concurrent deterministic throughput moved between +0.55% and +1.42%, and live
CPU-seconds per 1,000 operations improved between 1.55% and 8.67%. On a host
where same-site renderer parallelism matters more than memory, raise the limit
with `BETTERWRIGHT_CHROMIUM_ARGS=--renderer-process-limit=N`.

## 11. Build flags

`out/LinuxStatic` builds with `proprietary_codecs=true`,
`ffmpeg_branding="Chrome"`, `is_component_build=false`, and `target_cpu="x64"`.

## Coherence with egress

The patch set makes the binary self-consistent; it cannot make the *session*
consistent. A headless Linux fork behind residential egress returns a real
Google SERP for a query a genuine Mac passes only once timezone and locale match
the egress IP (`timezone: "Asia/Singapore"` and `locale: "en-US"` for a
Singapore exit, or `geoip: true` with an upstream proxy). A UTC timezone paired
with a residential exit in another region is a coherence break on its own,
whatever the rest of the surfaces report.

`research/stealth-report.js` inspects a built artifact — roughly 30 local surface
checks against stock-Chrome behavior, plus the live score endpoints described in
[cloaking-v2.md](cloaking-v2.md#verification):

```bash
npm run build:harness
BETTERWRIGHT_CHROMIUM_PATH=/path/to/linux-x64/betterchromium \
  node research/stealth-report.js --live
```
