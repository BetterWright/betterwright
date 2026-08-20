# BetterChromium

BetterWright runs the pinned BetterChromium 151 fork while keeping its
public `run()`, `human.*`, `captcha.*`, snapshot, policy, proxy, and vault
APIs unchanged. On platforms with a checksum-pinned release asset,
`betterwright setup` / `betterwright update` download the fork into the
zero-config discovery root. It is the runtime backend on supported hosts —
the only bundled browser. Platforms without a published artifact, or operators
who want a different browser entirely, use the [provider
option](browser-providers.md) (a local binary, any CDP endpoint, or a cloud
provider).

## Install / update

```bash
betterwright update          # download fork → ~/.betterwright/chromium/
betterwright update --force  # re-fetch + re-verify even if already present
betterwright setup           # install the managed browser for this host
```

Artifacts come from a revisioned GitHub Release tag such as
`betterchromium-<version>-rN` (see `CHROMIUM_FORK_RELEASE_TAG` /
`CHROMIUM_FORK_ASSETS` in `src/chromium-fork.ts`). Revisioning keeps older
published BetterWright packages bound to their original immutable assets.
Each zip is SHA-256 pinned in the manifest before extract.

On Windows, BetterChromium also requires Chromium's version-named private
assembly manifest beside `betterchromium.exe`. BetterWright validates that
manifest and `chrome_elf.dll` before launch. Managed installs missing the
manifest from the `151.0.7922.108-r3` archive are repaired deterministically by
`setup`, `update`, `doctor`, or the next managed-browser resolution; explicitly
configured artifact paths are never modified and receive an actionable error.

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
BetterWright fails closed instead of silently launching another browser.

Set the backend policy independently of artifact location:

```bash
export BETTERWRIGHT_BACKEND=auto            # default
export BETTERWRIGHT_BACKEND=chromium-fork   # require the native fork
```

An invalid value is an error. `chromium-fork` remains fail-closed when its
artifact is absent. (The old `cloak` value and the `=off` path toggle selected
a bundled compatibility browser that no longer exists; both are now rejected
with the migration guidance.)

## Zero-Config Discovery and Platform Routing

With neither variable set, BetterWright checks the default root
`~/.betterwright/chromium/` for the current platform's artifact. Found → the
fork runs with no configuration at all. If the platform is supported but its
artifact is missing, launch fails with setup guidance; if the platform has no
published artifact at all, the error names the provider option.

```text
~/.betterwright/chromium/
  mac-arm64/BetterChromium.app/Contents/MacOS/BetterChromium
  linux-x64/betterchromium
  win-x64/betterchromium.exe
```

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
writable mount. On Linux, an accessible `/dev/dri` render device gives the
fork hardware GL; without one the fork launches with the SwiftShader software
WebGL fallback, and the missing-device warning appears in run results and
`betterwright doctor`. Every network connection still passes through the
worker's local SOCKS guard.

**Profiles are not interchangeable across Chromium majors.** A profile upgraded
by a newer Chromium cannot be opened by an older one; BetterWright preserves
the newer profile and opens the older browser in a stable nested compatibility
profile. Sign-ins in the original profile are not copied, but new
compatibility sign-ins persist across restarts.

**Match timezone/locale to egress** (or enable `geoip` with `upstreamProxy`).
Nothing in the fork hard-codes Singapore or any other region — pin whatever
geography the exit IP actually has.

## Control Plane

The fork is launched through stock `playwright-core` over normal CDP. Custom
behavior lives in Chromium/V8 (deferred inspector console delivery). No
page-world stealth shim is installed. Patchright/`stealthRuntimeFix` applies
to the fork; it cannot be combined with a provider browser.

## Runtime Efficiency

The managed launch profile applies a soft renderer-process ceiling of two.
That removes Chromium 151's unused spare renderer for the normal one-page
workload while retaining Chromium's ability to exceed the ceiling whenever
site isolation requires another process.

Screenshots are encoded with Playwright's CSS-pixel scale. This does not change
the page viewport, device pixel ratio, screen metrics, canvas/WebGL rendering,
or WebGPU identity. It only avoids storing four physical pixels for every CSS
pixel in proof artifacts.

## Identity

| Option | Native behavior |
| --- | --- |
| `locale` | `--lang` and `--fingerprint-locale` |
| `timezone` | `--bw-timezone` (alias `--fingerprint-timezone`) |
| `platform` | `--fingerprint-platform`; defaults to the **host platform** |
| `headless` | Real native headless |
| `headedInvisible` | Headed window parked off-screen |
| `upstreamProxy` / `geoip` | Policy-checked egress; locale/tz from egress when enabled |

## No platform masking

The fork presents the operating system it actually runs on. The earlier
Linux→macOS masquerade (captured consumer-Mac identity, macOS-metric fonts,
window geometry, UA/UA-CH overrides) was removed: every layer of a masked
identity is a separate tell the moment one value disagrees with the host, and
the fork's source patches keep a headless Linux browser coherent *as* a Linux
desktop browser instead. The binary patch set in
[chromium-fork-patches.md](chromium-fork-patches.md) remains — UA/UA-CH at the
source, `navigator.platform`, WebGL renderer/vendor, deterministic
per-profile canvas/audio farbling, and screen and window geometry — now all
reporting the real platform. The explicit `platform` option pins a specific
identity when a workflow genuinely needs one.

Launch-identity coherence still applies; see
[launch-identity.md](launch-identity.md).
