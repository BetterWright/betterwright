#!/usr/bin/env bash
set -euo pipefail
OUT="${1:-benchmarks/odysseys/runs/full-200-gpt56sol-high}"
echo "=== Odysseys campaign status ==="
echo "time: $(date -Is)"
python3 - "$OUT" <<'PY2'
import json, collections, os, sys
from pathlib import Path
out = Path(sys.argv[1])
running = False
me = os.getpid()
for pid in Path('/proc').iterdir():
    if not pid.name.isdigit() or int(pid.name) == me:
        continue
    try:
        cmd = (pid / 'cmdline').read_bytes().replace(b'\x00', b' ').decode('utf-8', 'ignore')
    except Exception:
        continue
    if 'exec-runner.mjs' in cmd and 'odysseys' in cmd:
        running = True
        print('agent: RUNNING pid', pid.name)
        break
if not running:
    print('agent: stopped')
subs = len(list((out/'submission').glob('*/result.json'))) if (out/'submission').exists() else 0
prog = 0
if (out/'progress.jsonl').exists():
    rows = [json.loads(l) for l in (out/'progress.jsonl').read_text().splitlines() if l.strip()]
    prog = len(rows)
    c = collections.Counter(r['status'] for r in rows)
    print('statuses:', dict(c))
    if rows:
        durs = [r['duration_ms'] for r in rows if r.get('duration_ms')]
        print(f"avg duration: {sum(durs)/len(durs)/60000:.1f} min  last: {rows[-1]['task_id'][:12]}… {rows[-1]['status']}")
judged = 0
if (out/'submission').exists():
    judged = sum(1 for p in (out/'submission').glob('*/rubric-verdict.json') if json.loads(p.read_text()).get('status')=='judged')
print(f'progress lines: {prog} / 200')
print(f'submissions: {subs}')
print(f'judged: {judged}')
if (out/'score-summary.json').exists():
    s = json.loads((out/'score-summary.json').read_text())
    print(f"scores: judged={s.get('judged')} perfect={s.get('perfect_rate')} avg={s.get('rubric_average')}")
    print('by_level:', s.get('by_level'))
PY2
