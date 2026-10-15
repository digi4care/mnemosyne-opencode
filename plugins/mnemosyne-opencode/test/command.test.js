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
}

test("bare /memory shows how-to without changing project state", async (t) => {
  const { ctx, command, replies, calls, root } = fixture();
  t.after(() => cleanup(root));
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne", delivery: "queue" } });
  const project = getProject(ctx);
  assert.equal(project.enabled, false);
  assert.match(replies[0], /\/mnemosyne on\|off/);
  assert.match(replies[0], /\/mnemosyne mnemosyne file/);
  assert.match(replies[0], /\/mnemosyne mnemosyne embedded/);
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

  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne mnemosyne embedded", delivery: "queue" } });
  assert.equal(getProject(ctx).backend, BACKENDS.embedded);
  assert.equal(getProject(ctx).enabled, true);

  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne mnemosyne file", delivery: "queue" } });
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
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne mnemosyne file", delivery: "queue" } });
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne status", delivery: "queue" } });
  const status = replies.at(-1);
  assert.match(status, /enabled: true/);
  assert.match(status, /backend: mnemosyne-file/);
  assert.match(status, /bank: opencode_[0-9a-f]{16}/);
  assert.equal(calls.at(-1).resume, false);
});
