# BetterChromium 151 build

This directory is the reproducible definition for the browser source worktree. Chromium itself remains an external gclient checkout.

Pinned revisions:

- Chromium `151.0.7922.108`: `4744b886309d987d292e43232776d2206cccb13d`
- V8: `20ad8d002c17ccc7ccfbefc6c4dcf1242fe80921`

## Checkout and patch

Copy `gclient-151.py` to `<work>/.gclient`, run `gclient sync`, then:

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

The default profile is a static release build with proprietary Chrome codecs. PGO remains disabled in the reproducible default because Chromium profile artifacts are platform/revision coupled. PGO/ThinLTO candidates must be benchmarked against this control before replacing it.

## Package

```sh
scripts/chromium/package.sh mac <work>/src/out/BetterChromiumStatic /tmp/betterchromium-mac-arm64.zip
scripts/chromium/package.sh linux <work>/src/out/LinuxStatic /tmp/betterchromium-linux-x64.zip
scripts/chromium/package.sh win <work>/src/out/WinStatic /tmp/betterchromium-win-x64.zip
```

Apple system fonts are never included in public archives. `research/assemble-mac-fonts.sh` remains a private deployment overlay.
