import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKENDS, createMnemosyneCommand, getProject } from "../index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "memory-command-"));
  process.env.MNEMOSYNE_STATE_FILE = join(root, "projects.json");
  process.env.MNEMOSYNE_DATA_DIR = join(root, "data");
  // The TUI renders `description`, not `text` (see routes/session/rows.ts:
  // synthetic messages without a description are skipped entirely). Assert on
  // the field the user actually sees, and record `resume` so a model-free
  // command stays model-free.
  const replies = [];
  const calls = [];
  const ctx = {
    location: { directory: "/tmp/example-project", project: { canonical: "/tmp/example-project" } },
    session: {
      synthetic: async ({ text, description, resume }) => {
        replies.push(description);
        calls.push({ text, description, resume });
        return { text, description };
      },
    },
  };
  return { ctx, command: createMnemosyneCommand(ctx), replies, calls, root };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
  delete process.env.MNEMOSYNE_STATE_FILE;
  delete process.env.MNEMOSYNE_DATA_DIR;
  delete process.env.MNEMOSYNE_BIN;
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
