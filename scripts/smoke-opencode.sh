#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/mnemosyne-env.sh"

for command in opencode curl uvx python; do
  command -v "$command" >/dev/null || {
    echo "Missing required command: $command" >&2
    exit 1
  }
done

curl -fsS --max-time 5 "${MNEMOSYNE_EMBEDDING_API_URL%/v1}/api/tags" >/dev/null

MODEL="${OPENCODE_MODEL:-kimi-code-plan-global/k3}"
STAMP="$(date +%Y%m%dT%H%M%SZ)-${RANDOM}"
RUN_DIR="$ROOT/results/opencode-smoke-$STAMP"
mkdir -p "$RUN_DIR"
MARKER="convention-$STAMP: keep adapter state under project-local storage"
GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.jsonc"
GLOBAL_BEFORE="$(sha256sum "$GLOBAL_CONFIG" | cut -d' ' -f1)"

opencode mcp list >"$RUN_DIR/mcp-list.txt"
if ! grep -Eiq 'mnemosyne.*connected|connected.*mnemosyne' "$RUN_DIR/mcp-list.txt"; then
  echo "Mnemosyne is not connected in OpenCode; see $RUN_DIR/mcp-list.txt" >&2
  exit 1
fi

run_agent() {
  local prompt="$1"
  local output="$2"
  if ! timeout 300 opencode run --format json -m "$MODEL" "$prompt" >"$output" 2>&1; then
    echo "OpenCode run failed; trace: $output" >&2
    tail -60 "$output" >&2 || true
    return 1
  fi
}

run_agent "Use the mnemosyne_mnemosyne_remember tool exactly once to store this exact text: '$MARKER'. Set scope to 'global', importance to 0.99, and source to 'opencode-smoke'. After the tool succeeds, reply with exactly STORE_OK and nothing else. Do not call any other tools." "$RUN_DIR/store.jsonl"
run_agent "Use the mnemosyne_mnemosyne_recall tool exactly once with query 'adapter state storage' and top_k set to 3. Then answer with only the exact content of the recalled project convention. Do not answer from memory without calling the tool." "$RUN_DIR/recall.jsonl"

[[ -f "$MNEMOSYNE_DATA_DIR/mnemosyne.db" ]] || {
  echo "Expected project database is missing: $MNEMOSYNE_DATA_DIR/mnemosyne.db" >&2
  exit 1
}

python "$ROOT/scripts/check_opencode_smoke.py" "$RUN_DIR/store.jsonl" "$RUN_DIR/recall.jsonl" "$MARKER"

GLOBAL_AFTER="$(sha256sum "$GLOBAL_CONFIG" | cut -d' ' -f1)"
if [[ "$GLOBAL_BEFORE" != "$GLOBAL_AFTER" ]]; then
  echo "Global OpenCode config changed during the smoke: $GLOBAL_CONFIG" >&2
  exit 1
fi

printf '%s\n' "$MARKER" >"$RUN_DIR/marker.txt"
printf '%s\n' "PASS: global OpenCode config unchanged"
printf '%s\n' "PASS: OpenCode MCP smoke complete; traces in $RUN_DIR"
