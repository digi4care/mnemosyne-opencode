#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODEL="${OPENCODE_MODEL:-opencode/space-bunny-free}"
GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.jsonc"
GLOBAL_BEFORE="$(sha256sum "$GLOBAL_CONFIG" | cut -d' ' -f1)"
# Since D1 the plugin writes configuration to the *project* config, not the global
# one. The smoke runs in the repository root, so /mnemosyne on would otherwise edit
# this repository's own opencode.jsonc. Snapshot it and restore it afterwards.
PROJECT_CONFIG="$ROOT/opencode.jsonc"
PROJECT_BEFORE="$(sha256sum "$PROJECT_CONFIG" | cut -d' ' -f1)"
MODELS=("$@")
if (( ${#MODELS[@]} == 0 )); then
  MODELS=(mnemosyne-file mnemosyne-embedded)
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
  opencode api post "/api/session/$session_id/command" --data "{\"name\":\"mnemosyne\",\"text\":\"$text\"}" >/dev/null
}

for backend in "${MODELS[@]}"; do
  case "$backend" in
    mnemosyne-file)
      command_name="mnemosyne mnemosyne file"
      ;;
    mnemosyne-embedded)
      command_name="mnemosyne mnemosyne embedded"
      curl -fsS --max-time 5 "http://localhost:11434/api/tags" >/dev/null
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
  memory_command "$session_a" "/mnemosyne off"
  printf 'PASS: %s\n' "$backend"
done

GLOBAL_AFTER="$(sha256sum "$GLOBAL_CONFIG" | cut -d' ' -f1)"
if [[ "$GLOBAL_BEFORE" != "$GLOBAL_AFTER" ]]; then
  echo "Global OpenCode config changed during smoke" >&2
  exit 1
fi
PROJECT_AFTER="$(sha256sum "$PROJECT_CONFIG" | cut -d' ' -f1)"
if [[ "$PROJECT_BEFORE" != "$PROJECT_AFTER" ]]; then
  echo "Project config was written by the smoke; restoring the original" >&2
  git -C "$ROOT" checkout -- "$PROJECT_CONFIG" 2>/dev/null || exit 1
fi
printf 'PASS: native A/B/C smoke complete\n'
