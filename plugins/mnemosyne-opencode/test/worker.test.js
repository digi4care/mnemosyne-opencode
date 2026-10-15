import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function startWorker(dataDir) {
  const child = spawn("uvx", ["--from", "mnemosyne-memory==3.15.1", "--with", "numpy", "python", "memory_worker.py"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      MNEMOSYNE_HOME: dataDir,
      MNEMOSYNE_DATA_DIR: dataDir,
      MNEMOSYNE_MCP_BANK: "default",
      MNEMOSYNE_DEFAULT_SCOPE: "global",
      MNEMOSYNE_NO_EMBEDDINGS: "1",
      MNEMOSYNE_LLM_ENABLED: "false",
    },
    stdio: ["pipe", "pipe", "pipe"],
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
  };
}

test("Mnemosyne worker remembers and recalls in file-only mode", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-worker-"));
  const worker = startWorker(dataDir);
  t.after(() => {
    worker.child.kill("SIGTERM");
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
});
