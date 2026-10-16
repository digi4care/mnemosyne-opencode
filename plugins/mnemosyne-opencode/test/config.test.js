import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMnemosyneCommand, getProject, writeProjectConfig } from "../index.js";

// Phase 1 gate: configuration lives in opencode.jsonc, projects.json keeps
// runtime state only. These tests cover the resolution order and, most
// importantly, that writing configuration never destroys the user's file.

function fixture(withGlobalConfig) {
  const root = mkdtempSync(join(tmpdir(), "memory-config-"));
  process.env.MNEMOSYNE_STATE_FILE = join(root, "projects.json");
  process.env.MNEMOSYNE_DATA_DIR = join(root, "data");
  const configHome = join(root, "config");
  process.env.XDG_CONFIG_HOME = configHome;
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(configHome, "opencode"), { recursive: true });

  if (withGlobalConfig !== undefined) {
    writeFileSync(
      join(configHome, "opencode", "opencode.jsonc"),
      `{\n  // global preferences\n  "mnemosyne": ${JSON.stringify(withGlobalConfig)}\n}\n`,
    );
  }

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
  return { ctx, command: createMnemosyneCommand(ctx), replies, calls, root, projectDir, configHome };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
  delete process.env.MNEMOSYNE_STATE_FILE;
  delete process.env.MNEMOSYNE_DATA_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.MNEMOSYNE_BIN;
}

test("on/off writes the project config file, not the state file", async (t) => {
  const { ctx, command, root, projectDir, replies } = fixture();
  t.after(() => cleanup(root));

  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne on", delivery: "queue" } });
  assert.equal(getProject(ctx).enabled, true);

  const config = JSON.parse(readFileSync(join(projectDir, "opencode.jsonc"), "utf8"));
  assert.equal(config.mnemosyne.enabled, true);

  // The state file must not gain a configuration key.
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne off", delivery: "queue" } });
  assert.equal(getProject(ctx).enabled, false);
  assert.match(replies.at(-1), /wrote: /);

  // Correct behaviour: with no runtime state there is no state file at all.
  const statePath = join(root, "projects.json");
  if (existsSync(statePath)) assert.doesNotMatch(readFileSync(statePath, "utf8"), /"enabled"/);
});

test("writeMode defaults to project, validates values, and persists mode commands", async (t) => {
  const { ctx, root, projectDir, replies } = fixture();
  t.after(() => cleanup(root));
  const { createMnemosyneCommand } = await import("../index.js");
  const command = createMnemosyneCommand(ctx, { transitionMode: async (persist) => persist() });
  assert.equal(getProject(ctx).writeMode, "project");
  assert.throws(() => writeProjectConfig(projectDir, { writeMode: "other" }), /writeMode/);
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne global on" } });
  assert.equal(getProject(ctx).writeMode, "global");
  assert.equal(JSON.parse(readFileSync(join(projectDir, "opencode.jsonc"), "utf8")).mnemosyne.writeMode, "global");
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne global off" } });
  assert.equal(getProject(ctx).writeMode, "project");
  assert.match(replies.at(-1), /project/);
});

test("mode switch awaits flush and aborts persistence when flush rejects", async (t) => {
  const { ctx, root, projectDir } = fixture();
  t.after(() => cleanup(root));
  const { createMnemosyneCommand } = await import("../index.js");
  let flushed = false;
  const command = createMnemosyneCommand(ctx, { transitionMode: async (persist) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushed = true;
    return persist();
  } });
  await command.execute({ sessionID: "ses", prompt: { text: "/mnemosyne global on" } });
  assert.equal(flushed, true);
  assert.equal(getProject(ctx).writeMode, "global");
  const failing = createMnemosyneCommand(ctx, { transitionMode: async () => { throw new Error("flush failed"); } });
  await assert.rejects(failing.execute({ sessionID: "ses", prompt: { text: "/mnemosyne global off" } }), /flush failed/);
  assert.equal(getProject(ctx).writeMode, "global");
  assert.equal(JSON.parse(readFileSync(join(projectDir, "opencode.jsonc"), "utf8")).mnemosyne.writeMode, "global");
});

test("global on refuses while globalBank is disabled without changing write mode", async (t) => {
  const { ctx, command, root, projectDir, replies } = fixture({ globalBank: false, writeMode: "project" });
  t.after(() => cleanup(root));
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne global on" } });
  assert.equal(getProject(ctx).writeMode, "project");
  assert.match(replies.at(-1), /disabled/);
});

test("disabled global bank makes configured global write mode effectively project-only", async (t) => {
  const { ctx, root } = fixture({ globalBank: false, writeMode: "global" });
  t.after(() => cleanup(root));
  assert.equal(getProject(ctx).writeMode, "global");
  assert.equal(getProject(ctx).effectiveWriteMode, "project");
});

test("writing config preserves comments and unrelated keys byte for byte", async (t) => {
  const { ctx, root, projectDir } = fixture();
  t.after(() => cleanup(root));
  const { createMnemosyneCommand } = await import("../index.js");
  const command = createMnemosyneCommand(ctx, { transitionMode: async (persist) => persist() });

  const original = [
    "{",
    "  // my project settings",
    '  "$schema": "https://opencode.ai/config.json",',
    '  "theme": "dark",   // trailing comment with odd spacing',
    "}",
    "",
  ].join("\n");
  writeFileSync(join(projectDir, "opencode.jsonc"), original);

  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne on", delivery: "queue" } });

  const after = readFileSync(join(projectDir, "opencode.jsonc"), "utf8");
  assert.match(after, /\/\/ my project settings/);
  assert.match(after, /\/\/ trailing comment with odd spacing/);
  assert.match(after, /"theme": "dark"/);
  assert.match(after, /"enabled": true/);
});

test("a config file with trailing commas parses instead of throwing", async (t) => {
  const { ctx, command, root, projectDir } = fixture();
  t.after(() => cleanup(root));

  writeFileSync(
    join(projectDir, "opencode.jsonc"),
    '{\n  "mnemosyne": {\n    "recallLimit": 7,\n  },\n}\n',
  );
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne status", delivery: "queue" } });
  assert.equal(getProject(ctx).recallLimit, 7);
});

test("project config overrides global config", async (t) => {
  const { ctx, command, root, projectDir, replies } = fixture({ backend: "mnemosyne-embedded", recallLimit: 9 });
  t.after(() => cleanup(root));

  assert.equal(getProject(ctx).backend, "mnemosyne-embedded");
  assert.equal(getProject(ctx).recallLimit, 9);

  writeFileSync(join(projectDir, "opencode.jsonc"), '{ "mnemosyne": { "recallLimit": 2 } }\n');
  assert.equal(getProject(ctx).recallLimit, 2);
  assert.equal(getProject(ctx).backend, "mnemosyne-embedded");

  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne status", delivery: "queue" } });
  assert.match(replies.at(-1), /config: project opencode\.jsonc < global opencode\.jsonc/);
});

test("legacy projects.json values still apply when the config is silent", async (t) => {
  const { ctx, command, root } = fixture();
  t.after(() => cleanup(root));

  writeFileSync(
    process.env.MNEMOSYNE_STATE_FILE,
    JSON.stringify({
      version: 1,
      projects: {
        [getProject(ctx).id]: { enabled: true, backend: "mnemosyne-embedded", updatedAt: "2026-01-01T00:00:00.000Z" },
      },
    }),
  );

  assert.equal(getProject(ctx).enabled, true);
  assert.equal(getProject(ctx).backend, "mnemosyne-embedded");

  // And an explicit config value overrides the legacy value.
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne off", delivery: "queue" } });
  assert.equal(getProject(ctx).enabled, false);
  assert.equal(getProject(ctx).backend, "mnemosyne-embedded");
});

test("an invalid backend cannot be written, and an existing bad value is reported not swallowed", async (t) => {
  const { ctx, command, root, projectDir, replies } = fixture();
  t.after(() => cleanup(root));

  // The write guard refuses it. `/mnemosyne hindsight` itself is an unknown action,
  // which command.test.js already covers; this asserts the guard behind it.
  assert.throws(() => writeProjectConfig(projectDir, { backend: "hindsight" }), /Unknown backend/);
  assert.throws(() => writeProjectConfig(projectDir, { recallLimit: 99 }), /recallLimit/);
  assert.throws(() => writeProjectConfig(projectDir, { enabled: "yes" }), /must be true or false/);

  // A bad value that arrives by another route (hand-edited config) is surfaced in
  // status rather than silently falling back to the default backend.
  writeFileSync(join(projectDir, "opencode.jsonc"), '{ "mnemosyne": { "backend": "hindsight" } }\n');
  const project = getProject(ctx);
  assert.equal(project.backend, "hindsight");
  await command.execute({ sessionID: "ses-a", prompt: { text: "/mnemosyne status", delivery: "queue" } });
  assert.match(replies.at(-1), /backend: hindsight/);
});

test("an unparseable config file fails loudly instead of falling back silently", async (t) => {
  const { ctx, root, projectDir } = fixture();
  t.after(() => cleanup(root));

  writeFileSync(join(projectDir, "opencode.jsonc"), '{ "mnemosyne": { "enabled": true,, } }\n');
  assert.throws(() => getProject(ctx), /Cannot parse/);
});

test("writes reject duplicate mnemosyne blocks and duplicate updated keys without changing the file", async (t) => {
  const { root, projectDir } = fixture();
  t.after(() => cleanup(root));
  for (const input of [
    '{ "mnemosyne": { "enabled": false }, "mnemosyne": { "enabled": true } }',
    '{ "mnemosyne": { "enabled": false, "enabled": true } }',
  ]) {
    const path = join(projectDir, "opencode.jsonc");
    writeFileSync(path, input);
    assert.throws(() => writeProjectConfig(projectDir, { enabled: true }), /duplicate mnemosyne/);
    assert.equal(readFileSync(path, "utf8"), input);
  }
});

test("writes reject malformed JSONC without changing the file", async (t) => {
  const { root, projectDir } = fixture();
  t.after(() => cleanup(root));
  const input = '{ "mnemosyne": { "enabled": false,, } }';
  const path = join(projectDir, "opencode.jsonc");
  writeFileSync(path, input);
  assert.throws(() => writeProjectConfig(projectDir, { enabled: true }), /Cannot parse/);
  assert.equal(readFileSync(path, "utf8"), input);
});
