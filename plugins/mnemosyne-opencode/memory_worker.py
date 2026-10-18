#!/usr/bin/env python3
"""Small JSONL worker for the native OpenCode Mnemosyne plugin."""

import json
import os
import sys
import sqlite3
import hashlib
from datetime import datetime, timedelta
from typing import Any

from mnemosyne.core.memory import Mnemosyne
from mnemosyne.core.beam import WORKING_MEMORY_TTL_HOURS, SLEEP_BATCH_SIZE

TEMPORAL_WEIGHT = 0.05
TEMPORAL_HALFLIFE_HOURS = 720
EMBEDDING_PROBE_TEXT = "Mnemosyne embedding connectivity test."


def _coord_path() -> str:
    path = os.environ.get("MNEMOSYNE_PLUGIN_COORD_DB")
    if not path:
        raise ValueError("MNEMOSYNE_PLUGIN_COORD_DB is required")
    return path


def _coord():
    conn = sqlite3.connect(_coord_path(), timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS snapshots (
        project TEXT NOT NULL, session TEXT NOT NULL, generation INTEGER NOT NULL,
        fingerprint TEXT NOT NULL, payload TEXT NOT NULL, claimed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project,session))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS requests (
        operation_id TEXT PRIMARY KEY, project TEXT NOT NULL, session TEXT NOT NULL,
        kind TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', server_epoch TEXT, result TEXT)""")
    conn.execute("CREATE TABLE IF NOT EXISTS heartbeats (server_epoch TEXT PRIMARY KEY, seen_at TEXT NOT NULL)")
    conn.execute("""CREATE TABLE IF NOT EXISTS turn_writes (
        project TEXT NOT NULL, session TEXT NOT NULL, message_id TEXT NOT NULL, bank TEXT NOT NULL,
        fingerprint TEXT NOT NULL, memory_id TEXT NOT NULL, result_id TEXT, status TEXT NOT NULL,
        PRIMARY KEY(project,session,message_id,bank))""")
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(turn_writes)")}
    if "backend" not in cols:
        conn.execute("ALTER TABLE turn_writes RENAME TO turn_writes_legacy")
        conn.execute("""CREATE TABLE turn_writes (
            project TEXT NOT NULL, session TEXT NOT NULL, message_id TEXT NOT NULL, bank TEXT NOT NULL, backend TEXT NOT NULL,
            fingerprint TEXT NOT NULL, memory_id TEXT NOT NULL, result_id TEXT, status TEXT NOT NULL,
            PRIMARY KEY(project,session,message_id,bank,backend))""")
        conn.execute("INSERT INTO turn_writes SELECT project,session,message_id,bank,'legacy',fingerprint,memory_id,result_id,status FROM turn_writes_legacy")
        conn.execute("DROP TABLE turn_writes_legacy")
    return conn


def coordination(operation: str, req: dict[str, Any]) -> Any:
    c = _coord()
    try:
        project, session = req.get("project"), req.get("session")
        if operation in ("coord_publish_snapshot", "coord_get_snapshot", "coord_claim_snapshot", "coord_release_snapshot", "coord_mark_snapshot_injected", "coord_invalidate_snapshot", "coord_enqueue_request") and (not project or not session):
            raise ValueError("project and session are required")
        c.execute("BEGIN IMMEDIATE")
        if operation == "coord_publish_snapshot":
            cur = c.execute("INSERT INTO snapshots VALUES(?,?,?,?,?,0) ON CONFLICT(project,session) DO UPDATE SET generation=excluded.generation,fingerprint=excluded.fingerprint,payload=excluded.payload,claimed=0 WHERE excluded.generation>snapshots.generation", (project, session, int(req["generation"]), req["fingerprint"], json.dumps(req.get("payload"))))
            result = {"published": cur.rowcount == 1}
        elif operation == "coord_get_snapshot":
            row = c.execute("SELECT generation,fingerprint,payload,claimed FROM snapshots WHERE project=? AND session=?", (project, session)).fetchone()
            result = dict(row) if row else None
            if result: result["payload"] = json.loads(result["payload"])
        elif operation == "coord_claim_snapshot":
            cur = c.execute("UPDATE snapshots SET claimed=1 WHERE project=? AND session=? AND generation=? AND fingerprint=? AND claimed=0", (project, session, req["generation"], req["fingerprint"]))
            result = {"claimed": cur.rowcount == 1}
        elif operation == "coord_release_snapshot":
            cur = c.execute("UPDATE snapshots SET claimed=0 WHERE project=? AND session=? AND generation=? AND fingerprint=? AND claimed=1", (project, session, req["generation"], req["fingerprint"]))
            result = {"released": cur.rowcount == 1}
        elif operation == "coord_mark_snapshot_injected":
            row = c.execute("SELECT payload FROM snapshots WHERE project=? AND session=? AND generation=? AND fingerprint=?", (project, session, req["generation"], req["fingerprint"])).fetchone()
            result = {"marked": False}
            if row:
                payload = json.loads(row["payload"])
                payload["injected"] = True
                cur = c.execute("UPDATE snapshots SET payload=? WHERE project=? AND session=? AND generation=? AND fingerprint=?", (json.dumps(payload), project, session, req["generation"], req["fingerprint"]))
                result = {"marked": cur.rowcount == 1}
        elif operation == "coord_invalidate_snapshot":
            result = {"invalidated": c.execute("DELETE FROM snapshots WHERE project=? AND session=?", (project, session)).rowcount > 0}
        elif operation == "coord_enqueue_request":
            payload = json.dumps(req.get("payload"), sort_keys=True, separators=(",", ":"))
            old = c.execute("SELECT project,session,kind,fingerprint,payload FROM requests WHERE operation_id=?", (req["operation_id"],)).fetchone()
            if old and (old["project"] != project or old["session"] != session or old["kind"] != req["kind"] or old["fingerprint"] != req["fingerprint"] or old["payload"] != payload): raise ValueError("operation_id was reused with a different payload")
            c.execute("INSERT OR IGNORE INTO requests(operation_id,project,session,kind,fingerprint,payload) VALUES(?,?,?,?,?,?)", (req["operation_id"], project, session, req["kind"], req["fingerprint"], payload))
            result = {"status": "pending"}
        elif operation == "coord_claim_next":
            project = req.get("project")
            if not project: raise ValueError("project is required")
            stale_after = max(1, int(req.get("stale_after_seconds", 60)))
            stale = (datetime.now() - timedelta(seconds=stale_after)).isoformat()
            c.execute("UPDATE requests SET status='pending',server_epoch=NULL WHERE status='claimed' AND server_epoch IN (SELECT server_epoch FROM heartbeats WHERE seen_at<?)", (stale,))
            c.execute("UPDATE requests SET status='pending',server_epoch=NULL WHERE status='claimed' AND server_epoch NOT IN (SELECT server_epoch FROM heartbeats)")
            row = c.execute("SELECT operation_id FROM requests WHERE status='pending' AND project=? ORDER BY rowid LIMIT 1", (project,)).fetchone()
            result = None
            if row:
                epoch = req["server_epoch"]
                cur = c.execute("UPDATE requests SET status='claimed',server_epoch=? WHERE operation_id=? AND status='pending'", (epoch, row[0]))
                if cur.rowcount:
                    result = dict(c.execute("SELECT * FROM requests WHERE operation_id=?", (row[0],)).fetchone())
                    result["payload"] = json.loads(result["payload"])
        elif operation == "coord_finish_request":
            if req["status"] not in ("complete", "failed"): raise ValueError("status must be complete or failed")
            cur = c.execute("UPDATE requests SET status=?,result=? WHERE operation_id=? AND status='claimed' AND server_epoch=?", (req["status"], json.dumps(req.get("result")), req["operation_id"], req["server_epoch"]))
            result = {"finished": cur.rowcount == 1}
        elif operation == "coord_request_status":
            row = c.execute("SELECT status,result FROM requests WHERE operation_id=?", (req["operation_id"],)).fetchone()
            result = dict(row) if row else None
            if result and result["result"] is not None: result["result"] = json.loads(result["result"])
        elif operation == "coord_heartbeat":
            c.execute("INSERT INTO heartbeats VALUES(?,?) ON CONFLICT(server_epoch) DO UPDATE SET seen_at=excluded.seen_at", (req["server_epoch"], datetime.now().isoformat()))
            result = {"ok": True}
        else: raise ValueError("unknown coordination operation")
        c.commit()
        return result
    except Exception:
        c.rollback(); raise
    finally: c.close()


def remember_turn(memory: Mnemosyne, req: dict[str, Any]) -> dict[str, Any]:
    project = os.path.realpath(req["project"])
    session, message = str(req["sessionID"]), str(req["messageID"])
    bank = os.environ.get("MNEMOSYNE_MCP_BANK", "default")
    backend = os.path.realpath(os.environ.get("MNEMOSYNE_DATA_DIR") or os.environ.get("MNEMOSYNE_HOME") or "~/.mnemosyne")
    content = str(req["content"]).strip()
    if not content: raise ValueError("content is required")
    mid = "v1-" + hashlib.sha256(json.dumps([project, session, message, backend, bank], separators=(",", ":")).encode()).hexdigest()
    fingerprint = hashlib.sha256(json.dumps([content, req.get("metadata") or {}], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    c = _coord()
    try:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM turn_writes WHERE project=? AND session=? AND message_id=? AND bank=? AND backend=?", (project, session, message, bank, backend)).fetchone()
        if row and row["fingerprint"] != fingerprint: raise ValueError("turn ID was reused with a different payload")
        if row and row["status"] == "complete":
            c.commit(); return {"id": row["result_id"], "reused": True}
        if not row:
            c.execute("INSERT INTO turn_writes VALUES(?,?,?,?,?,?,?,NULL,'pending')", (project, session, message, bank, backend, fingerprint, mid))
        c.commit()
    except Exception:
        c.rollback(); c.close(); raise
    c.close()

    metadata = dict(req.get("metadata") or {})
    metadata["v1_turn_fingerprint"] = fingerprint
    beam = getattr(memory, "beam", None) or getattr(memory, "_beam", None)
    if beam is None or not hasattr(beam, "remember"):
        raise RuntimeError("pinned Mnemosyne Beam remember API unavailable")
    # Beam owns session_id. It may return an existing exact-content row instead
    # of inserting mid; the ledger records that native dedupe outcome.
    source = metadata.pop("source", "opencode")
    importance = float(metadata.pop("importance", 0.7))
    result_id = beam.remember(content=content, source=source, importance=importance,
                              metadata=metadata, scope="global", memory_id=mid)
    if result_id is None: raise RuntimeError("Beam filtered the turn")
    result_id = str(result_id)
    # Match Mnemosyne.remember's backward-compatible dual write. Do not
    # regenerate an existing legacy embedding during pending-ledger recovery.
    legacy = memory.conn
    legacy.execute("INSERT OR REPLACE INTO memories (id,content,source,timestamp,session_id,importance,metadata_json) VALUES (?,?,?,?,?,?,?)",
                   (result_id, content, source, datetime.now().isoformat(), memory.session_id, importance, json.dumps(metadata)))
    from mnemosyne.core import embeddings as _embeddings
    if _embeddings.available() and not legacy.execute("SELECT 1 FROM memory_embeddings WHERE memory_id=?", (result_id,)).fetchone():
        vec = _embeddings.embed([content])
        if vec is not None:
            legacy.execute("INSERT OR REPLACE INTO memory_embeddings (memory_id,embedding_json,model) VALUES (?,?,?)",
                           (result_id, _embeddings.serialize(vec[0]), _embeddings._DEFAULT_MODEL))
    legacy.commit()
    c = _coord()
    try:
        c.execute("BEGIN IMMEDIATE")
        c.execute("UPDATE turn_writes SET result_id=?,status='complete' WHERE project=? AND session=? AND message_id=? AND bank=? AND backend=? AND fingerprint=?", (str(result_id), project, session, message, bank, backend, fingerprint))
        c.commit()
    except Exception:
        c.rollback(); raise
    finally: c.close()
    return {"id": result_id, "reused": False}


def dump(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, default=str, ensure_ascii=False), flush=True)


def sleep_preview(memory: Mnemosyne) -> list[dict[str, Any]]:
    cutoff = (datetime.now() - timedelta(hours=WORKING_MEMORY_TTL_HOURS)).isoformat()
    rows = memory.conn.execute("""SELECT id,content,source,timestamp,session_id,importance,metadata_json,veracity,scope,valid_until
        FROM working_memory WHERE COALESCE(session_id,'default')=? AND timestamp < ?
        AND consolidated_at IS NULL AND (pinned IS NULL OR pinned=0)
        ORDER BY timestamp ASC LIMIT ?""", (memory.session_id, cutoff, SLEEP_BATCH_SIZE)).fetchall()
    return [dict(row) for row in rows]


def sleep_commit(memory: Mnemosyne, payload: dict[str, Any]) -> dict[str, Any]:
    op = payload.get("operation_id"); summary = payload.get("summary")
    ids = payload.get("source_ids")
    if not isinstance(op, str) or not op or not isinstance(summary, str) or not summary.strip():
        raise ValueError("operation_id and non-empty summary are required")
    if not isinstance(ids, list) or not ids or any(not isinstance(x, str) or not x for x in ids) or len(set(ids)) != len(ids):
        raise ValueError("source_ids must be a non-empty list of unique IDs")
    metadata = payload.get("metadata") or {}
    if not isinstance(metadata, dict): raise ValueError("metadata must be an object")
    conn = memory.conn
    fingerprint = json.dumps([summary, ids, metadata], sort_keys=True, separators=(",", ":"))
    episode_id = "sleep-" + hashlib.sha256(op.encode()).hexdigest()[:24]
    try:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute("SELECT id,metadata_json FROM episodic_memory WHERE id=?", (episode_id,)).fetchone()
        if existing:
            saved = json.loads(existing["metadata_json"] or "{}")
            if saved.get("sleep_operation_fingerprint") != fingerprint: raise ValueError("operation_id was reused with a different payload")
            conn.commit(); return {"id": existing["id"], "source_ids": ids, "reused": True}
        placeholders = ",".join("?" * len(ids))
        rows = conn.execute(f"SELECT id,session_id,pinned,consolidated_at FROM working_memory WHERE id IN ({placeholders})", ids).fetchall()
        if len(rows) != len(ids) or any((r["session_id"] or "default") != memory.session_id or r["pinned"] or r["consolidated_at"] is not None for r in rows):
            raise ValueError("source_ids include missing, pinned, consolidated, or wrong-session rows")
        now = datetime.now().isoformat()
        episode_metadata = {**metadata, "consolidated_at": now, "source_ids": ids, "sleep_operation_id": op, "sleep_operation_fingerprint": fingerprint}
        conn.execute("INSERT INTO episodic_memory (id,content,source,timestamp,session_id,importance,metadata_json,summary_of,veracity) VALUES (?,?,?,?,?,?,?,?,?)", (episode_id, summary.strip(), "opencode_sleep", now, memory.session_id, 0.7, json.dumps(episode_metadata), ",".join(ids), "unknown"))
        conn.execute(f"UPDATE working_memory SET consolidated_at=? WHERE id IN ({placeholders})", (now, *ids))
        conn.commit()
        return {"id": episode_id, "source_ids": ids, "reused": False}
    except Exception:
        conn.rollback(); raise


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
            elif operation == "embedding_probe":
                from mnemosyne.core import embeddings as _embeddings
                vector = _embeddings.embed([EMBEDDING_PROBE_TEXT])
                if vector is None or len(vector) == 0 or vector[0] is None or len(vector[0]) == 0:
                    raise RuntimeError("embedding model returned no usable embedding")
                try:
                    values = [float(value) for value in vector[0]]
                except (TypeError, ValueError, OverflowError):
                    raise RuntimeError("embedding model returned an invalid embedding")
                if not all(__import__("math").isfinite(value) for value in values):
                    raise RuntimeError("embedding model returned an invalid embedding")
                result = {"available": True}
            elif operation and operation.startswith("coord_"):
                result = coordination(operation, request)
            elif operation == "remember_turn":
                result = remember_turn(memory, request)
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
                rows = memory.recall(
                    query=query,
                    top_k=limit,
                    temporal_weight=TEMPORAL_WEIGHT,
                    temporal_halflife=TEMPORAL_HALFLIFE_HOURS,
                    query_time=request.get("query_time"),
                )
                result = []
                for row in rows:
                    item = {"content": row.get("content", "")}
                    if isinstance(row.get("score"), (int, float)):
                        item["score"] = row["score"]
                    if item["content"]:
                        for key in ("source", "timestamp", "created_at", "valid_until"):
                            if row.get(key) is not None:
                                item[key] = row[key]
                        if row.get("id") is not None:
                            item["id"] = str(row["id"])
                        item["bank"] = bank
                        result.append(item)
            elif operation == "sleep_preview":
                result = sleep_preview(memory)
            elif operation == "sleep_commit":
                result = sleep_commit(memory, request)
            elif operation == "invalidate":
                memory_id = request.get("memory_id")
                if not isinstance(memory_id, str) or not memory_id:
                    raise ValueError("memory_id is required")
                result = memory.invalidate(memory_id)
            elif operation == "stats":
                result = memory.get_stats()
            else:
                raise ValueError(f"unknown operation: {operation}")

            dump({"id": request_id, "ok": True, "result": result})
        except Exception as error:  # protocol errors are results, not process failures
            dump({"id": request_id, "ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
