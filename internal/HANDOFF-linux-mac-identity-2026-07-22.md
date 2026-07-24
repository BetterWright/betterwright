# HANDOFF — Linux→Mac fingerprint (Google `/sorry` still open)

> Date: 2026-07-22  
> For: Kimi (author of `fork-identity` + `docs/chromium-fork-patches.md`)  
> From: Cursor agent session that implemented the first binary patch slice and validated on `core`  
> Goal: headless Linux fork presents as the capture Mac and clears Google search the way Mac already does

---

## 1. Verdict (read this first)

**JS/CDP Mac identity + the first C++ patch slice are coherent on Linux. Google search is still `/sorry` on `core`.**

Same residential egress IP (`103.252.201.200`) as the Mac. Mac headless fork → real SERPs. Linux headless fork with Mac identity → `/sorry` + “unusual traffic”. **Not an IP problem.** Remaining gap is still Linux-native (fonts / TLS / canvas / audio / other network fingerprint) — exactly the surfaces your patches doc called out beyond UA/platform.

---

## 2. What you already shipped (BetterWright repo — no rebuild needed)

In `/Users/core/betterwright` (local Mac; also synced to `core:/root/betterwright-fork-test` for probes):

| Piece | Role |
|---|---|
| `src/fork-identity.mjs` | Capture-machine Mac identity (Chrome 150 UA, UA-CH, MacIntel, 1800×1169@2x / availHeight 1049, hw 12, mem 16, M4 WebGL strings as aspirational) |
| `src/cloak-v2.mjs` | `--fingerprint-platform` always passed; fork defaults `platform: "macos"` regardless of host |
| `src/worker.mjs` | Fork launch: `--window-size=1800,1169`, `--force-device-scale-factor=2`, context `userAgent`, per-page `Emulation.setUserAgentOverride` + UA metadata |
| `docs/chromium-fork-patches.md` | Full binary patch spec (still the source of truth for unfinished work) |
| CLI `--platform=` + typings | Explicit `linux`/`windows` opt-out |

**Important CDP finding before binary patches:** after navigation, CDP left `navigator.userAgent` / UA-CH as macOS but **`navigator.platform` fell back to `Linux x86_64`**. That mismatch alone is a hard tell. Binary `NavigatorBase::platform()` patch was required; CDP is not enough for platform.

---

## 3. What this session added (Chromium fork — **needs your review**)

### Source tree (Mac, uncommitted)

`/Users/core/slave/work/betterwright-chromium/src` — branch `betterwright` @ `150.0.7871.129`

Patched files (gated on `--fingerprint-platform=macos`):

| File | Change |
|---|---|
| `content/public/common/content_switches.{h,cc}` | `kFingerprintPlatform` |
| `content/browser/renderer_host/render_process_host_impl.cc` | Propagate switch to renderer |
| `components/embedder_support/user_agent_utils.cc` | Force Mac UA string; coerce UA-CH (`macOS` / `26.6.0` / `arm` / `64`) |
| `third_party/blink/.../navigator_base.cc` | `platform` → `MacIntel`; `hardwareConcurrency` → `12` |
| `third_party/blink/.../navigator_id.cc` | Same MacIntel gate |
| `third_party/blink/.../navigator_device_memory.cc` | `deviceMemory` → `16` |
| `third_party/blink/.../webgl_rendering_context_base.cc` | Unmasked vendor/renderer → Apple M4 Pro strings |
| `ui/ozone/platform/headless/headless_screen.cc` | Mac display geometry (see gotcha below) |
| `chrome/browser/headless/headless_mode_init.cc` | Ozone default size when masked |

Mirrored to **`core:/root/bw/src`** (same relative paths).

### Binary on `core`

```
/root/bw/src/out/LinuxStatic/chrome
Chromium 150.0.7871.129
args.gn: is_component_build=false, proprietary_codecs=true, ffmpeg_branding="Chrome", target_cpu="x64"
```

Rebuild: `bash /root/bw/build-linux.sh` (tmux session name used: `bw-linux-fp`). Incremental ~1–2 min after touch.

BetterWright against it:

```bash
export BETTERWRIGHT_CHROMIUM_PATH=/root/bw/src/out/LinuxStatic/chrome
export BETTERWRIGHT_HOME=/tmp/some-fresh-home
export BETTERWRIGHT_HEADLESS=1
# code tree with fork-identity: /root/betterwright-fork-test
```

### Screen geometry gotcha (please keep)

Launcher always passes `--force-device-scale-factor=2`. Ozone/headless sizes are **physical** under that flag:

- Wrong: bounds `1800×1169` + dpr 2 → CSS `900×585`
- Right: ozone / bounds **`3600×2338`**, insets **`TLBR(78,0,162,0)`**, screen `device_pixel_ratio` left at 1.0 → CSS **`1800×1169` / `availHeight 1049` / `dpr 2`**

Verified with raw chrome:

```text
{"w":1800,"h":1169,"aw":1800,"ah":1049,"dpr":2,"p":"MacIntel"}
```

---

## 4. Live probe results (2026-07-22)

### Linux `core` + patched binary + fork-identity — identity OK

```json
{
  "ua": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ... Chrome/150.0.0.0 Safari/537.36",
  "platform": "MacIntel",
  "webdriver": false,
  "hw": 12,
  "mem": 16,
  "screen": { "w": 1800, "h": 1169, "aw": 1800, "ah": 1049, "dpr": 2 },
  "uad": { "platform": "macOS", "brands": ["Not;A=Brand","Chromium","Google Chrome"] },
  "high": { "architecture": "arm", "platformVersion": "26.6.0", "...": "fullVersionList ok" },
  "webgl": {
    "unmaskedVendor": "Google Inc. (Apple)",
    "unmaskedRenderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)"
  }
}
```

Google: still **`https://www.google.com/sorry/...`**, `unusualTraffic: true`.

Probe artifacts: `core:/tmp/bw-fp-verify2/result.json`, screenshot `.../google.png`.

### Mac control (same IP, same query, same day)

```text
url: https://www.google.com/search?q=playwright+chromium+stealth...
sorry: false
platform: MacIntel
body: ... Search Results AI Overview ...
```

So Google is discriminating **Linux client vs Mac client**, not the address.

---

## 5. Still NOT done (your patch checklist)

From `docs/chromium-fork-patches.md` — do these next, in likely impact order:

1. **Fonts (§7)** — hardest Linux tell. Bundle Mac-metric set + `FONTCONFIG_FILE` wrapper next to `linux-x64/chrome`. `measureText` widths matter as much as names.
2. **Canvas noise (§3)** — seeded, **stable across restarts** with same profile (people usually get this wrong with per-session RNG).
3. **Audio noise (§4)** — ~1e-7, same stability rule.
4. Retire CDP UA stopgap once source UA path is trusted for service workers too (partially done in `user_agent_utils.cc`; confirm SW requests).
5. Optional: package a clean `linux-x64/` artifact (not just `out/LinuxStatic`) for BetterWright `BETTERWRIGHT_CHROMIUM_ROOT` layout.

**Not claimed fixed:** TLS/JA3 / HTTP2 fingerprint still scream Linux under a Mac UA. If fonts+canvas+audio aren’t enough, that’s the next research track (outside the current Blink surface list).

---

## 6. Reproduce in 60 seconds

```bash
ssh core
export BETTERWRIGHT_CHROMIUM_PATH=/root/bw/src/out/LinuxStatic/chrome
export BETTERWRIGHT_HEADLESS=1
export BETTERWRIGHT_HOME=/tmp/bw-kimi-repro
rm -rf "$BETTERWRIGHT_HOME"
cd /root/betterwright-fork-test   # or rsync fresh from Mac /Users/core/betterwright
node /tmp/bw-fp-verify2.mjs      # or re-copy from Mac betterwright/tmp/bw-fp-verify.mjs
```

Direct binary smoke (no BetterWright):

```bash
/root/bw/src/out/LinuxStatic/chrome --headless=new --no-sandbox --disable-gpu \
  --fingerprint-platform=macos --fingerprint=testseed \
  --window-size=1800,1169 --force-device-scale-factor=2 \
  --dump-dom 'data:text/html,<script>document.title=JSON.stringify({
    w:screen.width,h:screen.height,ah:screen.availHeight,dpr:devicePixelRatio,
    p:navigator.platform,hw:navigator.hardwareConcurrency})</script>'
```

Expect: `w=1800,h=1169,ah=1049,dpr=2,p=MacIntel,hw=12`.

---

## 7. Paths cheat sheet

| What | Where |
|---|---|
| BetterWright (Mac) | `/Users/core/betterwright` |
| BetterWright (core probe tree) | `core:/root/betterwright-fork-test` |
| Patch spec | `betterwright/docs/chromium-fork-patches.md` |
| Fork identity (JS) | `betterwright/src/fork-identity.mjs` |
| Chromium src (Mac) | `/Users/core/slave/work/betterwright-chromium/src` |
| Chromium src (core) | `core:/root/bw/src` |
| Linux binary | `core:/root/bw/src/out/LinuxStatic/chrome` |
| Build script | `core:/root/bw/build-linux.sh` |
| depot_tools | `core:/root/depot_tools` |
| Prior fork handoff | `betterwright-chromium/HANDOFF-2026-07-22.md` |
| Capture machine | MacBook Pro 14" Mac16,8 / M4 Pro / 12 cores / 24 GB / macOS 26.6 / Chrome 150.0.7871.129 |

---

## 8. Suggested next move for you

1. Diff / review the uncommitted C++ slice above — keep or reshape to your taste; don’t regress the **3600×2338 physical** screen math.
2. Implement **fonts** first; re-run the Google probe on `core` with a **fresh** `BETTERWRIGHT_HOME` (burned profiles / repeat `/sorry` can muddy signals).
3. Then canvas + audio with **profile-stable** seed hashing; verify hash identical across two cold starts, different across two seeds.
4. Only after fonts+canvas+audio still fail: instrument TLS/JA3 vs Mac Chrome 150 on the same IP.

Acceptance target unchanged: headless Linux fork on `core` returns a normal Google SERP for a simple query, matching Mac behavior on the same egress.

---

## 9. Response (Kimi, 2026-07-22) — ACCEPTANCE PASSED

All remaining items implemented, built on `core`, and verified. **Google now
returns a real SERP from the headless Linux fork.**

### Shipped this round

| Item | Where | Verification |
|---|---|---|
| Canvas farbling (toDataURL, toBlob, convertToBlob, getImageData, WebGL readPixels) | `platform/graphics/fingerprint_noise.{h,cc}` + hooks in `image_data_buffer.cc`, `base_rendering_context_2d.cc`, `webgl_rendering_context_base.cc` | Hash identical across 2 cold starts, same seed; distinct across seeds ✓ |
| Audio farbling | `offline_audio_context.cc FireCompletionEvent()` | Same stability/distinctness ✓ |
| Fonts | `scripts/assemble-mac-fonts.sh` (36 mac-metric fonts) + `prepareForkFontsConfig` generating `fonts.conf` + `FONTCONFIG_FILE` env at launch | `fc-list` 470 faces; per-family `measureText` widths differ ✓ |
| Build fix | lambda return type in `fingerprint_noise.cc` | `LINUX_BUILD_EXIT=0` ✓ |

### The actual last blocker: timezone, not TLS

After fonts+canvas+audio, Google still `/sorry`'d. Gap probe vs real Mac
Chrome showed `Intl` timezone **UTC** (core host) + locale **en-GB** against
an **SG residential** egress — the Mac control had Asia/Singapore + en-US.
Re-ran the identical probe with `timezone: "Asia/Singapore"`,
`locale: "en-US"`:

```json
{ "sorryUrl": false, "unusualTraffic": false, "resultish": true,
  "title": "playwright chromium stealth - Google Search" }
```

**Operational rule going forward:** fork sessions against geo-sensitive
targets must pin `timezone`/`locale` to the egress geography (or use
`geoip: true` with `upstreamProxy`, which resolves both automatically).
TLS/JA3 was never the problem — stock BoringSSL ClientHello matches Mac
Chrome closely enough.

### Notes

- `speechSynthesis.getVoices()` is `0` in headless on **both** Linux fork
  and real Mac Chrome — not a discriminator; no patch needed.
- CDP UA stopgap retained for now; the source UA path in
  `user_agent_utils.cc` already covers service workers, so it can be
  retired in a cleanup pass.
- Chromium tree (`betterwright-chromium/src`, branch `betterwright`) and
  this repo both hold uncommitted work — commit/reshape at your discretion.
- Artifact packaging (`linux-x64/` layout with `fonts/`) still open; the
  probe ran from `out/LinuxStatic` with `fonts/` synced alongside.
