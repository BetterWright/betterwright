#!/usr/bin/env bash
# Assemble the macOS-metric font set for the linux-x64 fork artifact.
#
# Copies the fonts a real consumer Mac presents (the same families
# fingerprint scripts probe) from THIS macOS host into the artifact's
# fonts/ttf directory. Run on macOS, then ship the artifact to Linux:
#
#   research/assemble-mac-fonts.sh artifacts/linux-x64/fonts/ttf
#
# At launch the worker writes a fontconfig file pointing at this directory
# and starts the fork with FONTCONFIG_FILE set, so font enumeration and
# measureText metrics match a Mac instead of a bare Linux server.
#
# LICENSING: the files this script copies are Apple-licensed system fonts. It
# reads them from the macOS host it runs on and never fetches or vendors them.
# The resulting fonts/ttf directory MUST NOT be redistributed, published, or
# committed; it is local output only, and the terms that apply to it are
# Apple's, not this project's. Nothing produced here is part of the published
# BetterWright package.

set -euo pipefail

OUT="${1:-artifacts/linux-x64/fonts/ttf}"
SYS="/System/Library/Fonts"
SUP="$SYS/Supplemental"

mkdir -p "$OUT"

# Family coverage a macOS Chrome exposes to JS font probing.
FILES=(
  # Core sans/serif/mono
  "$SYS/Helvetica.ttc"
  "$SYS/HelveticaNeue.ttc"
  "$SUP/Arial.ttf"
  "$SUP/Arial Bold.ttf"
  "$SUP/Arial Italic.ttf"
  "$SUP/Arial Bold Italic.ttf"
  "$SUP/Arial Narrow.ttf"
  "$SUP/Arial Black.ttf"
  "$SUP/Times New Roman.ttf"
  "$SUP/Times New Roman Bold.ttf"
  "$SUP/Times New Roman Italic.ttf"
  "$SUP/Times New Roman Bold Italic.ttf"
  "$SUP/Courier New.ttf"
  "$SUP/Courier New Bold.ttf"
  "$SUP/Courier New Italic.ttf"
  "$SUP/Georgia.ttf"
  "$SUP/Georgia Bold.ttf"
  "$SUP/Verdana.ttf"
  "$SUP/Verdana Bold.ttf"
  "$SUP/Trebuchet MS.ttf"
  "$SUP/Trebuchet MS Bold.ttf"
  "$SUP/Comic Sans MS.ttf"
  "$SUP/Impact.ttf"
  "$SUP/Tahoma.ttf"
  # macOS staples
  "$SYS/Menlo.ttc"
  "$SYS/Monaco.ttf"
  "$SYS/SFNS.ttf"
  "$SYS/NewYork.ttf"
  "$SYS/Geneva.ttf"
  "$SYS/Apple Color Emoji.ttc"
  "$SYS/Apple Symbols.ttf"
  # Common supplemental families
  "$SYS/Palatino.ttc"
  "$SUP/Futura.ttc"
  "$SYS/Avenir Next.ttc"
  "$SYS/Avenir Next Condensed.ttc"
  # Optima/Didot/Hoefler Text/American Typewriter are download-on-demand in
  # recent macOS; add them here if the host has downloaded them.
  "$SUP/Andale Mono.ttf"
)

missing=0
copied=0
for f in "${FILES[@]}"; do
  if [[ -f "$f" ]]; then
    cp "$f" "$OUT/"
    copied=$((copied + 1))
  else
    echo "MISSING: $f" >&2
    missing=$((missing + 1))
  fi
done

echo "copied=$copied missing=$missing -> $OUT"
[[ $copied -gt 20 ]] || { echo "too few fonts copied; refusing" >&2; exit 1; }
