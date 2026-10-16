import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKENDS, createMnemosyneCommand, formatStats, getProject } from "../index.js";

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

  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne embedded", delivery: "queue" } });
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
