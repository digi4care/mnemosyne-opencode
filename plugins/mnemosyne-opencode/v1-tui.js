import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configFingerprint, getProject } from "./index.js";

const ROOT = join(homedir(), ".local/share/opencode/storage/plugin/mnemosyne-opencode");
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "memory_worker.py");
const coordPath = () => process.env.MNEMOSYNE_PLUGIN_COORD_DB || join(ROOT, "plugin-coord.db");

export function createV1Tui({ api, client, workerCall, deadlineMs = 5000, pollMs = 100, now = Date.now } = {}) {
  const call = workerCall || createWorkerCall();
  const currentSession = () => {
    const route = api.route.current;
    const sessionID = route?.params?.sessionID;
    const directory = api.state?.path?.directory;
    return sessionID && directory ? { sessionID, directory } : null;
  };
  const notify = (message, variant = "info") => api.ui.toast({ message, variant });
  async function runCommand(action, args = []) {
    const session = currentSession();
    if (!session) { notify("Open a session before using /mnemosyne.", "warning"); return; }
    const directory = session.directory;
    const ctx = { location: { directory, project: { directory, canonical: directory } } };
    const project = getProject(ctx);
    const operationID = randomUUID();
    const fingerprint = configFingerprint(project);
    const kind = action === "global" ? "mode" : "command";
    const payload = action === "global" ? { mode: args[0] === "on" ? "global" : "project" } : { action, args, sessionID: session.sessionID };
    try {
      const until = now() + deadlineMs;
      const remaining = () => Math.max(1, until - now());
      await withDeadline(call(project, "coord_enqueue_request", { project: project.directory, session: session.sessionID, operation_id: operationID, kind, fingerprint, payload }), remaining());
      while (now() < until) {
        const status = await withDeadline(call(project, "coord_request_status", { operation_id: operationID }), remaining());
        if (status?.status === "complete") { notify(status.result?.message || `Mnemosyne ${action}: complete`); return; }
        if (status?.status === "failed") { notify(status.result?.error || "Mnemosyne request failed.", "error"); return; }
        await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining())));
      }
      notify(`Mnemosyne request timed out (${operationID}); check status before retrying.`, "warning");
    } catch (error) { notify(`Mnemosyne request failed: ${error.message}`, "error"); }
  }
  const prompts = {
    invalidate: { title: "Invalidate memory", description: "Enter the number from the most recently injected memory list.", placeholder: "1", validate: value => /^[0-9]+$/.test(value.trim()) && Number(value) > 0 },
    backup: { title: "Backup directory", description: "Optional output directory; leave blank for the default.", placeholder: "" },
    "import-hindsight": { title: "Import Hindsight", description: "Enter a local file path or URL.", placeholder: "file-or-url", validate: value => Boolean(value.trim()) },
  };
  const actions = ["help", "on", "off", "status", "global-on", "global-off", "stats", "invalidate", "confirm", "file", "embedded", "backup", "verify", "verify-full", "import-hindsight", "sleep"];
  const unregister = api.command.register(() => actions.map((name) => ({
    title: `Mnemosyne ${name}`,
    value: `mnemosyne-${name}`,
    slash: { name: `mnemosyne-${name}` },
    description: `Mnemosyne ${name}`,
    onSelect: (stack) => {
      const action = name.startsWith("global-") ? "global" : name === "import-hindsight" ? "import" : name === "verify-full" ? "verify" : name;
      const args = name.startsWith("global-") ? [name.slice("global-".length)] : name === "import-hindsight" ? ["hindsight"] : name === "verify-full" ? ["--full"] : [];
      const prompt = prompts[name];
      if (!prompt) return runCommand(action, args);
      const dialogs = stack || api.ui.dialog;
      if (!dialogs?.replace || typeof api.ui.DialogPrompt !== "function") { notify(`Cannot open the ${name} input dialog.`, "error"); return; }
      dialogs.replace(() => api.ui.DialogPrompt({
        title: prompt.title,
        placeholder: prompt.placeholder,
        onConfirm: value => {
          dialogs.clear();
          if (prompt.validate && !prompt.validate(value)) { notify(`Invalid input for ${name}.`, "warning"); return; }
          const valueArgs = name === "invalidate" ? [value.trim()] : name === "backup" ? (value.trim() ? [value.trim()] : []) : [value.trim()];
          return runCommand(action, [...args, ...valueArgs]);
        },
        onCancel: () => dialogs.clear(),
      }));
    },
  })));
  return {
    close: () => call.close?.(),
    dispose: async () => { if (typeof unregister === "function") unregister(); await call.close?.(); },
    runCommand,
  };
}

function withDeadline(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer=setTimeout(()=>reject(new Error("request deadline exceeded")),milliseconds); })]).finally(()=>clearTimeout(timer));
}

function createWorkerCall() {
  // The TUI writes only coordination rows; it opens the same DB as the server.
  const dataDir = process.env.MNEMOSYNE_DATA_DIR || join(ROOT, "data");
  mkdirSync(dataDir, { recursive: true });
  const child = spawn("uvx", ["--from", "mnemosyne-memory==3.15.1", "--with", "numpy", "python", WORKER], { cwd: dirname(WORKER), env: { ...process.env, MNEMOSYNE_HOME: dataDir, MNEMOSYNE_DATA_DIR: dataDir, MNEMOSYNE_PLUGIN_COORD_DB: coordPath(), MNEMOSYNE_MCP_BANK: "opencode_tui", MNEMOSYNE_LLM_ENABLED: "false", MNEMOSYNE_NO_EMBEDDINGS: "1" }, stdio: ["pipe", "pipe", "ignore"] });
  let sequence = 0, buffer = "";
  const pending = new Map();
  let closed = false;
  const exited = new Promise(resolve => child.once("exit", resolve));
  const rejectPending = (error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on("error", error => { closed = true; rejectPending(error); });
  child.on("exit", (code, signal) => { closed = true; rejectPending(new Error(`Mnemosyne TUI worker exited (${code ?? signal ?? "unknown"})`)); });
   child.stdout.on("data", chunk => { buffer += chunk; while (buffer.includes("\n")) { const n=buffer.indexOf("\n"), line=buffer.slice(0,n); buffer=buffer.slice(n+1); try { const response=JSON.parse(line), item=pending.get(response.id); if(!item)continue; pending.delete(response.id); clearTimeout(item.timer); response.ok?item.resolve(response.result):item.reject(new Error(response.error)); } catch {} } });
  const call = (project, operation, payload = {}) => new Promise((resolve, reject) => {
    // Worker opens Mnemosyne's DB at startup, but coordination DB is explicitly
    // shared and independent of the project-bank name.
    if (operation !== "coord_enqueue_request" && operation !== "coord_request_status" && operation !== "shutdown") return reject(new Error("TUI may only use coordination operations"));
    if (closed) return reject(new Error("Mnemosyne TUI worker is closed"));
    const id=String(++sequence), timer=setTimeout(()=>{pending.delete(id);reject(new Error(`worker timeout: ${operation}`));},60000);
    pending.set(id,{resolve,reject,timer}); child.stdin.write(`${JSON.stringify({id,operation,...payload})}\n`, error => { if (error) { pending.delete(id); clearTimeout(timer); reject(error); } });
  });
  call.close = async () => {
    if (closed) return;
    try { await call(null, "shutdown"); } catch {}
    if (!closed) {
      let timeout;
      await Promise.race([exited, new Promise(resolve => { timeout=setTimeout(resolve, 2000); })]);
      clearTimeout(timeout);
    }
    if (!closed) { child.kill("SIGTERM"); await exited; }
  };
  return call;
}

export async function V1Tui(api) {
  const instance = createV1Tui({ api });
  api.lifecycle?.onDispose?.(() => instance.close());
}

export default { id: "digi4care.mnemosyne-opencode.tui", tui: V1Tui };
