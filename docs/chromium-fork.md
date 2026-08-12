# BetterChromium

BetterWright can run the pinned BetterChromium 151 fork while keeping
its public `run()`, `human.*`, `captcha.*`, snapshot, policy, proxy, and vault
APIs unchanged. On platforms with a checksum-pinned release asset,
`betterwright setup` / `betterwright update` download the fork into the
zero-config discovery root. It is the required/default runtime backend.
CloakBrowser is selected only through an explicit compatibility opt-out.

## Install / update

```bash
betterwright update          # download fork → ~/.betterwright/chromium/
betterwright update --force  # re-fetch + re-verify even if already present
betterwright setup           # install BetterChromium
betterwright setup --cloak-only  # explicit CloakBrowser compatibility mode
```

Artifacts come from a revisioned GitHub Release tag such as
`betterchromium-<version>-r1` (see `CHROMIUM_FORK_RELEASE_TAG` /
`CHROMIUM_FORK_ASSETS` in `src/chromium-fork.ts`). Revisioning keeps older
published BetterWright packages bound to their original immutable assets.
Each zip is SHA-256 pinned in the manifest before extract. Apple-licensed
fonts are **not** in the public zip.

## Runtime Selection

Use an exact executable path:

```bash
export BETTERWRIGHT_CHROMIUM_PATH=/absolute/path/to/betterchromium
betterwright run -c 'return await page.title()'
```

Or point at the packaged artifact root:

```bash
export BETTERWRIGHT_CHROMIUM_ROOT=/absolute/path/to/artifacts
betterwright run -c 'return await page.title()'
```

The artifact-root layout is fixed:

```text
artifacts/
  mac-arm64/BetterChromium.app/Contents/MacOS/BetterChromium
  linux-x64/betterchromium
  win-x64/betterchromium.exe
```

No renamed public archive is currently listed until rebuilt BetterChromium bytes have verified SHA-256 checksums. Windows x64 has a defined build and package layout, but it must remain absent from the download manifest until its release archive checksum is verified.

`BETTERWRIGHT_CHROMIUM_PATH` takes precedence over
`BETTERWRIGHT_CHROMIUM_ROOT`. Configured paths must be absolute and must exist;
BetterWright fails closed instead of silently falling back to another browser.

## Zero-Config Discovery and Platform Routing

With neither variable set, BetterWright checks the default root
`~/.betterwright/chromium/` for the current platform's artifact. Found → the
fork runs with no configuration at all. If it is absent or unsupported, launch
fails with setup guidance; BetterWright never silently switches browsers.

```text
~/.betterwright/chromium/
  mac-arm64/BetterChromium.app/Contents/MacOS/BetterChromium
  linux-x64/betterchromium          (+ fonts/ttf/ for the macOS-metric font set)
  win-x64/betterchromium.exe
```

This makes mixed fleets trivial: run `betterwright update` (or `setup`) on a host only after its platform archive appears in the pinned manifest; every published platform then picks the native backend with the same configuration. Set
`BETTERWRIGHT_CHROMIUM_ROOT=off` (or `BETTERWRIGHT_CHROMIUM_PATH=off`) only to
explicitly select the managed CloakBrowser compatibility backend.

**Profiles are not interchangeable.** Fork and Cloak share
`$BETTERWRIGHT_HOME/browser/profile` by default. Prefer a dedicated home for
fork deployments (e.g. `BETTERWRIGHT_HOME=~/.betterwright-fork`). Switching
`off` after the fork has upgraded that profile requires deleting
`browser/profile` first.

**Match timezone/locale to egress** (or enable `geoip` with `upstreamProxy`).
Nothing in the fork hard-codes Singapore or any other region — pin whatever
geography the exit IP actually has.

## Control Plane

The fork is launched through stock `playwright-core` over normal CDP. Custom
behavior lives in Chromium/V8 (deferred inspector console delivery). No
page-world stealth shim is installed. Patchright/`stealthRuntimeFix` is
rejected when the fork is configured.

## Identity

| Option | Native behavior |
| --- | --- |
| `locale` | `--lang` and `--fingerprint-locale` |
| `timezone` | `--bw-timezone` (alias `--fingerprint-timezone`) |
| `platform` | `--fingerprint-platform`; defaults to `macos` (see masking below) |
| `headless` | Real native headless |
| `headedInvisible` | Headed window parked off-screen |
| `upstreamProxy` / `geoip` | Policy-checked egress; locale/tz from egress when enabled |

## Platform Masking (Linux → macOS)

A headless-Linux browser identity is one of the strongest automation signals
risk engines score, so the fork masks the host platform as a realistic
consumer Mac by default (`platform: "macos"`; opt out with `platform:
"linux"` or `"windows"` in the constructor / `--platform=` on the CLI).

The identity is not invented — every value was captured from genuine Google
Chrome 151.0.7922.108 (the fork's exact pinned version) on an Apple M4 Pro
MacBook Pro running macOS 26.6: UA and UA-CH (brands, `macOS` 26.6.0,
`arm`), `navigator.platform = MacIntel`, 1800×1169 @2x screen geometry with
real menu-bar/Dock `availHeight`, 12 cores, `deviceMemory` 16. See
`src/fork-identity.ts`.

Two layers apply it without any page-world JavaScript shims:

1. **Launch layer** — `--fingerprint-platform`, window-size/DPR flags, and a
   context-level `userAgent` baseline (correct from the first navigation).
2. **CDP emulation layer** — per-page `Emulation.setUserAgentOverride` with
   full `UserAgentMetadata` (the DevTools protocol path, invisible to
   getter/toString probes), plus hardware-concurrency override where the
   build supports it.

The binary patch set in
[chromium-fork-patches.md](chromium-fork-patches.md) is implemented and
verified: UA/UA-CH at the source, `navigator.platform`, WebGL
renderer/vendor, deterministic per-profile canvas/audio farbling, screen
geometry, and a bundled macOS-metric font set loaded through a launch-time
`FONTCONFIG_FILE`. With timezone/locale matched to egress geography the
headless Linux fork returns real Google SERPs instead of `/sorry`.

Cloaking V2 identity coherence still applies; see [cloaking-v2.md](cloaking-v2.md).
