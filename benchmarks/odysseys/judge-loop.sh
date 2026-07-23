#!/usr/bin/env bash
set -uo pipefail
cd /root/betterwright
OUT=benchmarks/odysseys/runs/full-200-gpt56sol-high

agent_running() {
  python3 - <<'PY'
import os
from pathlib import Path
me = os.getpid()
for p in Path("/proc").iterdir():
    if not p.name.isdigit() or int(p.name) == me:
        continue
    try:
        cmd = (p / "cmdline").read_bytes().replace(b"\x00", b" ").decode("utf-8", "ignore")
    except Exception:
        continue
    if "exec-runner.mjs" in cmd and "odysseys" in cmd:
        raise SystemExit(0)
raise SystemExit(1)
PY
}

run_judge() {
  node benchmarks/odysseys/judge.mjs \
    --tasks benchmarks/odysseys/odysseys.json \
    --manifest benchmarks/odysseys/full-200.json \
    --output "$OUT" \
    --model openai-codex/gpt-5.6-luna \
    --thinking high \
    --concurrency 2 \
    >> logs/odysseys-judge.log 2>&1 || true
}

while true; do
  count=$(find "$OUT/submission" -name result.json 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${count:-0}" -gt 0 ]]; then
    run_judge
  fi
  if ! agent_running; then
    run_judge
    echo "JUDGE_LOOP_DONE $(date -Is)" >> logs/odysseys-judge.log
    break
  fi
  sleep 600
done
