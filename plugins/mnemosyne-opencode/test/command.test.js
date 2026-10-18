import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKENDS, configFingerprint, createMnemosyneCommand, formatStats, getProject } from "../index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "memory-command-"));
  process.env.MNEMOSYNE_STATE_FILE = join(root, "projects.json");
  process.env.MNEMOSYNE_DATA_DIR = join(root, "data");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  // Since D1 the plugin writes configuration to the project's opencode.jsonc, so
  // the project directory must be inside the temp root. Pointing it at a fixed
  // path would make tests write outside the sandbox and leak between runs.
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  // The TUI renders `description`, not `text` (see routes/session/rows.ts:
  // synthetic messages without a description are skipped entirely). Assert on
  // the field the user actually sees, and record `resume` so a model-free
  // command stays model-free.
  const replies = [];
  const calls = [];
  const ctx = {
    location: { directory: projectDir, project: { canonical: projectDir } },
    session: {
      synthetic: async ({ text, description, resume }) => {
        replies.push(description);
        calls.push({ text, description, resume });
        return { text, description };
      },
    },
  };
  return { ctx, command: createMnemosyneCommand(ctx), replies, calls, root, projectDir };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
  delete process.env.MNEMOSYNE_STATE_FILE;
  delete process.env.MNEMOSYNE_DATA_DIR;
  delete process.env.MNEMOSYNE_BIN;
  delete process.env.XDG_CONFIG_HOME;
}

test("bare /mnemosyne shows how-to without changing project state", async (t) => {
  const { ctx, command, replies, calls, root } = fixture();
  t.after(() => cleanup(root));
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne", delivery: "queue" } });
  const project = getProject(ctx);
  assert.equal(project.enabled, false);
  assert.match(replies[0], /\/mnemosyne on\|off/);
  assert.match(replies[0], /\/mnemosyne file/);
  assert.match(replies[0], /\/mnemosyne embedded/);
  assert.match(replies[0], /\/mnemosyne backup/);
  assert.match(replies[0], /\/mnemosyne verify/);
  assert.match(replies[0], /\/mnemosyne import hindsight/);
  assert.doesNotMatch(replies[0], /\/mnemosyne hindsight\b/);
  // Visible output must reach the user, and the model must not be woken for it.
  assert.ok(calls[0].description.length > 0);
  assert.equal(calls[0].resume, false);
});

test("on/off and backend selection persist independently", async (t) => {
  const { ctx, command, replies, root } = fixture();
  t.after(() => cleanup(root));
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne on", delivery: "queue" } });
  assert.equal(getProject(ctx).enabled, true);
  assert.equal(getProject(ctx).backend, BACKENDS.file);

  const injected = createMnemosyneCommand(ctx, { embeddingProbe: async () => ({ available: true }) });
  await injected.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne embedded", delivery: "queue" } });
  assert.equal(getProject(ctx).backend, BACKENDS.embedded);
  assert.equal(getProject(ctx).enabled, true);

  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne file", delivery: "queue" } });
  assert.equal(getProject(ctx).backend, BACKENDS.file);
  assert.equal(getProject(ctx).enabled, true);

  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne off", delivery: "queue" } });
  assert.equal(getProject(ctx).enabled, false);
  assert.equal(getProject(ctx).backend, BACKENDS.file);
  assert.equal(replies.length, 4);
});

test("embedded selection probes; failure warns but preserves backend and configuration", async (t) => {
  const { ctx, replies, root } = fixture(); t.after(() => cleanup(root));
  const calls = [];
  const command = createMnemosyneCommand(ctx, { embeddingProbe: async (project) => { calls.push(project.backend); throw new Error("model unavailable"); } });
  await command.execute({ sessionID: "s", prompt: { text: "/mnemosyne embedded" } });
  assert.deepEqual(calls, [BACKENDS.embedded]);
  assert.equal(getProject(ctx).backend, BACKENDS.embedded);
  assert.equal(getProject(ctx).enabled, true);
  assert.match(replies.at(-1), /WARNING: embedding service unavailable: model unavailable/);
});

test("embedded selection reports successful probe", async (t) => {
  const { ctx, replies, root } = fixture(); t.after(() => cleanup(root));
  const command = createMnemosyneCommand(ctx, { embeddingProbe: async () => ({ available: true }) });
  await command.execute({ sessionID: "s", prompt: { text: "/mnemosyne embedded" } });
  assert.match(replies.at(-1), /Embedding service: available/);
});

test("status probes afresh only for embedded backend", async (t) => {
  const { ctx, replies, root } = fixture(); t.after(() => cleanup(root));
  let outcome = true; let probes = 0;
  const command = createMnemosyneCommand(ctx, { embeddingProbe: async () => { probes++; if (!outcome) throw new Error("offline"); return { available: true }; } });
  await command.execute({ sessionID: "s", prompt: { text: "/mnemosyne embedded" } });
  await command.execute({ sessionID: "s", prompt: { text: "/mnemosyne status" } });
  assert.match(replies.at(-1), /embedding_service: available/);
  outcome = false;
  await command.execute({ sessionID: "s", prompt: { text: "/mnemosyne status" } });
  assert.match(replies.at(-1), /embedding_service: unavailable — offline/);
  assert.equal(probes, 3);
  await command.execute({ sessionID: "s", prompt: { text: "/mnemosyne file" } });
  await command.execute({ sessionID: "s", prompt: { text: "/mnemosyne status" } });
  assert.equal(probes, 3, "file status does not probe");
});

test("status reports backend and last error without a model call", async (t) => {
  const { ctx, command, replies, calls, root } = fixture();
  t.after(() => cleanup(root));
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne file", delivery: "queue" } });
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne status", delivery: "queue" } });
  const status = replies.at(-1);
  assert.match(status, /enabled: true/);
  assert.match(status, /backend: mnemosyne-file/);
  assert.match(status, /bank: opencode_[0-9a-f]{16}/);
  assert.equal(calls.at(-1).resume, false);
});

const sampleStats = { beam: { working_memory: { total: 5, consolidated: 2, unconsolidated: 3 }, episodic_memory: { total: 1, vectors: 4, vec_type: "sqlite" }, triples: { total: 7 } }, total_memories: 9, arbitrary: { secret: true } };

test("stats formatter presents BEAM tiers and labels legacy count", () => {
  const text = formatStats(sampleStats).join("\n");
  assert.match(text, /Working memory: total 5; consolidated 2; unconsolidated 3/);
  assert.match(text, /Episodic memory: total 1; vectors 4; vector type sqlite/);
  assert.match(text, /Triples: 7/);
  assert.match(text, /Legacy memories \(separate from BEAM tiers\): 9/);
  assert.doesNotMatch(text, /secret|arbitrary/);
});

test("stats queries project then global bank, remains model-free", async (t) => {
  const { ctx, replies, calls, root } = fixture();
  t.after(() => cleanup(root));
  const identities = [];
  const command = createMnemosyneCommand(ctx, { backendCall: async (_ctx, project, op) => { identities.push([project.bank, op]); return sampleStats; } });
  await command.execute({ sessionID: "ses-stats", prompt: { text: "/mnemosyne stats" } });
  assert.deepEqual(identities.map(([bank]) => bank), [getProject(ctx).bank, "opencode_global"]);
  assert.match(replies[0], /Project bank/);
  assert.match(replies[0], /Global bank \(opencode_global\)/);
  assert.equal(calls[0].resume, false);
});

test("stats reports disabled global bank and preserves project output on global failure", async (t) => {
  const { ctx, replies, root } = fixture();
  t.after(() => cleanup(root));
  const config = await import("node:fs/promises");
  await config.writeFile(join(getProject(ctx).directory, "opencode.jsonc"), '{"mnemosyne":{"globalBank":false}}');
  const identities = [];
  const disabled = createMnemosyneCommand(ctx, { backendCall: async (_ctx, project) => { identities.push(project.bank); return sampleStats; } });
  await disabled.execute({ sessionID: "ses-stats", prompt: { text: "/mnemosyne stats" } });
  assert.deepEqual(identities, [getProject(ctx).bank]);
  assert.match(replies.at(-1), /Global bank: disabled/);
  await config.writeFile(join(getProject(ctx).directory, "opencode.jsonc"), '{"mnemosyne":{"globalBank":true}}');
  const enabled = createMnemosyneCommand(ctx, { backendCall: async (_ctx, project) => { if (project.bank === "opencode_global") throw new Error("offline"); return sampleStats; } });
  await enabled.execute({ sessionID: "ses-stats", prompt: { text: "/mnemosyne stats" } });
  assert.match(replies.at(-1), /Working memory: total 5/);
  assert.match(replies.at(-1), /Global bank .*stats unavailable: offline/);
});

// The CLI-backed commands (backup, verify, import hindsight) shell out through
// runCli. Pointing MNEMOSYNE_BIN at /bin/echo replaces uvx with a stub that just
// prints its arguments, so these tests assert on the exact CLI invocation
// without needing uvx, network, or a real database.
function cliFixture() {
  const base = fixture();
  process.env.MNEMOSYNE_BIN = "/bin/echo";
  return base;
}

test("backup reports CLI output and stays model-free", async (t) => {
  const { ctx, command, replies, calls, root } = cliFixture();
  t.after(() => cleanup(root));
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne backup", delivery: "queue" } });
  assert.match(replies.at(-1), /^backup/);
  assert.equal(calls.at(-1).resume, false);
});

test("backup forwards an explicit output directory", async (t) => {
  const { ctx, command, replies, root } = cliFixture();
  t.after(() => cleanup(root));
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne backup /tmp/backup_out", delivery: "queue" } });
  assert.match(replies.at(-1), /\/tmp\/backup_out/);
});

test("verify uses --quick unless --full is given", async (t) => {
  const { ctx, command, replies, root } = cliFixture();
  t.after(() => cleanup(root));

  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne verify", delivery: "queue" } });
  assert.match(replies.at(-1), /--quick/);

  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne verify --full", delivery: "queue" } });
  assert.doesNotMatch(replies.at(-1), /--quick/);
});

test("import hindsight without a source reports usage", async (t) => {
  const { ctx, command, replies, calls, root } = fixture();
  t.after(() => cleanup(root));
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne import hindsight", delivery: "queue" } });
  assert.match(replies.at(-1), /import hindsight/);
  assert.doesNotMatch(replies.at(-1), /Unknown/);
  assert.equal(calls.at(-1).resume, false);
});

test("import hindsight forwards the source to the CLI", async (t) => {
  const { ctx, command, replies, root } = cliFixture();
  t.after(() => cleanup(root));
  await command.execute({
    sessionID: "ses-a",
    prompt: { text: "/mnemosyne import hindsight ./export.json", delivery: "queue" },
  });
  assert.match(replies.at(-1), /import-hindsight/);
  assert.match(replies.at(-1), /export\.json/);
});

test("the removed hindsight backend is an unknown action and changes nothing", async (t) => {
  const { ctx, command, replies, root } = fixture();
  t.after(() => cleanup(root));
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne file", delivery: "queue" } });
  const before = getProject(ctx).backend;

  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne hindsight", delivery: "queue" } });
  assert.match(replies.at(-1), /Unknown memory action/);
  assert.equal(getProject(ctx).backend, before);
});

test("invalidation routes only snapshot ID and bank, confirms global once, and never retries errors", async (t) => {
  const { ctx, replies, root } = fixture();
  t.after(() => cleanup(root));
  const project = getProject(ctx);
  let snapshot = { results: [{ id: "p-1", bank: project.bank, content: "project fact" }, { id: "g-1", bank: "opencode_global", content: "global fact" }], fingerprint: configFingerprint(project) };
  const calls = [];
  let outcome = true;
  const command = createMnemosyneCommand(ctx, { getSnapshot: () => snapshot, backendCall: async (_ctx, p, op, payload) => { calls.push([p.bank, op, payload]); if (outcome instanceof Error) throw outcome; return outcome; } });
  const run = (text) => command.execute({ sessionID: "ses-a", prompt: { text: `/mnemosyne ${text}` } });
  await run("invalidate 1");
  assert.deepEqual(calls[0], [project.bank, "invalidate", { memory_id: "p-1" }]);
  outcome = false;
  await run("invalidate 1");
  assert.match(replies.at(-1), /not confirmed/);
  outcome = new Error("timeout");
  await run("invalidate 1");
  assert.match(replies.at(-1), /outcome unknown/);
  assert.equal(calls.length, 3);
  outcome = true;
  await run("invalidate 2");
  assert.match(replies.at(-1), /global fact/);
  await run("confirm");
  assert.deepEqual(calls.at(-1), ["opencode_global", "invalidate", { memory_id: "g-1" }]);
  await run("confirm");
  assert.match(replies.at(-1), /stale/);
  assert.equal(calls.length, 4);
});

test("invalidation fails closed for missing, stale, and disabled-global targets", async (t) => {
  const { ctx, replies, root } = fixture();
  t.after(() => cleanup(root));
  const config = await import("node:fs/promises");
  const project = getProject(ctx);
  let snapshot = { results: [{ bank: project.bank, content: "no id" }], fingerprint: configFingerprint(project) };
  let calls = 0;
  const command = createMnemosyneCommand(ctx, { getSnapshot: () => snapshot, backendCall: async () => { calls++; return true; } });
  const run = (text) => command.execute({ sessionID: "ses-a", prompt: { text: `/mnemosyne ${text}` } });
  await run("invalidate 1");
  assert.equal(calls, 0);
  snapshot = { results: [{ id: "g", bank: "opencode_global", content: "shared" }], fingerprint: configFingerprint(project) };
  await config.writeFile(join(project.directory, "opencode.jsonc"), '{"mnemosyne":{"globalBank":false}}');
  await run("invalidate 1");
  assert.equal(calls, 0);
  assert.match(replies.at(-1), /stale/);
});

test("global confirmation is bound to snapshot and current project configuration", async (t) => {
  const { ctx, replies, root } = fixture();
  t.after(() => cleanup(root));
  const project = getProject(ctx);
  const original = { results: [{ id: "g", bank: "opencode_global", content: "shared fact" }], fingerprint: configFingerprint(project) };
  let snapshot = original;
  let calls = 0;
  const command = createMnemosyneCommand(ctx, { getSnapshot: () => snapshot, backendCall: async () => { calls++; return true; } });
  const run = (sessionID, action) => command.execute({ sessionID, prompt: { text: `/mnemosyne ${action}` } });
  await run("same", "invalidate 1");
  await run("same", "confirm");
  assert.equal(calls, 1, "same session and snapshot confirms");

  await run("new-snapshot", "invalidate 1");
  snapshot = { results: [{ id: "g2", bank: "opencode_global", content: "new shared fact" }], fingerprint: configFingerprint(project) };
  await run("new-snapshot", "confirm");
  assert.equal(calls, 1);
  assert.match(replies.at(-1), /stale/);

  snapshot = original;
  const config = await import("node:fs/promises");
  for (const mutation of [
    { enabled: true },
    { backend: "mnemosyne-embedded" },
    { recallLimit: 8 },
    { writeMode: "global" },
    { globalBank: false },
  ]) {
    await config.writeFile(join(project.directory, "opencode.jsonc"), '{"mnemosyne":{}}');
    await run("changed", "invalidate 1");
    await config.writeFile(join(project.directory, "opencode.jsonc"), JSON.stringify({ mnemosyne: mutation }));
    await run("changed", "confirm");
    assert.equal(calls, 1, `rejects config change ${JSON.stringify(mutation)}`);
  }
});

test("confirm without pending state and project snapshots with changed backend or dataDir fail closed", async (t) => {
  const { ctx, replies, root } = fixture();
  t.after(() => cleanup(root));
  const project = getProject(ctx);
  let snapshot = { results: [{ id: "p", bank: project.bank, content: "project" }], fingerprint: configFingerprint(project) };
  let calls = 0;
  const command = createMnemosyneCommand(ctx, { getSnapshot: () => snapshot, backendCall: async () => { calls++; return true; } });
  const run = (text) => command.execute({ sessionID: "session", prompt: { text: `/mnemosyne ${text}` } });
  await run("confirm");
  assert.equal(calls, 0);
  for (const changes of [{ backend: "mnemosyne-embedded" }, { dataDir: join(root, "other-data") }]) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(project.directory, "opencode.jsonc"), JSON.stringify({ mnemosyne: changes }));
    await run("invalidate 1");
    assert.equal(calls, 0);
    await fs.writeFile(join(project.directory, "opencode.jsonc"), '{"mnemosyne":{}}');
  }
  assert.match(replies.at(-1), /stale/);
});

function sleepHarness(t, { v2 = true, model = { providerID: "openai", id: "gpt-test" }, preview = [{ id: "source-a", content: "candidate" }], flushPendingTurns } = {}) {
  const base = fixture();
  t.after(() => cleanup(base.root));
  const generated = [], backend = [];
  if (v2) {
    base.ctx.session.get = async ({ sessionID }) => { assert.equal(sessionID, "sleep-session"); return model ? { model } : {}; };
    base.ctx.generate = { text: async (request) => { generated.push(request); return { text: "approved summary" }; } };
  }
  const command = createMnemosyneCommand(base.ctx, { flushPendingTurns, backendCall: async (_ctx, project, operation, payload) => {
    backend.push({ bank: project.bank, operation, payload });
    if (operation === "sleep_preview") return preview;
    if (operation === "sleep_commit" && backend.filter((x) => x.operation === operation).length === 1) throw new Error("temporary");
    return {};
  } });
  const run = (action) => command.execute({ sessionID: "sleep-session", prompt: { text: `/mnemosyne sleep${action ? ` ${action}` : ""}` } });
  return { ...base, command, generated, backend, run };
}

test("sleep requires explicit consent, discloses preview, approves output before commit and retries without generation", async (t) => {
  const h = sleepHarness(t);
  await h.run("");
  assert.equal(h.generated.length, 0);
  assert.match(h.replies.at(-1), /openai\/gpt-test/);
  assert.match(h.replies.at(-1), /bank: opencode_/);
  assert.match(h.replies.at(-1), /source-a/);
  const previewedPrompt = h.replies.at(-1).split("Exact provider prompt:\n")[1].split("\n\nRun /mnemosyne sleep consent")[0];
  assert.equal(h.backend.filter((x) => x.operation === "sleep_commit").length, 0);
  await h.run("consent");
  assert.deepEqual(h.generated[0].model, { providerID: "openai", id: "gpt-test" });
  assert.equal(h.generated[0].prompt, previewedPrompt);
  assert.match(h.replies.at(-1), /approved summary/);
  assert.equal(h.backend.filter((x) => x.operation === "sleep_commit").length, 0);
  await h.run("approve");
  assert.equal(h.backend.at(-1).bank, getProject(h.ctx).bank);
  assert.equal(h.backend.at(-1).payload.summary, "approved summary");
  assert.deepEqual(h.backend.at(-1).payload.source_ids, ["source-a"]);
  assert.match(h.replies.at(-1), /output retained/);
  await h.run("approve");
  assert.equal(h.generated.length, 1);
  assert.equal(h.backend.filter((x) => x.operation === "sleep_commit").length, 2);
  assert.match(h.replies.at(-1), /stored/);
});

test("sleep V1 unsupported, missing model, rejection and cancellation do not generate or write", async (t) => {
  const v1 = sleepHarness(t, { v2: false });
  await v1.run("");
  assert.match(v1.replies.at(-1), /unsupported/);
  const missing = sleepHarness(t, { model: null });
  await missing.run("");
  assert.match(missing.replies.at(-1), /no usable V2/);
  const rejected = sleepHarness(t);
  await rejected.run("");
  await rejected.run("consent");
  await rejected.run("reject");
  assert.equal(rejected.backend.filter((x) => x.operation === "sleep_commit").length, 0);
  const cancelled = sleepHarness(t);
  await cancelled.run("");
  await cancelled.run("cancel");
  assert.equal(cancelled.generated.length, 0);
  assert.equal(cancelled.backend.filter((x) => x.operation === "sleep_commit").length, 0);
});

test("sleep cancellation during an in-flight commit does not claim nothing was stored", async (t) => {
  const base = fixture();
  t.after(() => cleanup(base.root));
  let resolveCommit;
  const commit = new Promise((resolve) => { resolveCommit = resolve; });
  const backend = [];
  base.ctx.session.get = async () => ({ model: { providerID: "openai", id: "gpt-test" } });
  base.ctx.generate = { text: async () => ({ text: "approved summary" }) };
  const command = createMnemosyneCommand(base.ctx, { backendCall: async (_ctx, project, operation, payload) => {
    backend.push({ operation, payload, bank: project.bank });
    if (operation === "sleep_preview") return [{ id: "source-a", content: "candidate" }];
    if (operation === "sleep_commit") return commit;
  } });
  const run = (action) => command.execute({ sessionID: "sleep-session", prompt: { text: `/mnemosyne sleep${action ? ` ${action}` : ""}` } });
  await run("");
  await run("consent");
  const approving = run("approve");
  while (!backend.some((item) => item.operation === "sleep_commit")) await new Promise((resolve) => setImmediate(resolve));
  await run("reject");
  assert.doesNotMatch(base.replies.at(-1), /no memory was written|cancelled/i);
  assert.match(base.replies.at(-1), /in progress/i);
  resolveCommit({});
  await approving;
  assert.match(base.replies.at(-1), /stored/);
  assert.equal(backend.filter((item) => item.operation === "sleep_commit").length, 1);
});

test("sleep rejects stale configuration and locks a bank while another sleep is pending", async (t) => {
  const h = sleepHarness(t);
  await h.run("");
  await h.run("");
  assert.match(h.replies.at(-1), /already pending/);
  const project = getProject(h.ctx);
  const fs = await import("node:fs/promises");
  await fs.writeFile(join(project.directory, "opencode.jsonc"), JSON.stringify({ mnemosyne: { sleep: { model: "other/model" } } }));
  await h.run("consent");
  assert.match(h.replies.at(-1), /configuration changed/);
  assert.equal(h.generated.length, 0);
  assert.equal(h.backend.filter((x) => x.operation === "sleep_commit").length, 0);
});

test("sleep flush failure aborts before provider call and releases the bank lock", async (t) => {
  let fail = true;
  const order = [];
  const h = sleepHarness(t, { flushPendingTurns: async () => { order.push("flush"); if (fail) throw new Error("flush failed"); } });
  const generate = h.ctx.generate.text;
  h.ctx.generate.text = async (...args) => { order.push("generate"); return generate(...args); };
  await h.run("");
  assert.deepEqual(order, []);
  await h.run("consent");
  assert.deepEqual(order, ["flush"]);
  assert.match(h.replies.at(-1), /generation failed: flush failed/);
  assert.equal(h.generated.length, 0);
  assert.equal(h.backend.filter((x) => x.operation === "sleep_commit").length, 0);
  fail = false;
  await h.run("");
  assert.match(h.replies.at(-1), /Run \/mnemosyne sleep consent/);
});

test("sleep routes preview and commit to the effective write bank", async (t) => {
  const h = sleepHarness(t);
  const fs = await import("node:fs/promises");
  await fs.writeFile(join(getProject(h.ctx).directory, "opencode.jsonc"), JSON.stringify({ mnemosyne: { writeMode: "global", globalBank: true } }));
  await h.run("");
  assert.equal(h.backend.at(-1).bank, "opencode_global");
  assert.match(h.replies.at(-1), /bank: opencode_global/);
  await h.run("consent");
  await h.run("approve");
  assert.equal(h.backend.at(-1).operation, "sleep_commit");
  assert.equal(h.backend.at(-1).bank, "opencode_global");
});

test("sleep uses the configured provider/model override instead of the session model", async (t) => {
  const h = sleepHarness(t, { model: { providerID: "session-provider", id: "session-model" } });
  const project = getProject(h.ctx);
  const fs = await import("node:fs/promises");
  await fs.writeFile(join(project.directory, "opencode.jsonc"), JSON.stringify({ mnemosyne: { sleep: { model: "configured-provider/configured-model" } } }));
  await h.run("");
  assert.match(h.replies.at(-1), /configured-provider\/configured-model/);
  await h.run("consent");
  assert.deepEqual(h.generated[0].model, { providerID: "configured-provider", id: "configured-model" });
});
