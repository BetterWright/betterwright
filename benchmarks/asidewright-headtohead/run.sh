#!/bin/zsh
# Runtime-vs-runtime head-to-head: BetterWright vs AsideWright (the `aside` CLI).
#
# Both take raw browser-automation JavaScript, so this isolates the *browser
# runtime* (navigation, snapshot, tabs, redaction) from any LLM. Login-free and
# deterministic. Requires `betterwright setup` and a signed-in `aside` CLI.
#
# Usage: zsh benchmarks/asidewright-headtohead/run.sh
set -e
BW_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
now() { python3 -c 'import time;print(int(time.time()*1000))'; }

echo "== 1. Cold one-shot: navigate + interactive snapshot (x3) =="
for i in 1 2 3; do
  s=$(now)
  BETTERWRIGHT_HEADLESS=1 node "$BW_DIR/bin/betterwright.mjs" run -c \
    "await page.goto('https://example.com'); const s = await snapshot({interactive:true}); return s.length" >/dev/null 2>&1
  echo "  BetterWright run  #$i: $(( $(now) - s ))ms"
done
for i in 1 2 3; do
  s=$(now)
  ( cd /tmp && aside repl \
    "const p = await openTab('https://example.com'); const s = await snapshot(p,{interactive:true}); console.log(s.tree.length)" >/dev/null 2>&1 )
  echo "  AsideWright repl  #$i: $(( $(now) - s ))ms"
done

echo "== 2. Warm per-op (BetterWright repl, 1 cold + 3 warm) =="
printf '%s\n\n%s\n\n%s\n\n%s\n' \
  "await page.goto('https://example.com'); return (await snapshot({interactive:true})).length" \
  "await page.goto('https://example.org'); return (await snapshot({interactive:true})).length" \
  "await page.goto('https://example.com'); return (await snapshot({interactive:true})).length" \
  "await page.goto('https://example.org'); return (await snapshot({interactive:true})).length" \
  | BETTERWRIGHT_HEADLESS=1 node "$BW_DIR/bin/betterwright.mjs" repl 2>&1 | grep durationMs

echo "== 3. Capability: password redaction in snapshot =="
DATA='data:text/html,<form><input id=p type=password placeholder=Pass></form>'
echo -n "  BetterWright: "
BETTERWRIGHT_HEADLESS=1 node "$BW_DIR/bin/betterwright.mjs" run -c \
  "await page.goto('$DATA'); await page.fill('#p','topsecretpw'); const s = await snapshot({interactive:true}); return s.includes('topsecretpw') ? 'LEAKS' : 'redacted'" 2>&1 | grep -oE 'LEAKS|redacted' | head -1
echo -n "  AsideWright:  "
( cd /tmp && aside repl \
  "const p = await openTab('$DATA'); await p.fill('#p','topsecretpw'); const s = await snapshot(p,{interactive:true}); console.log(s.tree.includes('topsecretpw') ? 'LEAKS' : 'redacted')" 2>&1 | grep -oE 'LEAKS|redacted' | head -1 )
