#!/usr/bin/env bash
#
# Runtime-vs-runtime head-to-head: BetterWright vs a reference browser runtime.
#
# Both sides take raw browser-automation JavaScript, so this isolates the
# *browser runtime* (navigation, snapshot, tabs, redaction) from any LLM. All
# tasks are login-free and deterministic.
#
# The reference runtime is not vendored and not named here: name it yourself
# with REFERENCE_CLI, pointing at a CLI installed on your own machine that
# accepts `<cli> repl "<javascript>"`. Only the BetterWright half of this
# script is reproducible from a clean checkout, which is why that half can be
# run on its own.
#
# Usage:
#   REFERENCE_CLI=<cli> benchmarks/browser-agent-headtohead/run.sh
#   benchmarks/browser-agent-headtohead/run.sh --betterwright-only
#
# Requires `betterwright setup` and a built `dist/` (`npm run build`).

set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
BW="$REPO_ROOT/dist/bin/betterwright.js"

BETTERWRIGHT_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --betterwright-only) BETTERWRIGHT_ONLY=1 ;;
    -h | --help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "run.sh: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

die() {
  echo "run.sh: $*" >&2
  exit 1
}

[ -f "$BW" ] || die "missing $BW — run 'npm run build' first"
command -v node >/dev/null 2>&1 || die "node is required"

REFERENCE_CLI="${REFERENCE_CLI:-}"
if [ "$BETTERWRIGHT_ONLY" -eq 0 ]; then
  if [ -z "$REFERENCE_CLI" ]; then
    die "REFERENCE_CLI is not set.

This benchmark compares BetterWright against a second browser runtime that this
repository does not ship and does not name. Set REFERENCE_CLI to a CLI on your
own machine that accepts '<cli> repl \"<javascript>\"':

  REFERENCE_CLI=your-cli $0

Or run only the reproducible half:

  $0 --betterwright-only"
  fi
  command -v "$REFERENCE_CLI" >/dev/null 2>&1 ||
    die "REFERENCE_CLI is set to '$REFERENCE_CLI', which is not on PATH."
fi

# Millisecond clock. Prefer bash 5's EPOCHREALTIME because it costs no
# subprocess, and a subprocess spawn would land inside the interval being
# measured. Fall back to GNU date, then to node.
if [ -n "${EPOCHREALTIME:-}" ]; then
  now_ms() {
    local t="${EPOCHREALTIME/,/.}"
    printf '%s' "$((${t%%.*} * 1000 + 10#${t#*.} / 1000))"
  }
elif date +%s%3N 2>/dev/null | grep -Eq '^[0-9]+$'; then
  now_ms() { date +%s%3N; }
else
  now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
fi

bw() { BETTERWRIGHT_HEADLESS=1 node "$BW" "$@"; }

reference_available() { [ "$BETTERWRIGHT_ONLY" -eq 0 ]; }

echo "== 1. Cold one-shot: navigate + interactive snapshot (x3) =="
for i in 1 2 3; do
  start="$(now_ms)"
  if bw run -c \
    "await page.goto('https://example.com'); const s = await snapshot({interactive:true}); return s.length" \
    >/dev/null 2>&1; then
    echo "  BetterWright run  #$i: $(($(now_ms) - start))ms"
  else
    echo "  BetterWright run  #$i: FAILED"
  fi
done

if reference_available; then
  for i in 1 2 3; do
    start="$(now_ms)"
    if (cd /tmp && "$REFERENCE_CLI" repl \
      "const p = await openTab('https://example.com'); const s = await snapshot(p,{interactive:true}); console.log(s.tree.length)" \
      >/dev/null 2>&1); then
      echo "  Reference repl    #$i: $(($(now_ms) - start))ms"
    else
      echo "  Reference repl    #$i: FAILED"
    fi
  done
fi

echo "== 2. Warm per-op (BetterWright repl, 1 cold + 3 warm) =="
printf '%s\n\n%s\n\n%s\n\n%s\n' \
  "await page.goto('https://example.com'); return (await snapshot({interactive:true})).length" \
  "await page.goto('https://example.org'); return (await snapshot({interactive:true})).length" \
  "await page.goto('https://example.com'); return (await snapshot({interactive:true})).length" \
  "await page.goto('https://example.org'); return (await snapshot({interactive:true})).length" |
  bw repl 2>&1 | grep durationMs ||
  echo "  no durationMs lines in repl output"

echo "== 3. Capability: password redaction in snapshot =="
DATA='data:text/html,<form><input id=p type=password placeholder=Pass></form>'
FILL="await page.goto('$DATA'); await page.fill('#p','topsecretpw');"
CHECK="const s = await snapshot({interactive:true}); return s.includes('topsecretpw') ? 'LEAKS' : 'redacted'"

printf '  BetterWright: '
bw run -c "$FILL $CHECK" 2>&1 | grep -oE 'LEAKS|redacted' | head -1 ||
  echo "inconclusive"

if reference_available; then
  printf '  Reference:    '
  (cd /tmp && "$REFERENCE_CLI" repl \
    "const p = await openTab('$DATA'); await p.fill('#p','topsecretpw'); const s = await snapshot(p,{interactive:true}); console.log(s.tree.includes('topsecretpw') ? 'LEAKS' : 'redacted')" \
    2>&1 | grep -oE 'LEAKS|redacted' | head -1) ||
    echo "inconclusive"
fi
