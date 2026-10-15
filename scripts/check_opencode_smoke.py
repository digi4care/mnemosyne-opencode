#!/usr/bin/env python3
"""Validate the two JSONL traces produced by smoke-opencode.sh."""

import json
import sys
from pathlib import Path


def read_events(path: Path) -> list[dict]:
    events = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def tools(events: list[dict]) -> set[str]:
    names = set()
    for event in events:
        if event.get("type") != "tool_use":
            continue
        part = event.get("part") or {}
        name = part.get("tool")
        if isinstance(name, str):
            names.add(name)
    return names


def assistant_text(events: list[dict]) -> str:
    chunks = []
    for event in events:
        if event.get("type") != "text":
            continue
        part = event.get("part") or {}
        text = part.get("text")
        if isinstance(text, str):
            chunks.append(text)
    return "".join(chunks)


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: check_opencode_smoke.py STORE.jsonl RECALL.jsonl MARKER")

    store_path, recall_path = map(Path, sys.argv[1:3])
    marker = sys.argv[3]
    store = read_events(store_path)
    recall = read_events(recall_path)
    store_tools = tools(store)
    recall_tools = tools(recall)
    store_text = assistant_text(store)
    recall_text = assistant_text(recall)

    failures = []
    if "mnemosyne_mnemosyne_remember" not in store_tools:
        failures.append(f"store run has no mnemosyne_mnemosyne_remember call (tools: {sorted(store_tools)})")
    if "mnemosyne_mnemosyne_recall" not in recall_tools:
        failures.append(f"recall run has no mnemosyne_mnemosyne_recall call (tools: {sorted(recall_tools)})")
    if "STORE_OK" not in store_text:
        failures.append("store run did not finish with STORE_OK")
    if marker not in recall_text:
        failures.append("recall answer does not contain the exact marker")

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        raise SystemExit(1)

    print("PASS: OpenCode called mnemosyne_mnemosyne_remember in run A")
    print("PASS: independent OpenCode run B recalled the exact marker")


if __name__ == "__main__":
    main()
