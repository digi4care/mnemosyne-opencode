#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d /tmp/opencode/mnemosyne-direct-XXXXXX)"
if [[ -z "$TMP" || "$TMP" == "/" ]]; then
  echo "Refusing unsafe temporary path: '$TMP'" >&2
  exit 1
fi
trap 'rm -rf -- "$TMP"' EXIT

export MNEMOSYNE_HOME="$TMP/home"
export MNEMOSYNE_DATA_DIR="$TMP/data"
source "$ROOT/scripts/mnemosyne-env.sh"
MARKER="convention-$(date +%s)-${RANDOM}: keep adapter state under project-local storage"
export MARKER

curl -fsS --max-time 5 "${MNEMOSYNE_EMBEDDING_API_URL%/v1}/api/tags" >/dev/null
python - <<'PY'
import json
import os
import urllib.request

url = os.environ["MNEMOSYNE_EMBEDDING_API_URL"].rstrip("/") + "/embeddings"
payload = json.dumps({"model": os.environ["MNEMOSYNE_EMBEDDING_MODEL"], "input": "dimension probe"}).encode()
request = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
with urllib.request.urlopen(request, timeout=30) as response:
    data = json.load(response)
vector = data["data"][0]["embedding"]
expected = int(os.environ["MNEMOSYNE_EMBEDDING_DIM"])
assert len(vector) == expected, f"expected {expected} dimensions, got {len(vector)}"
print(f"PASS: Ollama embedding returned {len(vector)} dimensions")
PY

uvx --from "$MNEMOSYNE_PACKAGE" --with numpy python - <<'PY'
import os
from mnemosyne import remember

memory_id = remember(
    os.environ["MARKER"],
    scope="global",
    importance=0.99,
    source="direct-smoke",
)
assert memory_id is not None, "Mnemosyne filtered the marker instead of storing it"
print(f"PASS: stored {os.environ['MARKER']}")
PY

uvx --from "$MNEMOSYNE_PACKAGE" --with numpy python - <<'PY'
import os
from mnemosyne import get_stats, recall

expected = os.environ["MARKER"]
results = recall("adapter state storage", top_k=3)
contents = [result.get("content") for result in results]
assert expected in contents, f"second process did not recall marker; got {contents!r}; stats={get_stats()!r}"
print("PASS: second independent process recalled the exact marker")
print("PASS: direct Mnemosyne + Ollama smoke")
PY
