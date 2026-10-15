#!/usr/bin/env python3
"""Small JSONL worker for the native OpenCode Mnemosyne plugin."""

import json
import os
import sys
from typing import Any

from mnemosyne.core.memory import Mnemosyne


def dump(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, default=str, ensure_ascii=False), flush=True)


def main() -> None:
    bank = os.environ.get("MNEMOSYNE_MCP_BANK", "default")
    memory = Mnemosyne(session_id="opencode", bank=bank)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = "unknown"
        try:
            request = json.loads(line)
            request_id = str(request.get("id", request_id))
            operation = request.get("operation")
            if operation == "shutdown":
                dump({"id": request_id, "ok": True, "result": {"status": "stopping"}})
                return

            if operation == "ping":
                result = {"status": "ok", "bank": bank}
            elif operation == "remember":
                content = str(request.get("content", "")).strip()
                if not content:
                    raise ValueError("content is required")
                metadata = dict(request.get("metadata") or {})
                memory_id = memory.remember(
                    content=content,
                    source=metadata.pop("source", "opencode"),
                    importance=float(metadata.pop("importance", 0.7)),
                    metadata=metadata,
                    scope="global",
                )
                if memory_id is None:
                    raise RuntimeError("Mnemosyne filtered the memory instead of storing it")
                result = {"id": memory_id, "bank": bank}
            elif operation == "recall":
                query = str(request.get("query", "")).strip()
                if not query:
                    raise ValueError("query is required")
                limit = max(1, min(int(request.get("limit", 4)), 20))
                rows = memory.recall(query=query, top_k=limit)
                result = []
                for row in rows:
                    item = {"content": row.get("content", "")}
                    if item["content"]:
                        for key in ("source", "timestamp", "created_at", "valid_until"):
                            if row.get(key) is not None:
                                item[key] = row[key]
                        result.append(item)
            elif operation == "stats":
                result = memory.get_stats()
            else:
                raise ValueError(f"unknown operation: {operation}")

            dump({"id": request_id, "ok": True, "result": result})
        except Exception as error:  # protocol errors are results, not process failures
            dump({"id": request_id, "ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
