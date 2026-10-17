import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignTurnModes, createSerializedCallQueue, createSerializedFlush, createTransitionBoundary, getProject, recallMemories, workerMatchesProject, writeDestination } from "../index.js";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "mnemo-global-"));
  process.env.MNEMOSYNE_STATE_FILE = join(root, "state.json");
  process.env.MNEMOSYNE_DATA_DIR = join(root, "data");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  const ctx = { location: { directory: root, project: { canonical: root } } };
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.MNEMOSYNE_STATE_FILE;
    delete process.env.MNEMOSYNE_DATA_DIR;
    delete process.env.XDG_CONFIG_HOME;
  });
  return { ctx, project: { ...getProject(ctx), globalBank: true, recallLimit: 3 } };
}

test("recall prefers project quota, exact-content deduplicates global and caps total", async (t) => {
  const { ctx, project } = setup(t);
  const banks = [];
  const got = await recallMemories(ctx, project, "q", async (_ctx, p) => {
    banks.push(p.bank);
    return p.bank === "opencode_global"
      ? [{ content: "dupe" }, { content: "global" }, { content: "extra" }]
      : [{ content: "dupe" }, { content: "project" }, { content: "project 2" }];
  });
  assert.deepEqual(banks, [project.bank, "opencode_global"]);
  assert.deepEqual(got.map((x) => x.content), ["dupe", "project", "project 2"]);
  assert.ok(got.length <= project.recallLimit);
});

test("global recall failure preserves project results", async (t) => {
  const { ctx, project } = setup(t);
  const got = await recallMemories(ctx, project, "q", async (_ctx, p) => {
    if (p.bank === "opencode_global") throw new Error("global unavailable");
    return [{ content: "project result" }];
  });
  assert.deepEqual(got, [{ content: "project result" }]);
  assert.match(getProject(ctx).lastError, /Global recall failed/);
});

test("project recall failure falls back to global results and records degradation", async (t) => {
  const { ctx, project } = setup(t);
  const got = await recallMemories(ctx, project, "q", async (_ctx, p) => {
    if (p.bank !== "opencode_global") throw new Error("project unavailable");
    return [{ content: "global result" }];
  });
  assert.deepEqual(got, [{ content: "global result" }]);
  assert.match(getProject(ctx).lastError, /Project recall failed/);
});

test("project failure without global access reports failure", async (t) => {
  const { ctx, project } = setup(t);
  await assert.rejects(recallMemories(ctx, { ...project, globalBank: false }, "q", async () => {
    throw new Error("project unavailable");
  }), /project unavailable/);
  assert.match(getProject(ctx).lastError, /Project recall failed/);
});

test("destination routes effective global writes to shared bank, otherwise preserves project bank", () => {
  const project = { bank: "opencode_project", effectiveWriteMode: "project" };
  assert.equal(writeDestination(project).bank, "opencode_project");
  assert.equal(writeDestination({ ...project, effectiveWriteMode: "global" }).bank, "opencode_global");
});

test("worker cache identity includes dataDir", () => {
  const worker = { backend: "mnemosyne-file", bank: "opencode_project", dataDir: "/data/one" };
  assert.equal(workerMatchesProject(worker, { ...worker }), true);
  assert.equal(workerMatchesProject(worker, { ...worker, dataDir: "/data/two" }), false);
});

test("concurrent idle flushes for one session serialize and do not duplicate turns", async () => {
  let writes = 0;
  let cursor = 0;
  const flush = async () => {
    const turnCount = 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (turnCount > cursor) { writes++; cursor = turnCount; }
  };
  const serialized = createSerializedFlush(flush);
  await Promise.all([serialized("session"), serialized("session"), serialized("session")]);
  assert.equal(writes, 1);
});

test("worker call queue waits for in-flight call before a bank switch", async () => {
  const active = new Set();
  const observed = [];
  const call = createSerializedCallQueue(async (bank, delay) => {
    assert.equal(active.size, 0);
    active.add(bank);
    observed.push(bank);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active.delete(bank);
    return bank;
  });
  const first = call("project", 10);
  const second = call("opencode_global", 0);
  assert.deepEqual(await Promise.all([first, second]), ["project", "opencode_global"]);
  assert.deepEqual(observed, ["project", "opencode_global"]);
});

test("transition waits for in-flight and queued prompts, switching only between them", async () => {
  const boundary = createTransitionBoundary();
  let mode = "project";
  const writes = [];
  let releaseRecall;
  const first = boundary.runPrompt(async () => {
    await new Promise((resolve) => { releaseRecall = resolve; });
    writes.push(mode);
  });
  await new Promise((resolve) => setImmediate(resolve));
  const switching = boundary.transition(async () => { mode = "global"; });
  const queued = boundary.runPrompt(async () => writes.push(mode));
  releaseRecall();
  await Promise.all([first, switching, queued]);
  assert.deepEqual(writes, ["project", "global"]);
});

test("concurrent transitions serialize without overlapping flush/persist callbacks", async () => {
  const boundary = createTransitionBoundary();
  let active = 0;
  const order = [];
  const run = (label) => boundary.transition(async () => {
    assert.equal(active, 0);
    active++;
    order.push(`${label}:start`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`${label}:end`);
    active--;
  });
  await Promise.all([run("a"), run("b")]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
});

test("transition callbacks are setup-local", async () => {
  const one = createTransitionBoundary();
  const two = createTransitionBoundary();
  const oneLog = [];
  const twoLog = [];
  await one.transition(async () => oneLog.push("one"));
  assert.deepEqual(oneLog, ["one"]);
  assert.deepEqual(twoLog, []);
  await two.transition(async () => twoLog.push("two"));
  assert.deepEqual(twoLog, ["two"]);
});

test("delayed turns retain prompt-mode snapshots across an empty transition flush", () => {
  const snapshots = ["project"];
  const oldVisible = [];
  assert.deepEqual(assignTurnModes(oldVisible, 0, snapshots, "global"), []);
  assert.deepEqual(snapshots, ["project"]);

  const turns = [
    { role: "user", content: "old prompt" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "new prompt" },
    { role: "assistant", content: "new answer" },
  ];
  snapshots.push("global");
  const assigned = assignTurnModes(turns, 0, snapshots, "global");
  assert.deepEqual(assigned.map((turn) => turn.writeMode), ["project", "project", "global", "global"]);
  assert.equal(writeDestination({ bank: "opencode_project", effectiveWriteMode: assigned[0].writeMode }).bank, "opencode_project");
  assert.equal(writeDestination({ bank: "opencode_project", effectiveWriteMode: assigned[2].writeMode }).bank, "opencode_global");
  assert.deepEqual(snapshots, []);
});

test("multiple delayed user turns consume snapshots in order and assistants inherit their user mode", () => {
  const snapshots = ["project", "global", "project"];
  const turns = [
    { role: "user" }, { role: "assistant" }, { role: "assistant" },
    { role: "user" }, { role: "assistant" }, { role: "user" }, { role: "assistant" },
  ];
  const assigned = assignTurnModes(turns, 0, snapshots, "global");
  assert.deepEqual(assigned.map((turn) => turn.writeMode), ["project", "project", "project", "global", "global", "project", "project"]);
  assert.deepEqual(snapshots, []);
});

test("assistant-only delayed flush continues the captured user mode across a mode transition", () => {
  const snapshots = ["project"];
  let continuation;
  const userOnly = assignTurnModes([{ role: "user", content: "old prompt" }], 0, snapshots, "project", continuation);
  assert.deepEqual(userOnly.map((turn) => turn.writeMode), ["project"]);
  continuation = userOnly.at(-1).writeMode;

  // The transition changes the current configured mode, but the assistant belongs
  // to the earlier user turn and must continue using its captured destination.
  const assistantOnly = assignTurnModes([{ role: "assistant", content: "old answer" }], 0, snapshots, "global", continuation);
  assert.deepEqual(assistantOnly.map((turn) => turn.writeMode), ["project"]);
  continuation = assistantOnly.at(-1).writeMode;

  snapshots.push("global");
  const nextTurn = assignTurnModes([
    { role: "user", content: "new prompt" },
    { role: "assistant", content: "new answer" },
  ], 0, snapshots, "global", continuation);
  assert.deepEqual(nextTurn.map((turn) => turn.writeMode), ["global", "global"]);
  assert.deepEqual(snapshots, []);
});
