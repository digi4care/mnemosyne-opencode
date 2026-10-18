import { Plugin } from "@opencode/plugin";
import { applyEdits, modify, parse, parseTree } from "jsonc-parser";
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
const CONFIG_KEYS = Object.freeze(["enabled", "backend", "recallLimit", "globalBank", "dataDir", "writeMode"]);
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
  if (key === "writeMode" && value !== "project" && value !== "global") throw new Error('writeMode must be "project" or "global".');
  if (key === "sleepModel" && !(value === "inherit" || (typeof value === "string" && /^[^/\s]+\/[^/\s]+$/.test(value)))) {
    throw new Error('sleep.model must be "inherit" or a single provider/model.');
  }
}

function resolveSleepModel(directory) {
  const global = readConfigBlock(globalConfigPath()).sleep;
  const project = readConfigBlock(projectConfigPath(directory)).sleep;
  const value = project?.model !== undefined ? project.model : global?.model !== undefined ? global.model : "inherit";
  validateConfigValue("sleepModel", value);
  return value;
}

// Surgical write: only the `mnemosyne` block is touched, and comments plus
// formatting elsewhere in the file are preserved byte for byte.
// Exported so the write guard can be tested directly.
export function writeProjectConfig(directory, changes) {
  const path = projectConfigPath(directory);
  const original = existsSync(path) ? readFileSync(path, "utf8") : "{\n}\n";
  const parseChecked = (text) => {
    const errors = [];
    const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length) throw new Error(`Cannot parse ${path}: ${errors[0].error} at offset ${errors[0].offset}`);
    return value && typeof value === "object" ? value : {};
  };
  parseChecked(original);
  const tree = parseTree(original, [], { allowTrailingComma: true });
  const rootKeys = tree?.children || [];
  const mnemosyneNodes = rootKeys.filter((entry) => entry.children?.[0]?.value === "mnemosyne");
  if (mnemosyneNodes.length > 1) throw new Error("Cannot update config with duplicate mnemosyne keys");
  // Detect duplicate updated keys within the selected block.
  const blockNode = mnemosyneNodes[0]?.children?.[1];
  for (const key of Object.keys(changes)) {
    const count = (blockNode?.children || []).filter((entry) => entry.children?.[0]?.value === key).length;
    if (count > 1) throw new Error(`Cannot update duplicate mnemosyne.${key} keys`);
  }
  let text = original;
  for (const [key, value] of Object.entries(changes)) {
    validateConfigValue(key, value);
    text = applyEdits(text, modify(text, ["mnemosyne", key], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
  }
  const result = parseChecked(text);
  for (const [key, value] of Object.entries(changes)) {
    if (result.mnemosyne?.[key] !== value) throw new Error(`Config update verification failed for mnemosyne.${key}`);
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
    writeMode: pickConfig(config, saved, "writeMode", "project"),
    effectiveWriteMode: pickConfig(config, saved, "writeMode", "project") === "global" && pickConfig(config, saved, "globalBank", true) !== false ? "global" : "project",
    dataDir: pickConfig(config, saved, "dataDir", defaultDataDir()),
    sleepModel: resolveSleepModel(identity.directory),
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
  const worker = { child, pending: new Map(), buffer: "", sequence: 0, backend: project.backend, bank: project.bank, dataDir: project.dataDir };

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

export function writeDestination(project) {
  return project.effectiveWriteMode === "global" ? { ...project, bank: "opencode_global" } : project;
}

export function assignTurnModes(turns, previousCount, snapshots, fallbackMode, continuationMode) {
  let mode = continuationMode ?? fallbackMode;
  const assigned = [];
  for (const turn of turns.slice(previousCount)) {
    if (turn.role === "user" && snapshots.length) mode = snapshots.shift();
    assigned.push({ ...turn, writeMode: mode });
  }
  return assigned;
}

export function createSerializedFlush(flush) {
  const queues = new Map();
  return (sessionID) => {
    const previous = queues.get(sessionID) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => flush(sessionID));
    queues.set(sessionID, next);
    return next;
  };
}

export function createSerializedCallQueue(run) {
  let queue = Promise.resolve();
  return (...args) => {
    const result = queue.then(() => run(...args));
    queue = result.catch(() => {});
    return result;
  };
}

export function createTransitionBoundary() {
  let active = 0;
  let transitioning = false;
  let pendingTransitions = 0;
  let waiters = [];
  let transitionQueue = Promise.resolve();
  const enter = async () => {
    while (transitioning) await new Promise((resolve) => waiters.push(resolve));
    active++;
    return () => {
      active--;
      if (active === 0) waiters.splice(0).forEach((resolve) => resolve());
    };
  };
  return {
    runPrompt: async (fn) => {
      const leave = await enter();
      try { return await fn(); } finally { leave(); }
    },
    transition: (fn) => {
      pendingTransitions++;
      transitioning = true;
      const result = transitionQueue.then(async () => {
        try {
          while (active > 0) await new Promise((resolve) => waiters.push(resolve));
          return await fn();
        } finally {
          pendingTransitions--;
          if (pendingTransitions === 0) {
            transitioning = false;
            waiters.splice(0).forEach((resolve) => resolve());
          }
        }
      });
      transitionQueue = result.catch(() => {});
      return result;
    },
  };
}

export async function recallMemories(ctx, project, query, call = backendCall) {
  let projectResults = [];
  let projectError;
  try { projectResults = await call(ctx, project, "recall", { query, limit: project.recallLimit }); }
  catch (error) { projectError = error; }
  if (!project.globalBank) {
    if (projectError) { updateState(ctx, { lastError: `Project recall failed: ${projectError.message}` }); throw projectError; }
    updateState(ctx, { lastError: "" });
    return projectResults;
  }
  try {
    const globalResults = await call(ctx, { ...project, bank: "opencode_global" }, "recall", { query, limit: project.recallLimit });
    const seen = new Set(projectResults.map((item) => item.content));
    const extra = globalResults.find((item) => !seen.has(item.content));
    if (projectError) {
      updateState(ctx, { lastError: `Project recall failed; using global results: ${projectError.message}` });
      return globalResults.slice(0, project.recallLimit);
    }
    updateState(ctx, { lastError: "" });
    return [...projectResults, ...(extra && projectResults.length < project.recallLimit ? [extra] : [])];
  } catch (error) {
    if (projectError) {
      const message = `Project and global recall failed: ${projectError.message}; ${error.message}`;
      updateState(ctx, { lastError: message });
      console.error(`Mnemosyne recall failed: ${message}`);
      throw new Error(message);
    }
    updateState(ctx, { lastError: `Global recall failed: ${error.message}` });
    console.error(`Mnemosyne global recall failed: ${error.message}`);
    return projectResults;
  }
}

const queueWorkerCall = createSerializedCallQueue((project, operation, payload) => workerCallNow(project, operation, payload));
function workerCall(project, operation, payload) { return queueWorkerCall(project, operation, payload); }

export function workerMatchesProject(worker, project) {
  return Boolean(
    worker &&
    worker.backend === project.backend &&
    worker.bank === project.bank &&
    worker.dataDir === project.dataDir,
  );
}

function workerCallNow(project, operation, payload) {
  let worker = currentWorker;
  if (!workerMatchesProject(worker, project)) {
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

export function formatStats(stats) {
  const beam = stats?.beam || {};
  const working = beam.working_memory || {};
  const episodic = beam.episodic_memory || {};
  const triples = beam.triples || {};
  return [
    `Working memory: total ${working.total ?? 0}; consolidated ${working.consolidated ?? 0}; unconsolidated ${working.unconsolidated ?? 0}`,
    `Episodic memory: total ${episodic.total ?? 0}; vectors ${episodic.vectors ?? 0}; vector type ${episodic.vec_type ?? "unknown"}`,
    `Triples: ${triples.total ?? 0}`,
    `Legacy memories (separate from BEAM tiers): ${stats?.total_memories ?? 0}`,
  ];
}

export function configFingerprint(project) {
  return JSON.stringify({
    directory: project.directory,
    dataDir: project.dataDir,
    bank: project.bank,
    enabled: project.enabled,
    backend: project.backend,
    recallLimit: project.recallLimit,
    globalBank: project.globalBank,
    writeMode: project.writeMode,
    effectiveWriteMode: project.effectiveWriteMode,
    sleepModel: project.sleepModel,
  });
}

export function createMnemosyneCommand(ctx, { transitionMode, flushPendingTurns, backendCall: callBackend = backendCall, embeddingProbe = (project) => workerCall(project, "embedding_probe"), getSnapshot = () => undefined, pendingConfirmations = new Map(), expireConfirmations = () => {}, pendingSleeps = new Map(), sleepLocks = new Set() } = {}) {
  return {
    name: "mnemosyne",
    description: "Toggle and configure automatic project memory",
    async execute(input) {
      const sessionID = input.sessionID;
      const raw = (input.prompt?.text || "").trim();
      const args = raw.replace(/^\/mnemosyne(?:\s+|$)/i, "").trim();
      const [action, ...rest] = args.split(/\s+/).filter(Boolean);
      const command = (action || "").toLowerCase() === "sleep" && rest[0] ? rest[0].toLowerCase() : (action || "").toLowerCase();

      if (["sleep", "consent", "approve", "reject", "cancel"].includes(command)) {
        const release = (pending) => { if (pending) { pendingSleeps.delete(sessionID); sleepLocks.delete(pending.bank); } };
        const pending = pendingSleeps.get(sessionID);
        if (command === "reject" || command === "cancel") {
          if (pending?.committing) return notify(ctx, sessionID, "Sleep commit is already in progress; cancellation cannot stop the storage operation.", "Sleep commit already in progress.");
          release(pending);
          return notify(ctx, sessionID, pending ? "Sleep cancelled; no memory was written." : "No sleep is pending.", "Sleep cancelled.");
        }
        if (command !== "sleep" && !pending) return notify(ctx, sessionID, "No sleep is pending.", "No sleep is pending.");
        let project;
        try { project = getProject(ctx); } catch (error) { release(pending); return notify(ctx, sessionID, `Sleep stopped: ${error.message}`, "Sleep stopped."); }
        const fingerprint = configFingerprint(project);
        const destination = writeDestination(project);
        if (pending && (pending.fingerprint !== fingerprint || pending.bank !== destination.bank)) {
          release(pending);
          return notify(ctx, sessionID, "Sleep configuration changed; pending sleep cancelled without writing.", "Sleep cancelled because configuration changed.");
        }
        if (command === "sleep") {
          // V2 is identified only by the documented transient-generation API; never probe or call V1 session.prompt.
          if (typeof ctx.generate?.text !== "function") return notify(ctx, sessionID, "Sleep is unsupported: this OpenCode session does not expose the V2 transient generation API.", "Sleep is unsupported.");
          if (sleepLocks.has(destination.bank)) return notify(ctx, sessionID, "A sleep operation is already pending for this bank.", "Sleep already pending.");
          let session;
          try { session = await ctx.session.get({ sessionID }); } catch {}
          if (!session) return notify(ctx, sessionID, "Sleep stopped: the V2 session model is unavailable.", "Sleep stopped.");
          const configured = project.sleepModel;
          const model = configured === "inherit" ? session.model : (() => { const [providerID, ...id] = configured.split("/"); return { providerID, modelID: id.join("/") }; })();
          const providerID = model?.providerID;
          const id = model?.id || model?.modelID;
          if (!providerID || !id) return notify(ctx, sessionID, "Sleep stopped: no usable V2 provider/model is available.", "Sleep stopped.");
          sleepLocks.add(destination.bank);
          try {
            const preview = await callBackend(ctx, destination, "sleep_preview", {});
            const candidates = Array.isArray(preview) ? preview : (preview?.candidates || preview?.items || []);
            if (!candidates.length) { sleepLocks.delete(destination.bank); return notify(ctx, sessionID, "No sleep candidates are available.", "Sleep has no candidates."); }
            const prompt = `Summarize these memory candidates as concise episodic memories. Preserve meaning; do not invent facts.\n${JSON.stringify(candidates)}`;
            pendingSleeps.set(sessionID, { bank: destination.bank, project: destination, fingerprint, model: { providerID, id }, candidates, prompt, phase: "preview" });
            return notify(ctx, sessionID, `Sleep preview — provider/model: ${providerID}/${id}; bank: ${destination.bank}\nExact provider prompt:\n${prompt}\n\nRun /mnemosyne sleep consent to generate.`, "Sleep preview is ready; consent is required before generation.");
          } catch (error) { sleepLocks.delete(destination.bank); return notify(ctx, sessionID, `Sleep preview failed: ${error.message}`, "Sleep preview failed."); }
        }
        if (command === "consent") {
          if (pending.phase !== "preview") return notify(ctx, sessionID, "Sleep output is already generated; run approve or reject.", "Sleep consent is not available.");
          try {
            if (flushPendingTurns) await flushPendingTurns(sessionID);
            if (pending.fingerprint !== configFingerprint(getProject(ctx))) throw new Error("Project configuration changed before generation");
            const output = await ctx.generate.text({ model: pending.model, prompt: pending.prompt });
            pending.output = typeof output === "string" ? output : output?.text;
            if (!pending.output) throw new Error("Model returned empty output");
            pending.phase = "approved-output";
            return notify(ctx, sessionID, `Generated sleep output:\n${pending.output}\n\nRun /mnemosyne sleep approve to store, or /mnemosyne sleep reject.`, "Sleep output awaits explicit approval.");
          } catch (error) { release(pending); return notify(ctx, sessionID, `Sleep generation failed: ${error.message}`, "Sleep generation failed."); }
        }
        if (command === "approve") {
          if (pending.phase !== "approved-output") return notify(ctx, sessionID, "No generated sleep output awaits approval.", "Sleep approval unavailable.");
          if (pending.committing) return notify(ctx, sessionID, "Sleep commit is already in progress.", "Sleep commit pending.");
          pending.committing = true;
          try {
            const sourceIds = [...new Set(pending.candidates.flatMap((item) => item.source_ids || item.sourceIds || (item.id ? [item.id] : [])))];
            if (!sourceIds.length) {
              pending.committing = false;
              release(pending);
              return notify(ctx, sessionID, "Sleep candidates have no source IDs; nothing was committed.", "Sleep commit rejected: missing source IDs.");
            }
            await callBackend(ctx, pending.project, "sleep_commit", { operation_id: pending.operationId ||= createHash("sha256").update(`${pending.bank}:${sessionID}:${fingerprint}:${sourceIds.join(",")}`).digest("hex"), source_ids: sourceIds, summary: pending.output });
            release(pending);
            return notify(ctx, sessionID, "Sleep summary stored in episodic memory.", "Sleep commit completed.");
          } catch (error) { pending.committing = false; return notify(ctx, sessionID, `Sleep commit failed; approved output retained. Run /mnemosyne sleep approve to retry commit (generation will not repeat): ${error.message}\n${pending.output}`, "Sleep commit failed; output retained."); }
        }
      }

      if (command === "invalidate" || command === "confirm") {
        const project = getProject(ctx);
        const pending = command === "confirm" ? pendingConfirmations.get(sessionID) : undefined;
        if (command === "confirm") pendingConfirmations.delete(sessionID);
        const snapshot = command === "confirm" ? pending?.snapshot : getSnapshot(sessionID);
        const index = command === "confirm" ? pending?.index : (/^\d+$/.test(rest[0] || "") ? Number(rest[0]) : 0);
        const target = command === "confirm" ? pending?.target : (index > 0 ? snapshot?.results?.[index - 1] : undefined);
        if (!target || !target.id || ![project.bank, "opencode_global"].includes(target.bank) || (command === "confirm" && (!pending || getSnapshot(sessionID) !== snapshot || pending.fingerprint !== configFingerprint(project))) || (command === "invalidate" && snapshot.fingerprint !== configFingerprint(project))) return notify(ctx, sessionID, "Cannot invalidate: selection or project configuration is stale; no mutation was sent.", "Invalidation was not performed.");
        if (target.bank === "opencode_global" && !project.globalBank) return notify(ctx, sessionID, "Global-bank access is disabled; invalidation was not performed.", "Invalidation was not performed.");
        if (target.bank === "opencode_global" && command !== "confirm") {
          pendingConfirmations.set(sessionID, { snapshot, target, index, fingerprint: configFingerprint(project) });
          return notify(ctx, sessionID, `Confirm invalidation of global bank ${target.bank}:\n${target.content}\nRun /mnemosyne confirm.`, "Global memory invalidation requires confirmation.");
        }
        if (command === "confirm" && target.bank !== "opencode_global") return notify(ctx, sessionID, "No global invalidation is pending.", "Invalidation was not performed.");
        if (target.bank !== "opencode_global") expireConfirmations(sessionID);
        try {
          const result = await callBackend(ctx, { ...project, bank: target.bank }, "invalidate", { memory_id: target.id });
          return notify(ctx, sessionID, result === true ? `Invalidated ${target.bank} memory ${index}.` : `Invalidation was not confirmed (result: ${String(result)}).`, "Memory invalidation completed or was rejected.");
        } catch (error) { return notify(ctx, sessionID, `Invalidation outcome unknown; do not retry automatically: ${error.message}`, "Memory invalidation outcome is unknown."); }
      }

      if (!command || command === "help") {
        return notify(
          ctx,
          sessionID,
          [
            "/mnemosyne — show this help",
            "/mnemosyne sleep — preview; then consent, approve, or reject",
            "/mnemosyne on|off — enable or disable automatic memory for this project",
            "/mnemosyne global on|off — route writes to shared or project bank",
            "/mnemosyne invalidate <n> — invalidate an injected project memory; global memories require confirm",
            "/mnemosyne confirm — confirm the pending global-memory invalidation",
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
        let embeddingStatus = "";
        if (project.backend === BACKENDS.embedded) {
          try {
            await embeddingProbe(project);
            embeddingStatus = "\nembedding_service: available (fixed test text sent to configured endpoint)";
          } catch (error) {
            embeddingStatus = `\nembedding_service: unavailable — ${error.message}`;
          }
        }
        const error = project.lastError ? `\nlast_error: ${project.lastError}` : "";
        return notify(
          ctx,
          sessionID,
          [
            `enabled: ${project.enabled}`,
            `backend: ${project.backend}`,
            `recallLimit: ${project.recallLimit}`,
            `globalBank: ${project.globalBank}`,
            `writeMode: ${project.writeMode}`,
            `effectiveWriteMode: ${project.effectiveWriteMode}`,
            `bank: ${project.bank}`,
            `project: ${project.directory}`,
            `data: ${project.dataDir}`,
            `config: ${describeConfigSources(project)}`,
          ].join("\n") + embeddingStatus + error,
          `Project memory status printed in chat: enabled=${project.enabled}, backend=${project.backend}.`,
        );
      }

      if (command === "global" && (rest[0] === "on" || rest[0] === "off")) {
        const project = getProject(ctx);
        if (rest[0] === "on" && !project.globalBank) return notify(ctx, sessionID, "Global bank is disabled; write mode was not changed.", "Global mode is disabled by configuration.");
        const persist = () => updateConfig(ctx, { writeMode: rest[0] === "on" ? "global" : "project" });
        if (!transitionMode) throw new Error("Mode transitions are unavailable outside plugin setup");
        const updated = await transitionMode(persist);
        expireConfirmations();
        return notify(ctx, sessionID, `Write mode: ${updated.writeMode}`, `Mnemosyne writes now target ${updated.writeMode}.`);
      }

      if (command === "stats") {
        const project = getProject(ctx);
        const stats = await callBackend(ctx, project, "stats");
        const lines = [`Project bank (${project.bank})`, ...formatStats(stats)];
        if (project.globalBank) {
          try {
            const globalStats = await callBackend(ctx, { ...project, bank: "opencode_global" }, "stats");
            lines.push("", "Global bank (opencode_global)", ...formatStats(globalStats));
          } catch (error) {
            lines.push("", `Global bank (opencode_global): stats unavailable: ${error.message}`);
          }
        } else {
          lines.push("", "Global bank: disabled");
        }
        return notify(ctx, sessionID, lines.join("\n"), "Backend memory statistics printed in chat.");
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
        expireConfirmations();
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
        expireConfirmations();
        if (backendAction === BACKENDS.embedded) {
          try {
            await embeddingProbe(project);
            return notify(ctx, sessionID, `Mnemosyne enabled for ${project.name} with backend ${project.backend}\nEmbedding service: available (fixed test text sent to configured endpoint)`, `Project memory backend switched to ${project.backend} and enabled; embedding service is available.`);
          } catch (error) {
            return notify(ctx, sessionID, `Mnemosyne enabled for ${project.name} with backend ${project.backend}\nWARNING: embedding service unavailable: ${error.message}\nThe embedded backend remains selected.`, `Project memory remains configured for ${project.backend}, but the embedding service is unavailable.`);
          }
        }
        return notify(
          ctx,
          sessionID,
          `Mnemosyne enabled for ${project.name} with backend ${project.backend}`,
          `Project memory backend switched to ${project.backend} and enabled for this project.`,
        );
      }

      if (command === "backend" && backendNames.includes(rest[0])) {
        const project = updateConfig(ctx, { backend: rest[0] });
        expireConfirmations();
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
    const pendingConfirmations = new Map();
    const pendingSleeps = new Map();
    const sleepLocks = new Set();
    const turnCounts = new Map();
    const modeSnapshots = new Map();
    const continuationModes = new Map();
    const events = new AbortController();
    const boundary = createTransitionBoundary();
    const serializedFlush = createSerializedFlush(async (sessionID) => boundary.runPrompt(() => flush(sessionID)));
    const transitionMode = (persist) => boundary.transition(async () => {
      for (const sessionID of ownSessions) await flush(sessionID);
      return persist();
    });

    registrations.push(await ctx.command.transform((editor) => {
      editor.add(createMnemosyneCommand(ctx, { transitionMode, flushPendingTurns: (sessionID) => boundary.runPrompt(() => flush(sessionID)), pendingConfirmations, pendingSleeps, sleepLocks, getSnapshot: (id) => { const value = recallBySession.get(id); return value?.injected ? value : undefined; }, expireConfirmations: (id) => id ? pendingConfirmations.delete(id) : pendingConfirmations.clear() }));
    }));

    registrations.push(await ctx.session.hook("prompt", async (event) => {
      return boundary.runPrompt(async () => {
        ownSessions.add(event.sessionID);
        const project = getProject(ctx);
        const fingerprint = configFingerprint(project);
        pendingConfirmations.delete(event.sessionID);
        recallBySession.delete(event.sessionID);
        const query = event.prompt?.text?.trim();
        if (!query) return;
        if (!project.enabled) { recallBySession.delete(event.sessionID); return; }
        const snapshots = modeSnapshots.get(event.sessionID) || [];
        snapshots.push(project.effectiveWriteMode);
        modeSnapshots.set(event.sessionID, snapshots);
        try {
          const results = await recallMemories(ctx, project, event.prompt.text.trim());
          recallBySession.set(event.sessionID, { generation: Symbol("recall"), results, fingerprint, injected: false });
        } catch (error) {
          recallBySession.delete(event.sessionID);
          console.error(`Mnemosyne recall failed: ${error.message}`);
        }
      });
    }));

    registrations.push(await ctx.session.hook("context", (event) => {
      const snapshot = recallBySession.get(event.sessionID);
      const results = snapshot?.results || [];
      if (!results.length) return;
      const block = memoryBlock(results);
      if (block) {
        event.system.push({ type: "text", text: block });
        snapshot.injected = true;
      }
    }));

    const flush = async (sessionID) => {
      const project = getProject(ctx);
      if (!project.enabled) return;
      const messages = await ctx.session.context({ sessionID });
      const turns = renderMessages(messages);
      const previous = turnCounts.get(sessionID) || 0;
      if (turns.length < previous) return;
      const snapshots = modeSnapshots.get(sessionID) || [];
      const pendingSnapshots = [...snapshots];
      const assignedTurns = assignTurnModes(
        turns,
        previous,
        pendingSnapshots,
        project.effectiveWriteMode,
        continuationModes.get(sessionID),
      );
      for (const turn of assignedTurns) {
        const destination = writeDestination({ ...project, effectiveWriteMode: turn.writeMode });
        await backendCall(ctx, destination, "remember", {
          content: turn.content,
            metadata: { role: turn.role, session_id: sessionID, project: project.id },
        });
      }
      snapshots.splice(0, snapshots.length - pendingSnapshots.length);
      const lastNewTurn = assignedTurns.at(-1);
      if (lastNewTurn?.role === "user") continuationModes.set(sessionID, lastNewTurn.writeMode);
      else if (lastNewTurn?.role === "assistant") continuationModes.set(sessionID, lastNewTurn.writeMode);
      turnCounts.set(sessionID, turns.length);
    };

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) {
        const sessionID = event.data?.sessionID;
        if (!sessionID || !IDLE_EVENTS.has(event.type) || !ownSessions.has(sessionID)) continue;
        try {
          await serializedFlush(sessionID);
        } catch (error) {
          console.error(`Mnemosyne write-back failed for ${sessionID}: ${error.message}`);
        }
      }
    })().catch((error) => console.error(`Mnemosyne event stream failed: ${error.message}`));

    return async () => {
      events.abort();
      pendingSleeps.clear();
      sleepLocks.clear();
      if (currentWorker) currentWorker.child.kill("SIGTERM");
      const disposers = registrations.map((registration) => registration.dispose?.());
      await Promise.all(disposers);
    }
  },
});
