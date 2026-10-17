import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

function startWorker(dataDir, bank = "default") {
  const child = spawn("uvx", ["--from", "mnemosyne-memory==3.15.1", "--with", "numpy", "python", "memory_worker.py"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      MNEMOSYNE_HOME: dataDir,
      MNEMOSYNE_DATA_DIR: dataDir,
      MNEMOSYNE_PLUGIN_COORD_DB: join(dataDir, "plugin-coord.db"),
      MNEMOSYNE_MCP_BANK: bank,
      MNEMOSYNE_DEFAULT_SCOPE: "global",
      MNEMOSYNE_NO_EMBEDDINGS: "1",
      MNEMOSYNE_LLM_ENABLED: "false",
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const pending = new Map();
  let buffer = "";
  let sequence = 0;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (!waiter) continue;
      pending.delete(response.id);
      if (response.ok) waiter.resolve(response.result);
      else waiter.reject(new Error(response.error));
    }
  });
  child.stderr.on("data", () => {});
  return {
    child,
    call(operation, payload = {}) {
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`);
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try { await this.call("shutdown"); } catch {}
      try {
        const descendants = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
        for (const pid of descendants) process.kill(Number(pid), "SIGTERM");
      } catch {}
      child.kill("SIGTERM");
      let timeout;
      await Promise.race([exited, new Promise((resolve) => { timeout = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 5000); })]);
      clearTimeout(timeout);
    },
  };
}

test("Mnemosyne worker remembers and recalls in file-only mode", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-worker-"));
  const worker = startWorker(dataDir);
  t.after(async () => {
    await worker.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const marker = `worker-${Date.now()}: keep project context`;
  const remembered = await worker.call("remember", {
    content: marker,
    metadata: { role: "user", session_id: "ses-test" },
  });
  assert.ok(remembered.id);
  const recalled = await worker.call("recall", { query: "project context", limit: 3 });
  assert.ok(recalled.some((item) => item.content === marker));
  const item = recalled.find((entry) => entry.content === marker);
  assert.ok(item.id);
  assert.equal(item.bank, "default");
  assert.equal(typeof item.score, "number");
  const invalidated = await worker.call("invalidate", { memory_id: item.id });
  assert.equal(invalidated, true);
  await assert.rejects(worker.call("invalidate", {}), /memory_id is required/);
});

test("shared coordination uses transactional snapshot claims and idempotent requests", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-coord-worker-"));
  const workers = [startWorker(dataDir), startWorker(dataDir)];
  t.after(async () => { for (const w of workers) await w.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const a = workers[0], b = workers[1], base = { project: "/project", session: "s" };
  await a.call("coord_publish_snapshot", { ...base, generation: 2, fingerprint: "f", payload: { x: 1 } });
  assert.deepEqual(await a.call("coord_mark_snapshot_injected", { ...base, generation: 2, fingerprint: "f" }), { marked: true });
  assert.equal((await a.call("coord_get_snapshot", base)).payload.injected, true);
  assert.deepEqual(await a.call("coord_publish_snapshot", { ...base, generation: 1, fingerprint: "old", payload: {} }), { published: false });
  assert.deepEqual(await a.call("coord_publish_snapshot", { ...base, generation: 2, fingerprint: "conflict", payload: {} }), { published: false });
  assert.deepEqual(await a.call("coord_claim_snapshot", { ...base, generation: 1, fingerprint: "f" }), { claimed: false });
  const claims = await Promise.all([a.call("coord_claim_snapshot", { ...base, generation: 2, fingerprint: "f" }), b.call("coord_claim_snapshot", { ...base, generation: 2, fingerprint: "f" })]);
  assert.equal(claims.filter(x => x.claimed).length, 1);
  assert.deepEqual(await a.call("coord_release_snapshot", { ...base, generation: 2, fingerprint: "f" }), { released: true });
  assert.deepEqual(await b.call("coord_claim_snapshot", { ...base, generation: 2, fingerprint: "f" }), { claimed: true });
  assert.deepEqual(await b.call("coord_release_snapshot", { ...base, generation: 1, fingerprint: "f" }), { released: false }, "release is scoped to exact generation/fingerprint");
  const request = { ...base, operation_id: "op", kind: "sleep", fingerprint: "fp", payload: { safe: true } };
  await a.call("coord_enqueue_request", request); await b.call("coord_enqueue_request", request);
  await assert.rejects(b.call("coord_enqueue_request", { ...request, project: "/different-project" }), /different payload/);
  await assert.rejects(b.call("coord_enqueue_request", { ...request, kind: "other-kind" }), /different payload/);
  assert.deepEqual(await a.call("coord_request_status", { operation_id: "op" }), { status: "pending", result: null });
  const claimed = await a.call("coord_claim_next", { project: "/project", server_epoch: "epoch" });
  assert.equal(claimed.operation_id, "op");
  await a.call("coord_heartbeat", { server_epoch: "epoch" });
  assert.equal(await b.call("coord_claim_next", { project: "/other", server_epoch: "other" }), null);
  assert.deepEqual(await b.call("coord_finish_request", { operation_id: "op", server_epoch: "epoch", status: "complete", result: { ok: 1 } }), { finished: true });
  assert.equal((await a.call("coord_request_status", { operation_id: "op" })).status, "complete");
  assert.deepEqual(await b.call("coord_heartbeat", { server_epoch: "epoch" }), { ok: true });

  // Simulate an abruptly dead server by claiming without ever heartbeating.
  await a.call("coord_enqueue_request", { ...base, operation_id: "crashed", kind: "sleep", fingerprint: "crash-fp", payload: {} });
  assert.equal((await a.call("coord_claim_next", { project: "/project", server_epoch: "dead-epoch" })).operation_id, "crashed");
  assert.equal((await b.call("coord_claim_next", { project: "/project", server_epoch: "restarted" })).operation_id, "crashed");
});

test("V1 turn ledger retries, rejects conflicts, and respects native exact-content dedupe", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-turn-worker-"));
  const worker = startWorker(dataDir);
  t.after(async () => { await worker.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const db = join(dataDir, "mnemosyne.db");
  const turn = (messageID, content) => worker.call("remember_turn", { project: dataDir, sessionID: "s", messageID, content });
  const first = await turn("m1", "same exact turn content");
  const count = () => spawnSync("python", ["-c", "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('select count(*) from working_memory').fetchone()[0])", db], { encoding: "utf8" }).stdout.trim();
  const oneRow = count();
  const parity = spawnSync("python", ["-c", "import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps([c.execute('select importance,scope from working_memory').fetchone(),c.execute('select count(*) from memories').fetchone()[0],c.execute('select count(*) from memory_embeddings').fetchone()[0]]))", db], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(parity.stdout), [[0.7, "global"], 1, 0], "worker defaults and legacy row match Mnemosyne wrapper; embeddings disabled in test env");
  assert.equal((await turn("m1", "same exact turn content")).id, first.id);
  assert.equal(count(), oneRow, "same-key retry inserts no row");
  assert.equal(JSON.parse(spawnSync("python", ["-c", "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('select count(*) from memories').fetchone()[0])", db], { encoding: "utf8" }).stdout), 1, "retry replaces rather than duplicates legacy row");
  await assert.rejects(turn("m1", "changed payload"), /different payload/);
  const duplicate = await turn("m2", "same exact turn content");
  assert.equal(duplicate.id, first.id, "distinct message follows native exact-content dedupe");
  assert.equal(count(), oneRow, "native dedupe adds no working row");
  const recoveryFingerprint = createHash("sha256").update(JSON.stringify(["recovered payload", {}])).digest("hex");
  const py = `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("insert into turn_writes values(?,?,?,?,?,?,?,NULL,'pending')", (sys.argv[2], 's','m3','default',sys.argv[4],sys.argv[3],'recover-mid')); c.commit()`;
  assert.equal(spawnSync("python", ["-c", py, join(dataDir, "plugin-coord.db"), dataDir, recoveryFingerprint, dataDir], { encoding: "utf8" }).status, 0);
  const recovered = await turn("m3", "recovered payload");
  assert.ok(recovered.id);
  assert.equal(count(), String(Number(oneRow) + 1), "pending ledger without bank row is recovered once");
});

test("the fixed temporal recall policy works independently in project and global banks", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-temporal-worker-"));
  const workers = [startWorker(dataDir, "opencode_project_test"), startWorker(dataDir, "opencode_global")];
  t.after(async () => {
    for (const worker of workers) await worker.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  for (const [index, worker] of workers.entries()) {
    const marker = `temporal policy bank ${index} ${Date.now()}`;
    await worker.call("remember", { content: marker, metadata: { role: "user", session_id: `temporal-${index}` } });
    const recalled = await worker.call("recall", { query: "temporal policy bank", limit: 2 });
    const row = recalled.find((item) => item.content === marker);
    assert.ok(row, `recalled in ${index ? "global" : "project"} bank`);
    assert.equal(row.bank, index ? "opencode_global" : "opencode_project_test");
    assert.equal(typeof row.score, "number");
    assert.equal(row.valid_until, undefined, "recall does not add or mutate validity fields");
  }
});

test("sleep preview is read-only and staged commits are atomic and idempotent", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-sleep-worker-"));
  const worker = startWorker(dataDir);
  t.after(async () => { await worker.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const db = join(dataDir, "mnemosyne.db");
  await worker.call("ping");
  const py = `import sqlite3,sys,datetime\nc=sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO working_memory(id,content,timestamp,session_id) VALUES('src','source',?,'opencode')",((datetime.datetime.now()-datetime.timedelta(days=10)).isoformat(),)); c.commit()`;
  const seed = spawnSync("python", ["-c", py, db], { encoding: "utf8" });
  assert.equal(seed.status, 0, seed.stderr);
  const snapshot = () => spawnSync("python", ["-c", "import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps([c.execute('select id,consolidated_at from working_memory order by id').fetchall(),c.execute('select id from episodic_memory order by id').fetchall()]))", db], { encoding: "utf8" }).stdout.trim();
  const beforePreview = snapshot();
  const preview = await worker.call("sleep_preview");
  assert.equal(preview.length, 1);
  assert.equal(preview[0].id, "src");
  assert.equal(snapshot(), beforePreview, "preview performs no DB writes");
  assert.equal((await worker.call("sleep_commit", { operation_id: "op1", summary: "summary", source_ids: ["src"] })).reused, false);
  assert.equal((await worker.call("sleep_commit", { operation_id: "op1", summary: "summary", source_ids: ["src"] })).reused, true);
  await assert.rejects(worker.call("sleep_commit", { operation_id: "op1", summary: "different", source_ids: ["src"] }), /different payload/);
  await assert.rejects(worker.call("sleep_commit", { operation_id: "bad", summary: "x", source_ids: ["absent"] }), /source_ids include/);
  const state = JSON.parse(snapshot());
  assert.equal(state[0].length, 1, "source row is retained");
  assert.ok(state[0][0][1], "source is marked consolidated");
  assert.equal(state[1].length, 1, "successful commit inserted one episode");
  const summaryOf = spawnSync("python", ["-c", "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('select summary_of from episodic_memory').fetchone()[0])", db], { encoding: "utf8" });
  assert.equal(summaryOf.stdout.trim(), "src", "source linkage matches Mnemosyne's native comma-delimited schema");
  assert.deepEqual(JSON.parse(snapshot()), state, "failed commit changes neither table");
  assert.equal((await worker.call("ping")).status, "ok");
});

test("pinned temporal scoring boosts recent rows, leaves invalid timestamps unchanged, and never mutates stored rows", (t) => {
  const root = mkdtempSync(join(tmpdir(), "memory-temporal-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = new URL("./temporal_contract.py", import.meta.url).pathname;
  for (const bank of ["opencode_project_test", "opencode_global"]) {
    const dataDir = join(root, bank);
    const run = spawnSync("uvx", ["--from", "mnemosyne-memory==3.15.1", "--with", "numpy", "python", helper], {
      encoding: "utf8",
      env: { ...process.env, MNEMOSYNE_HOME: dataDir, MNEMOSYNE_DATA_DIR: dataDir, MNEMOSYNE_MCP_BANK: bank, MNEMOSYNE_DEFAULT_SCOPE: "global", MNEMOSYNE_NO_EMBEDDINGS: "1", MNEMOSYNE_LLM_ENABLED: "false" },
      timeout: 60000,
    });
    assert.equal(run.status, 0, `${bank}: ${run.stderr || run.stdout}`);
    const result = JSON.parse(run.stdout.trim().split("\n").at(-1));
    assert.equal(result.bank, bank);
    assert.equal(result.rows_unchanged, true);
  }
});
