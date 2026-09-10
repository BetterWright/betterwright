# Chromium fork patch set

The pinned BetterChromium 151 fork carries a small set of source patches
on top of upstream Chromium. This page is the reference for what each one
changes and why it lives in the browser source rather than in the JS layer.
Install, discovery, and the runtime options are in
[chromium-fork.md](chromium-fork.md).

The current launcher uses `src/launch-identity.ts` and defaults to the host's
real operating system. It does not install the former `src/fork-identity.ts`
CDP masking layer or configure a macOS font collection on Linux. Native patch
behavior still covers non-page contexts, WebGL, canvas readback, and audio.

The aggregate [Chromium patch](../patches/chromium-151/chromium-betterchromium-151.patch)
retains optional macOS-mask hunks gated on `--fingerprint-platform=macos`.
Their reference values below came from Google Chrome 151.0.7922.108 on Apple
silicon under macOS 26.6; they are not the default Linux identity. Other hunks
apply to Linux or to fingerprint seeds independently of that mask. Per-profile
variation is keyed to `--fingerprint=<seed>`. The font and performance
measurements below are historical build evidence, not current-release results.

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
when no accessible `/dev/dri` render device exists, leaving WebGL blocked. On
GPU-less Linux the fork therefore launches with its software fallback
(SwiftShader) so WebGL keeps working on the CPU, and `doctor` reports the
fallback as a warning.

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

On an honest Linux identity these patches make the browser present as a real
desktop Linux machine rather than a headless server, without page scripts or
prototype overrides:

- The Playwright launch context sets its native `colorScheme: "dark"`
  media-emulation option, so `prefers-color-scheme: dark` resolves without a
  page shim. A light-scheme default is CreepJS's `prefersLightColor`
  like-headless tell.
- `layout_theme.cc` maps the `ActiveText` CSS system color to system blue
  (`#007aff` light, `#0a84ff` dark) on every Linux identity, not only the
  macOS mask. Stock Linux surfaces the color provider's active-link red
  (`rgb(255,0,0)`), which is CreepJS's `hasKnownBgColor` tell.
- `chrome_content_renderer_client.cc` enables Blink Web Share on Linux
  unconditionally (no longer gated behind `--fingerprint-platform=macos`).
  There is still no Linux share-sheet backend, so `navigator.share()` rejects
  at call time — the API surface is present, the platform operation is not,
  matching desktop Chrome's contract. Absence of `share`/`canShare` is
  CreepJS's `noWebShare` tell.
- `runtime_enabled_features.json5` marks `ContentIndex`, `ContactsManager`,
  and `NetInfoDownlinkMax` stable on Linux so `window.ContentIndex`,
  `window.ContactsManager`, and `NetworkInformation.prototype.downlinkMax`
  exist (CreepJS's `noContentIndex` / `noContactsManager` / `noDownlinkMax`
  presence checks). These are presence-only; there is no desktop indexing or
  contacts backend behind them.
- `network_information.cc` reports a 10 Gbps `downlinkMax` ceiling on Linux
  instead of the invalid sentinel, since a desktop has no modem to measure a
  link speed.

A real display stack completes the picture: under a window manager and panel
that publish `_NET_WORKAREA`, `screen.availHeight < screen.height`, so
`noTaskbar` reads false as it would on a physical desktop.

## 8. Historical macOS-metric font setup

The earlier Linux-to-macOS masking experiment also used a local macOS-metric
font collection. This is not part of the current launcher or the public
artifact:

- `research/assemble-mac-fonts.sh`, run on macOS, copies 36 mac-metric fonts
  (Helvetica and Helvetica Neue, the Arial and Times New Roman sets, Courier
  New, Georgia, Verdana, Trebuchet, Menlo, Monaco, SFNS, Palatino, Futura,
  Avenir Next, Apple Color Emoji, …) into `artifacts/linux-x64/fonts/ttf`.
  Apple-licensed fonts are not redistributed in the public artifact.
- The former worker wrote an absolute-path `fonts.conf` into the profile
  runtime directory and set `FONTCONFIG_FILE` through `prepareForkFontsConfig`
  in the removed `src/fork-identity.ts`. Current launches do not do this.

With that set in place, the recorded experiment enumerated 470 faces with
`fc-list`, and `measureText` widths differed per family (Helvetica Neue 291,
Menlo 247, Georgia 307, Palatino 307, Avenir Next 304) instead of collapsing
onto a single fallback. These are measurements of that local font set.

## 9. Linux font-data file sharing

The FontDataService hunks now live in
[`patches/chromium-151/chromium-betterchromium-151.patch`](../patches/chromium-151/chromium-betterchromium-151.patch),
which applies from the Chromium source root; there is no separate Chromium 151
font-data patch file. The earlier standalone change was validated against Chromium
`e69b30bba288603e514cffb4c79c359cac68e923` and Skia
`bee4c917220040e147f14964635ff92ce6c5a3f6`.

The aggregate removes the service's assertion that Linux/ChromeOS typefaces
cannot expose a resource path. When Skia supplies a backing-file identity,
`FontDataService` can hand renderers a read-only file handle rather than copying
the complete font into an anonymous shared memory region. TTC indices,
variation coordinates, synthetic styles, the memory fallback, and renderer-side
per-file mapping are unchanged. The aggregate also adds a standalone
`font_data_service_unittests` target and changes Linux test expectations to
the file-handle path while retaining explicit memory-fallback tests.

The earlier standalone patch also implemented the backing-file identity in
Skia's FontConfig typefaces. Those Skia hunks are not in the current Chromium
151 aggregate; applying its service-side changes alone does not establish that
Skia supplies the path.

The recorded memory benefit was greatest with the historical local mac-metric
collection above, where the old fallback held large font mappings alongside
deleted `/tmp/.org.chromium.*` copies. That collection is not bundled publicly.

## 10. Linux renderer soft limit

The renderer-limit hunk in
[`patches/chromium-151/chromium-betterchromium-151.patch`](../patches/chromium-151/chromium-betterchromium-151.patch)
makes four the Linux binary's native default
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

In the recorded four-renderer compiled-artifact comparison, summed Chromium PSS
fell 29.62%, 29.81%, 25.96%, and 28.50% at 1, 5, 10, and 20 same-site tabs
against the PGO control.
Concurrent deterministic throughput moved between +0.55% and +1.42%, and live
CPU-seconds per 1,000 operations improved between 1.55% and 8.67%. These are
historical measurements, not measurements of the current managed launch.

BetterWright now passes `--renderer-process-limit=2` from
`src/browser-runtime.ts`, overriding that native default. Caller switches that
collide with a managed switch are ignored with a warning, so
`BETTERWRIGHT_CHROMIUM_ARGS=--renderer-process-limit=N` cannot raise the limit
for a managed launch. The current two-renderer limit remains soft: site
isolation can still require additional processes.

## 11. Build flags

`out/LinuxStatic` builds with `proprietary_codecs=true`,
`ffmpeg_branding="Chrome"`, `is_component_build=false`, and `target_cpu="x64"`.

## Coherence with egress

The patch set cannot guarantee session acceptance. In the earlier recorded
egress experiment, the headless Linux fork returned a Google SERP only after
timezone and locale matched the exit IP (`timezone: "Asia/Singapore"` and
`locale: "en-US"` for that Singapore exit). This is historical evidence, not a
current search workflow or an acceptance guarantee. Configure geography for
the actual exit, or use `geoip: true` with an upstream proxy; no region is the
default for every session.

`research/stealth-report.ts` inspects a built artifact — roughly 30 local surface
checks against stock-Chrome behavior, plus the live score endpoints described in
[launch-identity.md](launch-identity.md#verification):

```bash
bun run build
BETTERWRIGHT_CHROMIUM_PATH=/path/to/linux-x64/betterchromium \
  bun research/stealth-report.ts --live
```
