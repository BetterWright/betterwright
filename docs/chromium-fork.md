# BetterChromium

BetterWright can run the pinned BetterChromium 151 fork while keeping
its public `run()`, `human.*`, `captcha.*`, snapshot, policy, proxy, and vault
APIs unchanged. On platforms with a checksum-pinned release asset,
`betterwright setup` / `betterwright update` download the fork into the
zero-config discovery root. It is the default runtime backend on supported
hosts. Platforms without a published artifact automatically use the managed
CloakBrowser compatibility backend.

## Install / update

```bash
betterwright update          # download fork → ~/.betterwright/chromium/
betterwright update --force  # re-fetch + re-verify even if already present
betterwright setup           # install the managed browser for this host
betterwright setup --cloak-only  # explicit CloakBrowser compatibility mode
```

Artifacts come from a revisioned GitHub Release tag such as
`betterchromium-<version>-rN` (see `CHROMIUM_FORK_RELEASE_TAG` /
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

The public manifest contains verified macOS arm64, Linux x64, and Windows x64
archives. A platform archive is accepted only when its complete bytes match the
SHA-256 value pinned in `src/chromium-fork.ts`.

`BETTERWRIGHT_CHROMIUM_PATH` takes precedence over
`BETTERWRIGHT_CHROMIUM_ROOT`. Configured paths must be absolute and must exist;
BetterWright fails closed instead of silently falling back to another browser.

Set the backend policy independently of artifact location:

```bash
export BETTERWRIGHT_BACKEND=auto            # default: use capability policy
export BETTERWRIGHT_BACKEND=chromium-fork   # require the native fork
export BETTERWRIGHT_BACKEND=cloak           # require compatibility mode
```

An invalid value is an error. Forced BetterChromium remains fail-closed when
its artifact is absent; forced Cloak ignores native path settings because they
are irrelevant to the selected backend.

## Zero-Config Discovery and Platform Routing

With neither variable set, BetterWright checks the default root
`~/.betterwright/chromium/` for the current platform's artifact. Found → the
fork runs with no configuration at all. If this platform has no published
artifact, BetterWright automatically uses managed CloakBrowser. If the platform
is supported but its artifact is missing, launch fails with setup guidance.

```text
~/.betterwright/chromium/
  mac-arm64/BetterChromium.app/Contents/MacOS/BetterChromium
  linux-x64/betterchromium          (+ fonts/ttf/ for the macOS-metric font set)
  win-x64/betterchromium.exe
```

This makes mixed fleets consistent: `betterwright update` (or `setup`) installs
BetterChromium wherever the manifest has a matching archive and CloakBrowser
everywhere else. Set `BETTERWRIGHT_CHROMIUM_ROOT=off` (or
`BETTERWRIGHT_CHROMIUM_PATH=off`) to explicitly select CloakBrowser on a
supported host.

## Containers and OS sandboxes

On supported platforms BetterChromium remains fail-closed: a missing native
artifact does not silently change browser engines. A container or
`bwrap --clearenv` lane must bind the installed artifact into the sandbox and
set an absolute path inside that namespace, for example:

```bash
betterwright setup
# Bind ~/.betterwright/chromium at /opt/betterwright/chromium in the sandbox,
# then set this inside the cleared environment:
export BETTERWRIGHT_CHROMIUM_ROOT=/opt/betterwright/chromium
```

The profile, runtime, and artifacts under `BETTERWRIGHT_HOME` need their normal
writable mount. On Linux, binding an accessible `/dev/dri` render device keeps
native BetterChromium selected. Without one, BetterWright automatically uses
CloakBrowser so WebGL remains available; install and bind its cache too (or run
`betterwright setup` inside the sandbox). When a minimal `bwrap --dev` or
container mount hides `/dev/dri` and the operator has independently verified
the native path, set `BETTERWRIGHT_BACKEND=chromium-fork` inside the cleared
environment. The forced choice and missing-device warning appear in run results
and `betterwright doctor`; verify WebGL in that exact sandbox. Every network
connection still passes through the worker's local SOCKS guard.

**Profiles are not interchangeable.** Fork and Cloak share
`$BETTERWRIGHT_HOME/browser/profile` by default. Prefer a dedicated home for
fork deployments (e.g. `BETTERWRIGHT_HOME=~/.betterwright-fork`). If Chromium
151 already upgraded the profile, 1.8.1 preserves it and opens the older Cloak
backend in a stable nested compatibility profile. Sign-ins in the original
profile are not copied, but new compatibility-backend sign-ins persist across
restarts.

**Match timezone/locale to egress** (or enable `geoip` with `upstreamProxy`).
Nothing in the fork hard-codes Singapore or any other region — pin whatever
geography the exit IP actually has.

## Control Plane

The fork is launched through stock `playwright-core` over normal CDP. Custom
behavior lives in Chromium/V8 (deferred inspector console delivery). No
page-world stealth shim is installed. Patchright/`stealthRuntimeFix` is
rejected when the fork is configured.

## Runtime Efficiency

The managed launch profile applies a soft renderer-process ceiling of two.
That removes Chromium 151's unused spare renderer for the normal one-page
workload while retaining Chromium's ability to exceed the ceiling whenever
site isolation requires another process.

Screenshots are encoded with Playwright's CSS-pixel scale. This does not change
the page viewport, device pixel ratio, screen metrics, canvas/WebGL rendering,
or WebGPU identity. It only avoids storing four physical pixels for every CSS
pixel in proof artifacts produced by the captured DPR-2 profile.

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
real menu-bar/Dock `availHeight`, dark appearance, 12 cores, and
`deviceMemory` 16. The native web-preference override makes
`prefers-color-scheme: dark` part of that captured identity without enabling
force-dark page transformations; the Playwright launch context reinforces it
with native `colorScheme: "dark"` media emulation. See `src/fork-identity.ts`.

Two layers apply it without any page-world JavaScript shims:

1. **Launch layer** — `--fingerprint-platform`, window-size/DPR flags, and
   context-level `userAgent` and `colorScheme: "dark"` baselines (correct from
   the first navigation).
2. **CDP emulation layer** — per-page `Emulation.setUserAgentOverride` with
   full `UserAgentMetadata` (the DevTools protocol path, invisible to
   getter/toString probes), plus hardware-concurrency override where the
   build supports it.

The binary patch set in
[chromium-fork-patches.md](chromium-fork-patches.md) is implemented and
verified: UA/UA-CH at the source, `navigator.platform`, WebGL
renderer/vendor, deterministic per-profile canvas/audio farbling, screen and
window geometry (including a nonzero synchronous outer-window fallback), and a
bundled macOS-metric font set loaded through a launch-time `FONTCONFIG_FILE`.
With timezone/locale matched to egress geography the
headless Linux fork returns real Google SERPs instead of `/sorry`.

Cloaking V2 identity coherence still applies; see [cloaking-v2.md](cloaking-v2.md).
