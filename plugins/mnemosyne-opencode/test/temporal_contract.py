"""Disposable-database contract test helper for phase-6 temporal ranking."""
import json
import os
from datetime import datetime, timedelta, timezone

from mnemosyne.core.memory import Mnemosyne


def main():
    bank = os.environ["MNEMOSYNE_MCP_BANK"]
    memory = Mnemosyne(session_id="opencode", bank=bank)
    query_time = datetime(2026, 1, 1, tzinfo=timezone.utc)
    cases = {
        "recent": (query_time - timedelta(hours=1)).isoformat(),
        "old": (query_time - timedelta(hours=720)).isoformat(),
        "missing": None,
        "malformed": "not-a-timestamp",
    }
    ids = {}
    for name in cases:
        ids[name] = memory.remember(
            content=f"unique temporal contract marker {name} {bank}",
            source="test", importance=0.7, scope="global",
            valid_until="2099-01-01T00:00:00+00:00",
        )
    conn = memory.beam.conn
    for name, timestamp in cases.items():
        conn.execute("UPDATE working_memory SET timestamp=? WHERE id=?", (timestamp, ids[name]))
    conn.commit()
    before = {r["id"]: dict(r) for r in conn.execute(
        "SELECT id,timestamp,valid_until FROM working_memory WHERE id IN (%s)" % ",".join("?" * len(ids)),
        tuple(ids.values()),
    )}
    query = f"unique temporal contract marker {bank}"
    base = memory.recall(query, top_k=10, temporal_weight=0, query_time=query_time)
    weighted = memory.recall(query, top_k=10, temporal_weight=0.05, temporal_halflife=720, query_time=query_time)
    by_id = lambda rows: {row["id"]: row for row in rows}
    base, weighted = by_id(base), by_id(weighted)
    after = {r["id"]: dict(r) for r in conn.execute(
        "SELECT id,timestamp,valid_until FROM working_memory WHERE id IN (%s)" % ",".join("?" * len(ids)),
        tuple(ids.values()),
    )}
    observed = {}
    for name, memory_id in ids.items():
        assert memory_id in base and memory_id in weighted, (name, base.keys(), weighted.keys())
        ratio = weighted[memory_id]["score"] / base[memory_id]["score"]
        observed[name] = {"base": base[memory_id]["score"], "weighted": weighted[memory_id]["score"], "ratio": ratio}
    assert abs(observed["recent"]["ratio"] - 1.05) < 0.002, observed
    assert abs(observed["old"]["ratio"] - (1 + 0.05 * 2.718281828 ** -1)) < 0.002, observed
    assert observed["missing"]["ratio"] == 1, observed
    assert observed["malformed"]["ratio"] == 1, observed
    assert before == after, (before, after)
    print(json.dumps({"bank": bank, "observed": observed, "rows_unchanged": True}))


if __name__ == "__main__":
    main()
