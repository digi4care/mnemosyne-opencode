#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODEL="${OPENCODE_MODEL:-opencode/space-bunny-free}"
GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.jsonc"
GLOBAL_BEFORE="$(sha256sum "$GLOBAL_CONFIG" | cut -d' ' -f1)"
MODELS=("$@")
if (( ${#MODELS[@]} == 0 )); then
  MODELS=(mnemosyne-file mnemosyne-embedded hindsight)
fi

for required in opencode curl python uvx; do
  command -v "$required" >/dev/null || {
    echo "Missing required command: $required" >&2
    exit 1
  }
done

run_agent() {
  local prompt="$1"
  local output="$2"
  if ! timeout 300 opencode run --format json -m "$MODEL" "$prompt" >"$output" 2>&1; then
    echo "OpenCode run failed: $output" >&2
    tail -60 "$output" >&2 || true
    return 1
  fi
}

new_session() {
  local title="$1"
  local created
  created="$(opencode api post /api/session --data "{\"title\":\"$title\"}")"
  python -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])' <<<"$created"
}

memory_command() {
  local session_id="$1"
  local text="$2"
  opencode api post "/api/session/$session_id/command" --data "{\"name\":\"memory\",\"text\":\"$text\"}" >/dev/null
}

for backend in "${MODELS[@]}"; do
  case "$backend" in
    mnemosyne-file)
      command_name="mnemosyne file"
      ;;
    mnemosyne-embedded)
      command_name="mnemosyne embedded"
      curl -fsS --max-time 5 "http://localhost:11434/api/tags" >/dev/null
      ;;
    hindsight)
      command_name="hindsight"
      curl -fsS --max-time 5 "http://localhost:8888/health" >/dev/null
      ;;
    *)
      echo "Unknown backend: $backend" >&2
      exit 1
      ;;
  esac

  stamp="$(date +%Y%m%dT%H%M%SZ)-${RANDOM}"
  run_dir="$ROOT/results/native-abc/${backend}-${stamp}"
  mkdir -p "$run_dir"
  # The unique token IS the convention, so answering "the convention" and
  # echoing the token are the same act. A model that recalls the memory has no
  # way to produce this token except from the injected memory block.
  marker="convention-${backend}-${stamp}-${RANDOM}${RANDOM}"

  session_a="$(new_session "native-abc-$backend")"
  memory_command "$session_a" "$command_name"
  run_agent "Remember this project convention token exactly as written: $marker. Reply with exactly REMEMBERED." "$run_dir/store.jsonl"
  run_agent "What is the exact project convention token for this project? Reply with only the token." "$run_dir/recall.jsonl"
  python "$ROOT/scripts/check_native_smoke.py" "$run_dir/store.jsonl" "$run_dir/recall.jsonl" "$marker"
  printf '%s\n' "$marker" >"$run_dir/marker.txt"
  memory_command "$session_a" "/memory off"
  printf 'PASS: %s\n' "$backend"
done

GLOBAL_AFTER="$(sha256sum "$GLOBAL_CONFIG" | cut -d' ' -f1)"
if [[ "$GLOBAL_BEFORE" != "$GLOBAL_AFTER" ]]; then
  echo "Global OpenCode config changed during smoke" >&2
  exit 1
fi
printf 'PASS: native A/B/C smoke complete\n'
