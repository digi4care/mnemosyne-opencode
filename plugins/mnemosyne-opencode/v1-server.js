import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKENDS, configFingerprint, createSerializedFlush, formatStats, getProject, recallMemories, writeDestination, writeProjectConfig } from "./index.js";

const ROOT = join(homedir(), ".local/share/opencode/storage/plugin/mnemosyne-opencode");
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "memory_worker.py");
const coordPath = () => process.env.MNEMOSYNE_PLUGIN_COORD_DB || join(ROOT, "plugin-coord.db");

export function createV1Server({ client, project, directory, workerCall, now = Date.now, pollMs = 100, deadlineMs = 5000 } = {}) {
  const ctx = { location: { project, directory } };
  let projectInfo = getProject(ctx);
  const serverEpoch = randomUUID();
  const turnCounts = new Map();
  const continuationModes = new Map();
  const promptModes = new Map();
  const snapshots = new Map();
  const latestRecall = new Map();
  const pendingConfirmations = new Map();
  let stopped = false;
  let processingRequest = false;
  let transitionActive = false;
  let activeFlushes = 0;
  let transitionQueue = Promise.resolve();
  let boundaryWaiters = [];
  const wakeBoundary = () => boundaryWaiters.splice(0).forEach(resolve => resolve());
  const waitBoundary = () => new Promise(resolve => boundaryWaiters.push(resolve));

  const call = workerCall || createWorkerCall(projectInfo);
  const coord = (operation, payload = {}) => call(projectInfo, operation, payload);
  const projectKey = projectInfo.directory;

  async function getActualMessages(sessionID) {
    const messageLimit = 1000;
    const response = unwrapSdkResponse(await client.session.messages({ path: { id: sessionID }, query: { directory: projectInfo.directory, limit: messageLimit } }), "session.messages");
    if (!Array.isArray(response)) throw new Error("V1 session.messages returned an incomplete inventory");
    if (response.length >= messageLimit) throw new Error("V1 session.messages reached the request limit; completeness cannot be proven");
    return response;
  }

  async function sessionIdle(sessionID) {
    let response;
    try { response = unwrapSdkResponse(await client.session.status({ query: { directory: projectInfo.directory } }), "session.status"); }
    catch { return false; }
    if (!response || typeof response !== "object" || Array.isArray(response)) return false;
    // V1.18.35 omits idle sessions from SessionStatus; presence means active.
    return !Object.hasOwn(response, sessionID);
  }

  async function flush(sessionID) {
    projectInfo = getProject(ctx);
    if (!projectInfo.enabled) return;
    if (!(await sessionIdle(sessionID))) throw new Error("session status is not confirmed idle");
    const published = await coord("coord_get_snapshot", { project: projectKey, session: sessionID });
    if (!published) return false;
    if (published.claimed) return false;
    const actual = await getActualMessages(sessionID);
    const verified = verifySnapshot(published, actual, sessionID, configFingerprint(getProject(ctx)));
    if (!verified) return false;
    const claimed = await coord("coord_claim_snapshot", { project: projectKey, session: sessionID, generation: published.generation, fingerprint: published.fingerprint });
    if (!claimed?.claimed) return false;
    try {
      if (!(await sessionIdle(sessionID))) throw new Error("session ceased to be idle before flush");
      const reconciled = await getActualMessages(sessionID);
      if (!verifySnapshot(published, reconciled, sessionID, configFingerprint(getProject(ctx)))) throw new Error("published V1 snapshot does not match persisted messages/configuration");
      const previous = turnCounts.get(sessionID) || 0;
      const allTurns = reconciled.map(messageToTurn).filter(Boolean);
      const rows = allTurns.slice(previous);
      for (const row of rows) {
        if (row.role === "assistant" && !row.completed) throw new Error("assistant message is not finalized");
        const mode = row.role === "user" ? (promptModes.get(sessionID)?.get(row.id) || projectInfo.effectiveWriteMode) : (continuationModes.get(sessionID) || projectInfo.effectiveWriteMode);
        const target = writeDestination({ ...projectInfo, effectiveWriteMode: mode });
        await call(target, "remember_turn", { project: projectKey, sessionID, messageID: row.id, content: row.content, metadata: { role: row.role, session_id: sessionID, project: projectInfo.id } });
      }
      turnCounts.set(sessionID, allTurns.length);
      return true;
    } finally {
      // A released successful snapshot may be re-claimed for later safe retries;
      // remember_turn's stable message ledger makes those retries idempotent.
      await coord("coord_release_snapshot", { project: projectKey, session: sessionID, generation: published.generation, fingerprint: published.fingerprint });
    }
  }

  const serializedFlush = createSerializedFlush(async sessionID => {
    while (transitionActive) await waitBoundary();
    activeFlushes++;
    try { return await flush(sessionID); }
    finally { activeFlushes--; wakeBoundary(); }
  });

  function withTransition(fn) {
    const result = transitionQueue.then(async () => {
      transitionActive = true;
      try {
        while (activeFlushes > 0) await waitBoundary();
        return await fn();
      } finally {
        transitionActive = false;
        wakeBoundary();
      }
    });
    transitionQueue = result.catch(() => {});
    return result;
  }

  async function inventoryIdle() {
    const pageSize = 100;
    let start = 0;
    let sessions = [];
    while (true) {
      const page = unwrapSdkResponse(await client.session.list({ query: { directory: projectInfo.directory, start, limit: pageSize } }), "session.list");
      const data = Array.isArray(page) ? page : page?.data;
      if (!Array.isArray(data)) throw new Error("session.list did not return a complete page");
      sessions.push(...data);
      if (data.length < pageSize) break;
      start += pageSize;
      if (start > 100000) throw new Error("session inventory exceeded safety bound");
    }
    const status = unwrapSdkResponse(await client.session.status({ query: { directory: projectInfo.directory } }), "session.status");
    if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("session.status returned no usable status map");
    for (const session of sessions) if (!session.id || Object.hasOwn(status, session.id)) throw new Error(`session ${session.id || "unknown"} is not confirmed idle`);
    return sessions;
  }

  async function transition(mode) {
    return withTransition(async () => {
      projectInfo = getProject(ctx);
      if (mode === "global" && !projectInfo.globalBank) throw new Error("global bank is disabled; write mode was not changed");
      const sessions = await inventoryIdle();
      for (const session of sessions) if (!(await flush(session.id))) throw new Error(`session ${session.id} has no verified snapshot; mode switch cancelled`);
      writeProjectConfig(projectInfo.directory, { writeMode: mode });
      pendingConfirmations.clear();
    });
  }

  async function drainBeforeConfigChange() {
    return withTransition(async () => {
      const sessions = await inventoryIdle();
      for (const session of sessions) if (!(await flush(session.id))) throw new Error(`session ${session.id} has no verified snapshot; configuration change cancelled`);
    });
  }

  async function processRequests() {
    if (stopped || processingRequest) return;
    processingRequest = true;
    try {
      await coord("coord_heartbeat", { server_epoch: serverEpoch });
      const request = await coord("coord_claim_next", { project: projectKey, server_epoch: serverEpoch });
      if (!request) return;
      try {
        if (request.fingerprint !== configFingerprint(getProject(ctx))) {
          if (request.payload?.sessionID) pendingConfirmations.delete(request.payload.sessionID);
          throw new Error("configuration changed since request; no action performed");
        }
        let result;
        if (request.kind === "mode") {
          if (!['project', 'global'].includes(request.payload.mode)) throw new Error("invalid mode request");
          await transition(request.payload.mode);
          result = { writeMode: request.payload.mode };
        } else if (request.kind === "command") {
          result = await executeCommand(request);
        } else throw new Error(`unsupported V1 request: ${request.kind}`);
        await coord("coord_finish_request", { operation_id: request.operation_id, server_epoch: serverEpoch, status: "complete", result });
      } catch (error) {
        await coord("coord_finish_request", { operation_id: request.operation_id, server_epoch: serverEpoch, status: "failed", result: { error: error.message } });
      }
    } finally {
      processingRequest = false;
    }
  }

  async function executeCommand(request) {
    projectInfo = getProject(ctx);
    const { action, args = [], sessionID } = request.payload || {};
    if (!Array.isArray(args) || args.some(value => typeof value !== "string")) throw new Error("invalid command arguments");
    if (["help", "on", "off", "status", "stats", "confirm", "file", "embedded", "sleep"].includes(action) && args.length) throw new Error(`${action} does not accept arguments`);
    if (action === "invalidate" && (args.length !== 1 || !/^[1-9][0-9]*$/.test(args[0]))) throw new Error("invalidate requires one positive memory number");
    if (action === "backup" && args.length > 1) throw new Error("backup accepts at most one output directory");
    if (action === "verify" && !(args.length === 0 || (args.length === 1 && args[0] === "--full"))) throw new Error("verify accepts only --full");
    if (action === "import" && (args.length > 2 || (args.length > 0 && args[0] !== "hindsight"))) throw new Error("usage: import hindsight <file-or-url>");
    if (action === "on" || action === "off") {
      const path = writeProjectConfig(projectInfo.directory, { enabled: action === "on" });
      pendingConfirmations.delete(sessionID);
      return { message: `Mnemosyne ${action === "on" ? "enabled" : "disabled"}. Wrote ${path}` };
    }
    if (action === "global") { await transition(args[0] === "on" ? "global" : "project"); return { message: `Write mode: ${args[0] === "on" ? "global" : "project"}` }; }
    if (action === "status") return { message: [`enabled: ${projectInfo.enabled}`, `backend: ${projectInfo.backend}`, `recallLimit: ${projectInfo.recallLimit}`, `globalBank: ${projectInfo.globalBank}`, `writeMode: ${projectInfo.writeMode}`, `effectiveWriteMode: ${projectInfo.effectiveWriteMode}`, `bank: ${projectInfo.bank}`, `project: ${projectInfo.directory}`, `data: ${projectInfo.dataDir}`, `last_error: ${projectInfo.lastError || ""}`].join("\n") };
    if (action === "stats") {
      const lines = [`Project bank (${projectInfo.bank})`, ...formatStats(await call(projectInfo, "stats"))];
      if (!projectInfo.globalBank) lines.push("", "Global bank: disabled");
      else { try { lines.push("", "Global bank (opencode_global)", ...formatStats(await call({ ...projectInfo, bank: "opencode_global" }, "stats"))); } catch (error) { lines.push("", `Global bank (opencode_global): stats unavailable: ${error.message}`); } }
      return { message: lines.join("\n") };
    }
    if (action === "invalidate") return invalidate(sessionID, args);
    if (action === "confirm") return confirmInvalidation(sessionID);
    if (action === "file" || action === "embedded") {
      await drainBeforeConfigChange();
      const backend = action === "file" ? BACKENDS.file : BACKENDS.embedded;
      const path = writeProjectConfig(projectInfo.directory, { backend, enabled: true });
      pendingConfirmations.clear();
      return { message: `Mnemosyne enabled for ${projectInfo.directory} with backend ${backend}. Wrote ${path}` };
    }
    if (action === "backup") {
      const result = await runCli(projectInfo, ["backup", ...(args[0] ? [args[0]] : [])]);
      return { message: (result || "Backup completed").trim().split("\n").slice(0, 6).join("\n") };
    }
    if (action === "verify") return { message: await runCli(projectInfo, ["verify", ...(args.includes("--full") ? [] : ["--quick"])]) };
    if (action === "import" && args[0] === "hindsight") {
      const source = args.slice(1).join(" ").trim();
      if (!source) return { message: "Usage: /mnemosyne-import-hindsight needs a file path or URL." };
      return { message: await runCli(projectInfo, ["import-hindsight", source]) };
    }
    if (action === "sleep") return { message: "Sleep is unsupported on OpenCode V1; no memory was written." };
    if (action === "help") return { message: "/mnemosyne-on, /mnemosyne-off, /mnemosyne-status, /mnemosyne-global-on|off, /mnemosyne-stats, /mnemosyne-invalidate, /mnemosyne-confirm, /mnemosyne-file|embedded, /mnemosyne-backup, /mnemosyne-verify[-full], /mnemosyne-import-hindsight, /mnemosyne-sleep" };
    throw new Error(`unsupported command: ${action || "help"}`);
  }

  async function invalidate(sessionID, args) {
    const index = Number(args[0]);
    if (!Number.isSafeInteger(index) || index < 1) throw new Error("invalidate requires a positive memory number");
    const snapshot = await coord("coord_get_snapshot", { project: projectKey, session: sessionID });
    const project = getProject(ctx);
    if (!snapshot?.payload?.injected || snapshot.payload.configFingerprint !== configFingerprint(project)) throw new Error("injected memory snapshot is unavailable or stale; no mutation sent");
    const actual = await getActualMessages(sessionID);
    if (!verifySnapshot(snapshot, actual, sessionID, configFingerprint(project), true)) throw new Error("injected message snapshot is stale; no mutation sent");
    const target = snapshot.payload.results?.[index - 1];
    if (!target?.id || ![project.bank, "opencode_global"].includes(target.bank)) throw new Error("invalid or missing memory selection");
    if (target.bank === "opencode_global" && !project.globalBank) throw new Error("global-bank access is disabled");
    const identity = { generation: snapshot.generation, fingerprint: snapshot.fingerprint, id: target.id, bank: target.bank };
    if (target.bank === "opencode_global") {
      pendingConfirmations.set(sessionID, identity);
      return { message: `Confirm invalidation of global memory ${index} in ${target.bank}:\n${target.content}\nRun /mnemosyne-confirm.` };
    }
    const result = await call({ ...project, bank: target.bank }, "invalidate", { memory_id: target.id });
    return { message: result === true ? `Invalidated ${target.bank} memory ${index}.` : `Invalidation was not confirmed (${String(result)}).` };
  }

  async function confirmInvalidation(sessionID) {
    const pending = pendingConfirmations.get(sessionID);
    if (!pending) throw new Error("no global invalidation is pending");
    const project = getProject(ctx);
    const snapshot = await coord("coord_get_snapshot", { project: projectKey, session: sessionID });
    if (!snapshot?.payload?.injected || snapshot.generation !== pending.generation || snapshot.fingerprint !== pending.fingerprint || snapshot.payload.configFingerprint !== configFingerprint(project)) {
      pendingConfirmations.delete(sessionID);
      throw new Error("global invalidation snapshot/configuration is stale; no mutation sent");
    }
    const actual = await getActualMessages(sessionID);
    if (!verifySnapshot(snapshot, actual, sessionID, configFingerprint(project), true)) { pendingConfirmations.delete(sessionID); throw new Error("global invalidation message snapshot is stale; no mutation sent"); }
    if (!project.globalBank || pending.bank !== "opencode_global") { pendingConfirmations.delete(sessionID); throw new Error("global-bank access is disabled; no mutation sent"); }
    const result = await call({ ...project, bank: pending.bank }, "invalidate", { memory_id: pending.id });
    pendingConfirmations.delete(sessionID);
    return { message: result === true ? `Invalidated global memory ${pending.id}.` : `Invalidation was not confirmed (${String(result)}).` };
  }

  const timer = setInterval(() => void processRequests().catch((error) => console.error(`Mnemosyne V1 request poll: ${error.message}`)), pollMs);
  timer.unref?.();

  return {
    transition,
    processRequests,
    "chat.message": async (input, output) => {
      projectInfo = getProject(ctx);
      const message = output?.message;
      if (message?.role !== "user" || !input.sessionID) return;
      const text = textOf(output.parts);
      if (!text || !projectInfo.enabled) return;
      try {
        const results = await recallMemories(ctx, projectInfo, text, (_ctx, target, operation, payload) => call(target, operation, payload));
        const prior = await coord("coord_get_snapshot", { project: projectKey, session: input.sessionID });
        const generation = Math.max(snapshots.get(input.sessionID) || 0, Number(prior?.generation) || 0) + 1;
        const fingerprint = createHash("sha256").update(JSON.stringify({ project: projectKey, session: input.sessionID, messageID: input.messageID, text, generation, config: configFingerprint(projectInfo) })).digest("hex");
        const snapshot = { messageID: input.messageID, text, results, configFingerprint: configFingerprint(getProject(ctx)) };
        latestRecall.set(input.sessionID, { generation, fingerprint, block: results.length ? memoryBlock(results) : "" });
        const publication = await coord("coord_publish_snapshot", { project: projectKey, session: input.sessionID, generation, fingerprint, payload: snapshot });
        if (!publication?.published) { latestRecall.delete(input.sessionID); throw new Error("snapshot publication lost a generation race"); }
        snapshots.set(input.sessionID, generation);
        promptModes.set(input.sessionID, new Map([[input.messageID, projectInfo.effectiveWriteMode]]));
      } catch (error) { console.error(`Mnemosyne V1 recall failed: ${error.message}`); }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID || !projectInfo.enabled) return;
      const recall = latestRecall.get(input.sessionID);
      latestRecall.delete(input.sessionID);
      if (recall?.block) {
        const marked = await coord("coord_mark_snapshot_injected", { project: projectKey, session: input.sessionID, generation: recall.generation, fingerprint: recall.fingerprint });
        if (marked?.marked) output.system.push(recall.block);
      }
    },
    "tool.execute.after": async () => {},
    event: async ({ event }) => {
      if (event?.type !== "session.idle" || !event.properties?.sessionID) return;
      await serializedFlush(event.properties.sessionID);
    },
    async dispose() { stopped = true; clearInterval(timer); await call.close?.(); },
  };
}

function messageToTurn(message) {
  const role = message?.info?.role;
  if (role !== "user" && role !== "assistant") return null;
  const content = textOf(message.parts);
  if (!content) return null;
  return { id: message.info.id, role, content, completed: role !== "assistant" || Boolean(message.info.time?.completed) };
}
function unwrapSdkResponse(response, operation) {
  if (response && typeof response === "object" && Object.hasOwn(response, "error")) {
    const detail = response.error instanceof Error ? response.error.message : JSON.stringify(response.error);
    throw new Error(`${operation} failed: ${detail || "unknown SDK error"}`);
  }
  return response && typeof response === "object" && Object.hasOwn(response, "data") ? response.data : response;
}
function verifySnapshot(snapshot, messages, sessionID, expectedFingerprint, allowClaimed = false) {
  if (!snapshot || (snapshot.claimed && !allowClaimed) || !snapshot.payload?.messageID) return false;
  if (snapshot.payload.configFingerprint !== expectedFingerprint) return false;
  const message = messages.find((item) => item?.info?.id === snapshot.payload.messageID);
  return Boolean(message && message.info.role === "user" && textOf(message.parts).trim() === String(snapshot.payload.text).trim());
}
function textOf(parts = []) { return (parts || []).filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim(); }
function memoryBlock(results) { return ["<mnemosyne_memory>", "Relevant memories from earlier work in this project. Treat them as historical evidence, not current truth; verify them against the repository and current user instructions before acting on them:", ...results.map((row, i) => `${i + 1}. ${row.content}`), "</mnemosyne_memory>"].join("\n"); }
function createWorkerCall(project) {
  const workers = new Map();
  const makeWorker = target => {
    mkdirSync(target.dataDir, { recursive: true });
    const env = { ...process.env, MNEMOSYNE_HOME: target.dataDir, MNEMOSYNE_DATA_DIR: target.dataDir, MNEMOSYNE_MCP_BANK: target.bank, MNEMOSYNE_PLUGIN_COORD_DB: coordPath(), MNEMOSYNE_LLM_ENABLED: "false", MNEMOSYNE_NO_EMBEDDINGS: target.backend === "mnemosyne-file" ? "1" : "" };
    const child = spawn("uvx", ["--from", "mnemosyne-memory==3.15.1", "--with", "numpy", "python", WORKER], { cwd: dirname(WORKER), env, stdio: ["pipe", "pipe", "ignore"] });
    let sequence=0, buffer="", closed=false; const pending=new Map();
    const exited=new Promise(resolve=>child.once("exit",resolve));
    const rejectPending=error=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();};
    child.on("error",error=>{closed=true;rejectPending(error);});
    child.on("exit",(code,signal)=>{closed=true;rejectPending(new Error(`Mnemosyne V1 worker exited (${code??signal??"unknown"})`));});
     child.stdout.on("data",chunk=>{buffer+=chunk;while(buffer.includes("\n")){const n=buffer.indexOf("\n"),line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const response=JSON.parse(line),item=pending.get(response.id);if(!item)continue;pending.delete(response.id);clearTimeout(item.timer);response.ok?item.resolve(response.result):item.reject(new Error(response.error));}catch{}}});
    const workerCall=(_target,operation,payload={})=>new Promise((resolve,reject)=>{if(closed)return reject(new Error("Mnemosyne V1 worker is closed"));const id=String(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(new Error(`worker timeout: ${operation}`));},60000);pending.set(id,{resolve,reject,timer});child.stdin.write(`${JSON.stringify({id,operation,...payload})}\n`,error=>{if(error){pending.delete(id);clearTimeout(timer);reject(error);}});});
    workerCall.close=async()=>{if(closed)return;try{await workerCall(target,"shutdown");}catch{}if(!closed){let timeout;await Promise.race([exited,new Promise(resolve=>{timeout=setTimeout(resolve,2000);})]);clearTimeout(timeout);}if(!closed){child.kill("SIGTERM");await exited;}};
    return workerCall;
  };
  const workerFor=target=>{const key=JSON.stringify([target.dataDir,target.backend,target.bank]);if(!workers.has(key))workers.set(key,makeWorker(target));return workers.get(key);};
  const call=(target,operation,payload={})=>workerFor(target)(target,operation,payload);
  call.close=async()=>{await Promise.all([...workers.values()].map(worker=>worker.close()));};
  return call;
}

function runCli(project, args) {
  const env={...process.env,MNEMOSYNE_HOME:project.dataDir,MNEMOSYNE_DATA_DIR:project.dataDir,MNEMOSYNE_MCP_BANK:project.bank,MNEMOSYNE_DEFAULT_SCOPE:"global"};
  if(project.backend===BACKENDS.file)env.MNEMOSYNE_NO_EMBEDDINGS="1";else delete env.MNEMOSYNE_NO_EMBEDDINGS;
  const explicit=process.env.MNEMOSYNE_BIN;
  const command=explicit||"uvx";
  const finalArgs=explicit?args:["--from","mnemosyne-memory==3.15.1","--with","numpy","mnemosyne",...args];
  return new Promise((resolve,reject)=>{
    const child=spawn(command,finalArgs,{env,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";
    child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);
    child.on("error",reject);child.on("close",code=>code===0?resolve(stdout.trim()):reject(new Error((stderr||stdout||`mnemosyne exited ${code}`).trim())));
  });
}

export default async function V1Server(context) { return createV1Server(context); }
