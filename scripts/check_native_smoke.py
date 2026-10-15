#!/usr/bin/env python3
"""Check one automatic memory A/B run without requiring memory tool calls."""

import json
import sys
from pathlib import Path


def assistant_text(path: Path) -> str:
    chunks = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "text":
            part = event.get("part") or {}
            text = part.get("text")
            if isinstance(text, str):
                chunks.append(text)
    return "".join(chunks)


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: check_native_smoke.py STORE.jsonl RECALL.jsonl MARKER")
    store, recall = map(Path, sys.argv[1:3])
    marker = sys.argv[3].strip()
    if not marker:
        raise SystemExit("FAIL: marker is empty")
    if "REMEMBERED" not in assistant_text(store):
        raise SystemExit("FAIL: session A did not acknowledge the project convention token")
    answer = assistant_text(recall)
    # The token is unique per run and is never in the prompt of session B, so it
    # can only appear in the answer if the memory was recalled and injected.
    if marker not in answer:
        raise SystemExit(
            f"FAIL: session B did not return the unique marker {marker!r}; "
            f"it answered with {answer.strip()[:200]!r}"
        )
    print(f"PASS: automatic recall in a new OpenCode session returned {marker!r}")


if __name__ == "__main__":
    main()
