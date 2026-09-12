# BetterChromium 153 build

This directory is the reproducible definition for the browser source worktree. Chromium itself remains an external gclient checkout.

Pinned revisions:

- Chromium `153.0.8010.36`: `507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c`
- V8: `f343157cebb388bfa416baccb5d35507e6fe8cc7`

## Checkout and patch

Copy `gclient-153.py` to `<work>/.gclient`. Before syncing, apply the small
`depot-tools-custom-deps.patch` to depot_tools so it honors `custom_deps: None`
for CIPD packages as well as Git dependencies:

```sh
git -C /path/to/depot_tools apply /absolute/path/to/betterwright/scripts/chromium/depot-tools-custom-deps.patch
```

The config omits old Windows Chrome installers used only by upstream updater
integration tests. They are not inputs to the `chrome` and `inspector-test`
release targets. The depot_tools revision used for this build is
`36a8df4ad006eaa0572fb446edb8145fe5403592`.

Run `gclient sync --no-history` and `gclient runhooks`, then:

```sh
scripts/chromium/apply-patches.sh <work>/src
```

`apply-patches.sh` refuses the wrong revisions or dirty trees and checks both patches before changing either checkout.

## Build

With depot_tools on `PATH`:

```sh
scripts/chromium/build.sh mac <work>/src out/BetterChromiumStatic
scripts/chromium/build.sh linux <work>/src out/LinuxStatic
scripts/chromium/build.sh win <work>/src out/WinStatic
```

The Chromium patch also carries the BetterChromium product name and macOS bundle
identifier, so a clean build produces the bundle expected by the packager.

The default profile is a static release build with proprietary Chrome codecs. PGO remains disabled in the reproducible default because Chromium profile artifacts are platform/revision coupled. PGO/ThinLTO candidates must be benchmarked against this control before replacing it.

## Package

```sh
scripts/chromium/package.sh mac <work>/src/out/BetterChromiumStatic /tmp/betterchromium-mac-arm64.zip
scripts/chromium/package.sh linux <work>/src/out/LinuxStatic /tmp/betterchromium-linux-x64.zip
scripts/chromium/package.sh win <work>/src/out/WinStatic /tmp/betterchromium-win-x64.zip
```

The Windows launcher embeds Chromium's normal version-named private assembly
dependency for `chrome_elf.dll`. Packaging must include the matching
`win-x64/<version>.manifest`; `package.sh` copies the pinned manifest and fails
if `chrome_elf.dll` is absent. Omitting that file makes Windows reject the
executable during activation-context generation before Chromium starts.

Apple system fonts are never included in public archives. `research/assemble-mac-fonts.sh` remains a private deployment overlay.
