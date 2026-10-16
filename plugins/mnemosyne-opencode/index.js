import { Plugin } from "@opencode/plugin";
import { applyEdits, modify, parse } from "jsonc-parser";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// English names match the CLI subcommands the worker exposes.
export const BACKENDS = Object.freeze({
  file: "mnemosyne-file",
  embedded: "mnemosyne-embedded",
});

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(PLUGIN_DIR, "memory_worker.py");
const MNEMOSYNE_PACKAGE = "mnemosyne-memory==3.15.1";
const IDLE_EVENTS = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

// This plugin runs inside OpenCode, so all of its state lives under OpenCode's
// own data directory instead of separate ~/.config and ~/.local/share roots.
const STORAGE_ROOT = join(homedir(), ".local", "share", "opencode", "storage", "plugin", "mnemosyne-opencode");

function statePath() {
  return process.env.MNEMOSYNE_STATE_FILE || join(STORAGE_ROOT, "projects.json");
}

// Configuration lives in the `mnemosyne` block of opencode.jsonc, never in
// projects.json. Projects have no runtime dependencies, so the plugin does not
// assume a project is a git checkout; a plain directory without a config file is
// perfectly valid.
const CONFIG_KEYS = Object.freeze(["enabled", "backend", "recallLimit", "globalBank", "dataDir"]);
const DEFAULT_RECALL_LIMIT = 4;
const KNOWN_BACKENDS = new Set(Object.values(BACKENDS));

function globalConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "opencode", "opencode.jsonc");
}

function projectConfigPath(directory) {
  return join(directory, "opencode.jsonc");
}

function readJsoncFile(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  const errors = [];
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    throw new Error(`Cannot parse ${path}: ${errors[0].error} at offset ${errors[0].offset}`);
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

function readConfigBlock(path) {
  const block = readJsoncFile(path).mnemosyne;
  return block && typeof block === "object" ? block : {};
}

// Merge order: defaults < global config < project config < legacy state.
// The legacy layer is only consulted for keys the config does not mention, so an
// existing installation keeps working without a migration step.
function resolveConfig(directory) {
  const global = readConfigBlock(globalConfigPath());
  const project = readConfigBlock(projectConfigPath(directory));
  return { ...global, ...project };
}

function pickConfig(config, legacy, key, fallback) {
  if (config[key] !== undefined) return config[key];
  if (legacy[key] !== undefined) return legacy[key];
  return fallback;
}

function validateConfigValue(key, value) {
  if (key === "backend" && !KNOWN_BACKENDS.has(value)) {
    throw new Error(`Unknown backend: ${value}. Expected one of ${[...KNOWN_BACKENDS].join(", ")}.`);
  }
  if (key === "recallLimit") {
    if (!Number.isInteger(value) || value < 1 || value > 20) {
      throw new Error(`recallLimit must be an integer between 1 and 20, got ${JSON.stringify(value)}.`);
    }
  }
  if (key === "enabled" || key === "globalBank") {
    if (typeof value !== "boolean") throw new Error(`${key} must be true or false.`);
  }
}

// Surgical write: only the `mnemosyne` block is touched, and comments plus
// formatting elsewhere in the file are preserved byte for byte.
// Exported so the write guard can be tested directly.
export function writeProjectConfig(directory, changes) {
  const path = projectConfigPath(directory);
  const original = existsSync(path) ? readFileSync(path, "utf8") : "{\n}\n";
  let text = original;
  for (const [key, value] of Object.entries(changes)) {
    validateConfigValue(key, value);
    text = applyEdits(text, modify(text, ["mnemosyne", key], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

function defaultDataDir() {
  return process.env.MNEMOSYNE_DATA_DIR || join(STORAGE_ROOT, "data");
}

function loadState() {
  const path = statePath();
  if (!existsSync(path)) return { version: 1, projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { version: 1, projects: parsed.projects || {} };
  } catch (error) {
    throw new Error(`Cannot parse Mnemosyne project state ${path}: ${error.message}`);
  }
}

function saveState(state) {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function projectIdentity(ctx) {
  const directory =
    ctx.location?.project?.canonical || ctx.location?.project?.directory || ctx.location?.directory || process.cwd();
  const hash = createHash("sha256").update(directory).digest("hex").slice(0, 16);
  return { id: hash, directory, name: basename(directory), bank: `opencode_${hash}` };
}

export function getProject(ctx) {
  const identity = projectIdentity(ctx);
  const saved = loadState().projects[identity.id] || {};
  const config = resolveConfig(identity.directory);
  return {
    ...identity,
    enabled: pickConfig(config, saved, "enabled", false) === true,
    backend: pickConfig(config, saved, "backend", BACKENDS.file),
    recallLimit: pickConfig(config, saved, "recallLimit", DEFAULT_RECALL_LIMIT),
    globalBank: pickConfig(config, saved, "globalBank", true) !== false,
    dataDir: pickConfig(config, saved, "dataDir", defaultDataDir()),
    lastError: saved.lastError || "",
    // Which layers actually spoke. Reported by /mnemosyne status so the user can
    // see whether the config file or the legacy state file is in charge.
    configSources: {
      global: existsSync(globalConfigPath()),
      project: existsSync(projectConfigPath(identity.directory)),
      legacy: Object.keys(saved).length > 0,
    },
  };
}

// Runtime state only. Configuration changes never pass through here.
function updateState(ctx, changes) {
  const identity = projectIdentity(ctx);
  const state = loadState();
  const previous = state.projects[identity.id] || {};
  state.projects[identity.id] = {
    ...previous,
    ...changes,
    directory: identity.directory,
    name: identity.name,
    bank: identity.bank,
    updatedAt: new Date().toISOString(),
  };
  saveState(state);
  return getProject(ctx);
}

// Configuration only. Writes the project's opencode.jsonc, never projects.json.
function updateConfig(ctx, changes) {
  const identity = projectIdentity(ctx);
  writeProjectConfig(identity.directory, changes);
  return getProject(ctx);
}

function describeConfigSources(project) {
  const { global, project: local, legacy } = project.configSources;
  const active = [];
  if (local) active.push("project opencode.jsonc");
  if (global) active.push("global opencode.jsonc");
  if (!active.length) active.push(legacy ? "projects.json (legacy)" : "defaults");
  return active.join(" < ");
}

export function configPathFor(ctx) {
  return projectConfigPath(projectIdentity(ctx).directory);
}

export function stripInjectedMemory(text) {
  return text.replace(/<mnemosyne_memory>[\s\S]*?<\/mnemosyne_memory>/g, "").trim();
}

export function renderMessages(messages) {
  const turns = [];
  for (const message of messages || []) {
    if (message?.type !== "user" && message?.type !== "assistant") continue;
    const texts = [];
    if (typeof message.text === "string") texts.push(message.text);
    for (const part of message.content || []) {
      if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
    }
    const content = stripInjectedMemory(texts.join("\n"));
    if (content) turns.push({ role: message.type, content });
  }
  return turns;
}

function startWorker(project) {
  const env = {
    ...process.env,
    MNEMOSYNE_HOME: project.dataDir,
    MNEMOSYNE_DATA_DIR: project.dataDir,
    MNEMOSYNE_MCP_BANK: project.bank,
    MNEMOSYNE_DEFAULT_SCOPE: "global",
    MNEMOSYNE_EMBEDDING_API_URL: process.env.MNEMOSYNE_EMBEDDING_API_URL || "http://localhost:11434/v1",
    MNEMOSYNE_EMBEDDING_MODEL: process.env.MNEMOSYNE_EMBEDDING_MODEL || "nomic-embed-text",
    MNEMOSYNE_EMBEDDING_DIM: process.env.MNEMOSYNE_EMBEDDING_DIM || "768",
    MNEMOSYNE_LLM_ENABLED: "false",
    MNEMOSYNE_JOURNAL_MODE: "wal",
  };
  if (project.backend === BACKENDS.file) env.MNEMOSYNE_NO_EMBEDDINGS = "1";
  else delete env.MNEMOSYNE_NO_EMBEDDINGS;
  for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "MNEMOSYNE_EMBEDDING_API_KEY"]) delete env[key];
  mkdirSync(project.dataDir, { recursive: true });

  const child = spawn("uvx", ["--from", MNEMOSYNE_PACKAGE, "--with", "numpy", "python", WORKER_PATH], {
    cwd: PLUGIN_DIR,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const worker = { child, pending: new Map(), buffer: "", sequence: 0, backend: project.backend, bank: project.bank };

  child.stdout.on("data", (chunk) => {
    worker.buffer += chunk.toString("utf8");
    while (worker.buffer.includes("\n")) {
      const index = worker.buffer.indexOf("\n");
      const line = worker.buffer.slice(0, index);
      worker.buffer = worker.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        console.error(`Mnemosyne worker returned non-JSON output: ${line.slice(0, 300)}`);
        continue;
      }
      const pending = worker.pending.get(response.id);
      if (!pending) continue;
      worker.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.result ?? response);
      else pending.reject(new Error(response.error || "Mnemosyne worker failed"));
    }
  });
  child.stderr.on("data", (chunk) => console.error(`Mnemosyne worker: ${String(chunk).trim()}`));
  child.on("error", (error) => {
    for (const pending of worker.pending.values()) pending.reject(error);
    worker.pending.clear();
    if (currentWorker === worker) currentWorker = undefined;
  });
  child.on("exit", (code, signal) => {
    const error = new Error(`Mnemosyne worker exited (${code ?? signal ?? "unknown"})`);
    for (const pending of worker.pending.values()) pending.reject(error);
    worker.pending.clear();
    if (currentWorker === worker) currentWorker = undefined;
  });
  currentWorker = worker;
  return worker;
}

let currentWorker;

function workerCall(project, operation, payload) {
  let worker = currentWorker;
  if (!worker || worker.backend !== project.backend || worker.bank !== project.bank) {
    if (worker) {
      worker.child.kill("SIGTERM");
      for (const pending of worker.pending.values()) pending.reject(new Error("Backend changed"));
      worker.pending.clear();
    }
    worker = startWorker(project);
  }
  const id = String(++worker.sequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.pending.delete(id);
      reject(new Error(`Mnemosyne worker timeout after 60s: ${operation}`));
    }, 60_000);
    worker.pending.set(id, { resolve, reject, timer });
    worker.child.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`);
  });
}

async function backendCall(ctx, project, operation, payload = {}) {
  try {
    if (project.backend !== BACKENDS.file && project.backend !== BACKENDS.embedded) {
      throw new Error(`Unknown backend: ${project.backend}`);
    }

    if (operation === "import_hindsight") {
      // Mnemosyne's CLI-only import path. Run once instead of using the worker.
      return await runCli(project, ["import-hindsight", payload.source], payload.bank);
    }
    if (operation === "backup") {
      return await runCli(project, ["backup"].concat(payload.outputDir ? [payload.outputDir] : []));
    }
    if (operation === "verify") {
      const args = ["verify"];
      if (payload.quick !== false) args.push("--quick");
      return await runCli(project, args);
    }

    return workerCall(project, operation, payload);
  } catch (error) {
    updateState(ctx, { lastError: error.message });
    throw error;
  }
}

function runCli(project, args) {
  const env = {
    ...process.env,
    MNEMOSYNE_HOME: project.dataDir,
    MNEMOSYNE_DATA_DIR: project.dataDir,
    MNEMOSYNE_MCP_BANK: project.bank,
    MNEMOSYNE_DEFAULT_SCOPE: "global",
  };
  if (project.backend === BACKENDS.file) env.MNEMOSYNE_NO_EMBEDDINGS = "1";
  else delete env.MNEMOSYNE_NO_EMBEDDINGS;
  if (process.env.MNEMOSYNE_BIN) {
    env.MNEMOSYNE_BIN = process.env.MNEMOSYNE_BIN;
  }

  const explicit = process.env.MNEMOSYNE_BIN;
  const command = explicit || "uvx";
  const finalArgs = explicit
    ? args
    : ["--from", "mnemosyne-memory==3.15.1", "--with", "numpy", "mnemosyne", ...args];

  return new Promise((resolve, reject) => {
    const child = spawn(command, finalArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error((stderr || stdout || `mnemosyne exited ${code}`).trim()));
    });
    child.on("error", reject);
  });
}

function memoryBlock(results) {
  if (!results.length) return "";
  const lines = results.map((result, index) => `${index + 1}. ${result.content}`);
  return [
    "<mnemosyne_memory>",
    "Relevant memories from earlier work in this project. Treat them as historical evidence, not current truth; verify them against the repository and current user instructions before acting on them:",
    ...lines,
    "</mnemosyne_memory>",
  ].join("\n");
}

function notify(ctx, sessionID, display, modelNote) {
  // The TUI only renders `description` (rows.ts skips synthetic messages without
  // one, and SessionNoticeMessageV2 prints description, not text). So the
  // user-visible output must live in `description`; `text` is the model-facing
  // note and stays short. `resume: false` keeps the command model-free.
  return ctx.session.synthetic({
    sessionID,
    description: display,
    text: modelNote,
    resume: false,
  });
}

export function createMnemosyneCommand(ctx) {
  return {
    name: "mnemosyne",
    description: "Toggle and configure automatic project memory",
    async execute(input) {
      const sessionID = input.sessionID;
      const raw = (input.prompt?.text || "").trim();
      const args = raw.replace(/^\/mnemosyne(?:\s+|$)/i, "").trim();
      const [action, ...rest] = args.split(/\s+/).filter(Boolean);
      const command = (action || "").toLowerCase();

      if (!command || command === "help") {
        return notify(
          ctx,
          sessionID,
          [
            "/mnemosyne — show this help",
            "/mnemosyne on|off — enable or disable automatic memory for this project",
            "/mnemosyne status — backend, enabled state, bank, storage, last error",
            "/mnemosyne stats — backend counters",
            "/mnemosyne file — Mnemosyne without embeddings",
            "/mnemosyne embedded — Mnemosyne with Ollama embeddings",
            "/mnemosyne backup [dir] — write a compressed database backup",
            "/mnemosyne verify — check database integrity",
            "/mnemosyne import hindsight <source> — import Hindsight memories from a file or URL",
          ].join("\n"),
          "The user asked for mnemosyne help. The command list was printed in chat; no action needed.",
        );
      }

      if (command === "status") {
        const project = getProject(ctx);
        const error = project.lastError ? `\nlast_error: ${project.lastError}` : "";
        return notify(
          ctx,
          sessionID,
          [
            `enabled: ${project.enabled}`,
            `backend: ${project.backend}`,
            `recallLimit: ${project.recallLimit}`,
            `globalBank: ${project.globalBank}`,
            `bank: ${project.bank}`,
            `project: ${project.directory}`,
            `data: ${project.dataDir}`,
            `config: ${describeConfigSources(project)}`,
          ].join("\n") + error,
          `Project memory status printed in chat: enabled=${project.enabled}, backend=${project.backend}.`,
        );
      }

      if (command === "stats") {
        const project = getProject(ctx);
        const stats = await backendCall(ctx, project, "stats");
        return notify(ctx, sessionID, JSON.stringify(stats, null, 2).slice(0, 6000), "Backend memory statistics printed in chat.");
      }

      if (command === "backup") {
        const project = getProject(ctx);
        const outputDir = rest[0];
        const result = await backendCall(ctx, project, "backup", { outputDir });
        const reported = (result || `Backup completed`).toString().trim().split("\n").slice(0, 6).join("\n");
        return notify(ctx, sessionID, reported, "Database backup completed; see backup path or directory above.");
      }

      if (command === "verify") {
        const project = getProject(ctx);
        const result = await backendCall(ctx, project, "verify", {
          quick: !rest.includes("--full"),
        });
        return notify(ctx, sessionID, String(result ?? "ok"), "Database integrity check completed.");
      }

      if (command === "import" && rest[0] === "hindsight") {
        const source = rest.slice(1).join(" ").trim();
        if (!source) {
          return notify(ctx, sessionID, "Usage: /mnemosyne import hindsight <file-or-url>", "Missing import source.");
        }
        const project = getProject(ctx);
        const result = await backendCall(ctx, project, "import_hindsight", { source });
        return notify(ctx, sessionID, String(result ?? "Import completed."), "Hindsight import completed.");
      }

      if (command === "on" || command === "off") {
        const project = updateConfig(ctx, { enabled: command === "on" });
        return notify(
          ctx,
          sessionID,
          `Mnemosyne ${project.enabled ? "enabled" : "disabled"} for ${project.name}\nwrote: ${configPathFor(ctx)}`,
          `Project memory is now ${project.enabled ? "enabled" : "disabled"} for this project. The setting was written to the project config file.`,
        );
      }

      // Determine backend from command: supports `/mnemosyne file`, `/mnemosyne embedded`,
      // and legacy `/mnemosyne mnemosyne file` / `/mnemosyne mnemosyne embedded`.
      let backendAction = command;
      if (command === "file" || command === "embedded") {
        backendAction = `mnemosyne-${command}`;
      } else if (command === "mnemosyne" && rest[0] && (rest[0] === "file" || rest[0] === "embedded")) {
        backendAction = `mnemosyne-${rest[0]}`;
      }
      const backendNames = Object.values(BACKENDS);
      if (backendNames.includes(backendAction)) {
        const project = updateConfig(ctx, { backend: backendAction, enabled: true });
        return notify(
          ctx,
          sessionID,
          `Mnemosyne enabled for ${project.name} with backend ${project.backend}`,
          `Project memory backend switched to ${project.backend} and enabled for this project.`,
        );
      }

      if (command === "backend" && backendNames.includes(rest[0])) {
        const project = updateConfig(ctx, { backend: rest[0] });
        return notify(
          ctx,
          sessionID,
          `Backend for ${project.name}: ${project.backend}`,
          `Project memory backend is ${project.backend}.`,
        );
      }

      return notify(ctx, sessionID, `Unknown memory action: ${command}. Try /mnemosyne help.`, "The user used an unknown /memory action.");
    },
  };
}

export default Plugin.define({
  id: "mnemosyne-opencode",
  async setup(ctx) {
    const registrations = [];
    const ownSessions = new Set();
    const recallBySession = new Map();
    const turnCounts = new Map();
    const events = new AbortController();

    registrations.push(await ctx.command.transform((editor) => {
      editor.add(createMnemosyneCommand(ctx));
    }));

    registrations.push(await ctx.session.hook("prompt", async (event) => {
      ownSessions.add(event.sessionID);
      const project = getProject(ctx);
      if (!project.enabled) {
        recallBySession.delete(event.sessionID);
        return;
      }
      const query = event.prompt?.text?.trim();
      if (!query) return;
      try {
        const results = await backendCall(ctx, project, "recall", { query, limit: project.recallLimit });
        recallBySession.set(event.sessionID, results);
        updateState(ctx, { lastError: "" });
      } catch (error) {
        recallBySession.delete(event.sessionID);
        console.error(`Mnemosyne recall failed: ${error.message}`);
      }
    }));

    registrations.push(await ctx.session.hook("context", (event) => {
      const results = recallBySession.get(event.sessionID) || [];
      if (!results.length) return;
      const block = memoryBlock(results);
      if (block) event.system.push({ type: "text", text: block });
    }));

    const flush = async (sessionID) => {
      const project = getProject(ctx);
      if (!project.enabled) return;
      const messages = await ctx.session.context({ sessionID });
      const turns = renderMessages(messages);
      const previous = turnCounts.get(sessionID) || 0;
      if (turns.length < previous) return;
      for (const turn of turns.slice(previous)) {
        await backendCall(ctx, project, "remember", {
          content: turn.content,
          metadata: { role: turn.role, session_id: sessionID, project: project.id },
        });
      }
      turnCounts.set(sessionID, turns.length);
      updateState(ctx, { lastError: "" });
    };

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) {
        const sessionID = event.data?.sessionID;
        if (!sessionID || !IDLE_EVENTS.has(event.type) || !ownSessions.has(sessionID)) continue;
        try {
          await flush(sessionID);
        } catch (error) {
          console.error(`Mnemosyne write-back failed for ${sessionID}: ${error.message}`);
        }
      }
    })().catch((error) => console.error(`Mnemosyne event stream failed: ${error.message}`));

    return async () => {
      events.abort();
      if (currentWorker) currentWorker.child.kill("SIGTERM");
      const disposers = registrations.map((registration) => registration.dispose?.());
      await Promise.all(disposers);
    }
  },
});
