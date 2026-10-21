import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createV1Server } from "../v1-server.js";
import V1TuiModule, { createV1Tui } from "../v1-tui.js";
import { readFile } from "node:fs/promises";

test("package exports keep the resolver server path on V2 and expose V1 explicitly", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.engines.node, ">=22.19.0");
  assert.equal(packageJson.exports["./server"], "./index.js");
  assert.equal(packageJson.exports["./v1-server"], "./v1-server.js");
  assert.equal(packageJson.exports["./tui"], "./v1-tui.js");
  const v2 = await import(packageJson.exports["./server"].replace("./", "../"));
  const v1 = await import("../v1-server.js");
  assert.equal(typeof v2.default, "object");
  assert.equal(typeof v2.default.id, "string");
  assert.equal(typeof v2.default.setup, "function");
  assert.equal(typeof v1.createV1Server, "function");
  assert.notEqual(v2.default, v1.createV1Server);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mnemo-v1-"));
  const projectDir = join(root, "project"); mkdirSync(projectDir);
  process.env.MNEMOSYNE_STATE_FILE = join(root, "state.json");
  process.env.MNEMOSYNE_DATA_DIR = join(root, "data");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  t.after(() => { rmSync(root, { recursive: true, force: true }); for (const key of ["MNEMOSYNE_STATE_FILE", "MNEMOSYNE_DATA_DIR", "XDG_CONFIG_HOME"]) delete process.env[key]; });
  return { root, projectDir };
}

test("V1 TUI export matches the V1.18.35 module loader contract", () => {
  assert.equal(V1TuiModule.id, "digi4care.mnemosyne-opencode.tui");
  assert.equal(typeof V1TuiModule.tui, "function");
});

test("V1 server registers supported hooks and recalls/injects user context", async t => {
  const { projectDir } = fixture(t); const calls=[]; let persisted={generation:7,fingerprint:"old",payload:{},claimed:true};
  const { writeProjectConfig }=await import("../index.js"); writeProjectConfig(projectDir,{enabled:true});
  const client={ session:{ messages: async()=>[], status: async()=>({}) } };
  const server=createV1Server({ client, directory:projectDir, project:{directory:projectDir,canonical:projectDir}, workerCall:async(_p,op,payload)=>{ calls.push([op,payload]); if(op==="recall")return [{content:"prior fact"}]; if(op==="coord_get_snapshot")return persisted; if(op==="coord_publish_snapshot"){persisted={...payload,claimed:false};return {published:true};} if(op==="coord_mark_snapshot_injected")return {marked:true}; return {}; } });
  assert.equal(typeof server["chat.message"],"function"); assert.equal(typeof server["experimental.chat.system.transform"],"function"); assert.equal(typeof server.event,"function"); assert.equal(typeof server["tool.execute.after"],"function");
  const early={system:[]}; await server["experimental.chat.system.transform"]({sessionID:"ses-a",model:{}},early); assert.deepEqual(early.system,[],"transform before chat.message fails safe without stale context");
  await server["chat.message"]({sessionID:"ses-a",messageID:"msg-a"},{message:{role:"user"},parts:[{type:"text",text:"question"}]});
  const output={system:[]}; await server["experimental.chat.system.transform"]({sessionID:"ses-a",model:{}},output);
  assert.match(output.system.join("\n"),/prior fact/);
  assert.equal(calls.some(([op])=>op==="coord_publish_snapshot"),true);
  assert.equal(calls.find(([op])=>op==="coord_publish_snapshot")[1].generation,8,"generation continues from durable worker state after restart");
  await server.dispose();
});

test("V1 idle flush checks status, reconciles exact published message and writes once", async t => {
  const { projectDir }=fixture(t); const written=[]; let published;
  const {writeProjectConfig}=await import("../index.js");writeProjectConfig(projectDir,{enabled:true});
  const messages=[{info:{id:"m1",sessionID:"s",role:"user"},parts:[{type:"text",text:"hello"}]}];
  const client={session:{status:async()=>({data:{},request:{},response:{status:200}}),messages:async()=>({data:messages,request:{},response:{status:200}})}};
  const server=createV1Server({client,directory:projectDir,project:{directory:projectDir,canonical:projectDir},workerCall:async(_p,op,p)=>{if(op==="coord_get_snapshot")return published;if(op==="coord_claim_snapshot")return {claimed:true};if(op==="coord_publish_snapshot"){published={...p,claimed:false};return {published:true};}if(op==="recall")return [];if(op==="remember_turn")written.push(p);return {};}});
  await server["chat.message"]({sessionID:"s",messageID:"m1"},{message:{role:"user"},parts:[{type:"text",text:"hello"}]});
  await server.event({event:{id:"e",type:"session.idle",properties:{sessionID:"s"}}});
  assert.equal(written.length,1); assert.equal(written[0].messageID,"m1"); await server.dispose();
});

test("V1 flush releases its exact claim after write error so idle retry can reclaim", async t => {
  const {projectDir}=fixture(t);const {writeProjectConfig}=await import("../index.js");writeProjectConfig(projectDir,{enabled:true});
  const messages=[{info:{id:"retry-msg",role:"user"},parts:[{type:"text",text:"retry me"}]}];let snapshot,claimed=false,writes=0,releases=0;
  const client={session:{status:async()=>({}),messages:async()=>messages}};
  const server=createV1Server({client,directory:projectDir,project:{directory:projectDir,canonical:projectDir},workerCall:async(_p,op,p)=>{
    if(op==="recall")return [];
    if(op==="coord_get_snapshot")return snapshot && {...snapshot};
    if(op==="coord_publish_snapshot"){snapshot={...p,claimed:false};return {published:true};}
    if(op==="coord_claim_snapshot"){if(claimed)return {claimed:false};claimed=true;snapshot.claimed=true;return {claimed:true};}
    if(op==="coord_release_snapshot"){releases++;claimed=false;snapshot.claimed=false;return {released:true};}
    if(op==="remember_turn"){writes++;if(writes===1)throw new Error("temporary worker failure");return {id:"ok"};}
    return {};
  }});
  await server["chat.message"]({sessionID:"retry-session",messageID:"retry-msg"},{message:{role:"user"},parts:[{type:"text",text:"retry me"}]});
  await assert.rejects(server.event({event:{type:"session.idle",properties:{sessionID:"retry-session"}}}),/temporary worker failure/);
  assert.equal(releases,1);
  await server.event({event:{type:"session.idle",properties:{sessionID:"retry-session"}}});
  assert.equal(writes,2);await server.dispose();
});

test("successful claims release for repeat idle events; transition serializes behind in-flight flush", async t => {
  const {projectDir}=fixture(t);const {writeProjectConfig,getProject}=await import("../index.js");writeProjectConfig(projectDir,{enabled:true});
  const messages=[{info:{id:"serial-user",role:"user"},parts:[{type:"text",text:"once"}]}];let snapshot,claimed=false,writes=0,releaseWrite,startWrite;
  const writeStarted=new Promise(resolve=>{startWrite=resolve;});
  const client={session:{status:async()=>({}),messages:async()=>messages,list:async()=>({data:[{id:"serial-session"}]})}};
  const server=createV1Server({client,directory:projectDir,project:{directory:projectDir,canonical:projectDir},pollMs:100000,workerCall:async(_p,op,p)=>{
    if(op==="recall")return [];
    if(op==="coord_get_snapshot")return snapshot&&{...snapshot};
    if(op==="coord_publish_snapshot"){snapshot={...p,claimed:false};return {published:true};}
    if(op==="coord_claim_snapshot"){if(claimed)return {claimed:false};claimed=true;snapshot.claimed=true;return {claimed:true};}
    if(op==="coord_release_snapshot"){claimed=false;snapshot.claimed=false;return {released:true};}
    if(op==="remember_turn"){writes++;startWrite();await new Promise(resolve=>{releaseWrite=resolve;});return {id:"stable"};}
    return {};
  }});
  await server["chat.message"]({sessionID:"serial-session",messageID:"serial-user"},{message:{role:"user"},parts:[{type:"text",text:"once"}]});
  const idle=server.event({event:{type:"session.idle",properties:{sessionID:"serial-session"}}});
  await writeStarted;
  const transition=server.transition("global");
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(getProject({location:{directory:projectDir,project:{canonical:projectDir}}}).writeMode,"project","transition waits for active flush");
  releaseWrite();await idle;await transition;
  await server.event({event:{type:"session.idle",properties:{sessionID:"serial-session"}}});
  assert.equal(writes,1,"ledger/cursor suppress repeat write after released claim");
  assert.equal(getProject({location:{directory:projectDir,project:{canonical:projectDir}}}).writeMode,"global");
  await server.dispose();
});

test("V1 message list reaching its cap fails closed before claim/write", async t => {
  const {projectDir}=fixture(t);const {writeProjectConfig}=await import("../index.js");writeProjectConfig(projectDir,{enabled:true});let claimed=0,written=0;
  const client={session:{status:async()=>({}),messages:async()=>Array.from({length:1000},(_,i)=>({info:{id:`m${i}`,role:"user"},parts:[{type:"text",text:"x"}]}))}};
  const server=createV1Server({client,directory:projectDir,project:{canonical:projectDir,directory:projectDir},workerCall:async(_p,op)=>{if(op==="coord_get_snapshot")return {generation:1,fingerprint:"f",claimed:false,payload:{messageID:"m999",text:"x",configFingerprint:"unused"}};if(op==="coord_claim_snapshot")claimed++;if(op==="remember_turn")written++;return {claimed:true};}});
  await assert.rejects(server.event({event:{type:"session.idle",properties:{sessionID:"s"}}}),/completeness cannot be proven/);
  assert.equal(claimed,0);assert.equal(written,0);await server.dispose();
});

test("V1 missing status entries mean idle, but null status fails closed", async t => {
  const {projectDir}=fixture(t);let status={};const client={session:{status:async()=>status,messages:async()=>[]}};
  const server=createV1Server({client,directory:projectDir,project:{canonical:projectDir,directory:projectDir},workerCall:async(_p,op)=>op==="coord_get_snapshot"?null:{}});
  assert.equal(await server.event({event:{type:"session.idle",properties:{sessionID:"idle-session"}}}),undefined);
  status=null;
  // Disabled projects return before querying status; enable to exercise the null-map guard.
  const {writeProjectConfig}=await import("../index.js");writeProjectConfig(projectDir,{enabled:true});
  await assert.rejects(server.event({event:{type:"session.idle",properties:{sessionID:"uncertain"}}}),/status is not confirmed idle/);
  await server.dispose();
});

test("TUI without session route or state.path directory never enqueues a request", async t => {
  fixture(t);let commands;const notices=[];let enqueues=0;
  const api={route:{current:{params:{}}},state:{path:{}},ui:{toast:x=>notices.push(x)},command:{register:cb=>{commands=cb();return()=>{}}}};
  const tui=createV1Tui({api,workerCall:async(_project,op)=>{if(op==="coord_enqueue_request")enqueues++;return null;}});
  await commands[0].onSelect();assert.equal(enqueues,0);assert.match(notices[0].message,/Open a session/);await tui.dispose();
});

test("TUI applies the request deadline even when enqueue does not return", async t => {
  const {projectDir}=fixture(t);const notices=[];let commands;
  const api={route:{current:{params:{sessionID:"s"}},},state:{path:{directory:projectDir}},ui:{toast:x=>notices.push(x)},command:{register:cb=>{commands=cb();return()=>{}}}};
  const tui=createV1Tui({api,deadlineMs:10,workerCall:async()=>new Promise(()=>{})});
  await commands.find(command=>command.slash?.name==="mnemosyne-status").onSelect();
  assert.match(notices.at(-1).message,/deadline|timed out/i);await tui.dispose();
});

test("TUI uses V1 register callback, DialogPrompt input, and state.path project identity", async t => {
  const { projectDir }=fixture(t); const seen=[]; let commands,promptProps; const requests=[];
  const stack={replace:render=>{promptProps=render();},clear:()=>{}};
  const api={route:{current:{name:"session",params:{sessionID:"s"}},},state:{path:{directory:projectDir}},ui:{toast:x=>seen.push(x),dialog:stack,DialogPrompt:props=>(promptProps=props)},command:{register:cb=>{commands=cb();return()=>{}}}};
  const tui=createV1Tui({api,workerCall:async(project,op,p)=>{requests.push({project,op,p});if(op==="coord_enqueue_request")return {status:"pending"}; if(op==="coord_request_status")return {status:"complete",result:{message:"enabled"}}; throw Error(op);},now:(()=>{let n=0;return()=>n+=1;})()});
   assert.ok(Array.isArray(commands)); assert.ok(commands.some(command=>command.slash?.name==="mnemosyne-on"));
   await commands.find(command=>command.slash?.name==="mnemosyne-on").onSelect(stack);
   assert.equal(seen.at(-1).message,"enabled"); assert.equal(requests[0].project.directory,projectDir); assert.equal(requests[0].p.project,projectDir);
   await commands.find(command=>command.slash?.name==="mnemosyne-import-hindsight").onSelect(stack);
   assert.equal(promptProps.title,"Import Hindsight");
   let previous=requests.length;promptProps.onConfirm(" ");assert.equal(requests.length,previous,"blank import input is rejected");
   await commands.find(command=>command.slash?.name==="mnemosyne-import-hindsight").onSelect(stack);await promptProps.onConfirm("./an export.json");
   assert.deepEqual(requests.at(-2).p.payload,{action:"import",args:["hindsight","./an export.json"],sessionID:"s"});
   await commands.find(command=>command.slash?.name==="mnemosyne-invalidate").onSelect(stack);
   assert.equal(promptProps.title,"Invalidate memory");previous=requests.length;promptProps.onConfirm("0");assert.equal(requests.length,previous,"invalid index is rejected");
   await commands.find(command=>command.slash?.name==="mnemosyne-invalidate").onSelect(stack);await promptProps.onConfirm("2");assert.deepEqual(requests.at(-2).p.payload,{action:"invalidate",args:["2"],sessionID:"s"});
   await commands.find(command=>command.slash?.name==="mnemosyne-backup").onSelect(stack);await promptProps.onConfirm("/tmp/archive dir");assert.deepEqual(requests.at(-2).p.payload,{action:"backup",args:["/tmp/archive dir"],sessionID:"s"});
   await commands.find(command=>command.slash?.name==="mnemosyne-verify-full").onSelect(stack);assert.deepEqual(requests.at(-2).p.payload,{action:"verify",args:["--full"],sessionID:"s"});
   await commands.find(command=>command.slash?.name==="mnemosyne-global-on").onSelect(stack);assert.equal(requests.at(-2).p.kind,"mode");assert.equal(requests.at(-2).p.payload.mode,"global");
   for(const action of ["stats","confirm","file","embedded","backup","verify","verify-full"]) assert.ok(commands.some(command=>command.slash?.name===`mnemosyne-${action}`));
   await tui.dispose();
});

test("V1 sleep is unsupported without backend side effects", async t => {
  const {projectDir}=fixture(t); const calls=[], notices=[]; let commands;
  const api={route:{current:{params:{sessionID:"s"}}},state:{path:{directory:projectDir}},ui:{toast:x=>notices.push(x)},command:{register:cb=>{commands=cb();return()=>{}}}};
  const tui=createV1Tui({api,workerCall:async(_p,op,p)=>{calls.push(op);if(op==="coord_request_status")return {status:"complete",result:{message:"Sleep is unsupported on OpenCode V1; no memory was written."}};return {status:"pending"};}});
    await commands.find(command=>command.slash?.name==="mnemosyne-sleep").onSelect(); assert.equal(calls.includes("sleep_preview"),false);assert.match(notices.at(-1).message,/unsupported/);await tui.dispose();
});

test("V1 global mode transition fails closed on incomplete inventory", async t => {
  const {projectDir}=fixture(t); let writes=0;
  const client={session:{list:async()=>({data:Array(100).fill({id:"s"})}),status:async()=>({s:{type:"idle"}})}};
  const server=createV1Server({client,directory:projectDir,project:{directory:projectDir,canonical:projectDir},workerCall:async()=>{writes++;return null;}});
  await assert.rejects(server.transition("global"),/inventory|idle/);
  assert.equal(writes,0);await server.dispose();
});

test("V1 mode and config drains ignore historical sessions without snapshots", async t => {
  const {projectDir}=fixture(t);const {writeProjectConfig,getProject}=await import("../index.js");writeProjectConfig(projectDir,{enabled:true,globalBank:true});
  const client={session:{list:async()=>({data:[{id:"legacy-session"}]}),status:async()=>({})}};
  const server=createV1Server({client,directory:projectDir,project:{directory:projectDir,canonical:projectDir},pollMs:100000,workerCall:async(_p,op)=>op==="coord_get_snapshot"?null:{}});
  await server.transition("global");
  assert.equal(getProject({location:{directory:projectDir,project:{canonical:projectDir}}}).writeMode,"global");
  await server.dispose();
});

test("V1 published invalid snapshot still blocks mode and config drains", async t => {
  const {projectDir}=fixture(t);const {writeProjectConfig}=await import("../index.js");writeProjectConfig(projectDir,{enabled:true,globalBank:true});
  const client={session:{list:async()=>({data:[{id:"managed-session"}]}),status:async()=>({}),messages:async()=>[]}};
  const server=createV1Server({client,directory:projectDir,project:{directory:projectDir,canonical:projectDir},pollMs:100000,workerCall:async(_p,op)=>op==="coord_get_snapshot"?{generation:1,fingerprint:"stale",claimed:false,payload:{messageID:"missing",text:"x",configFingerprint:"wrong"}}:{}});
  await assert.rejects(server.transition("global"),/no verified snapshot/);
  await server.dispose();
});

function requestHarness(t, projectDir, { snapshot, sessions = [], messages = [], cli = false } = {}) {
  const calls=[];let nextRequest,finished;
  if(cli)process.env.MNEMOSYNE_BIN="/bin/echo";
  const client={session:{list:async()=>({data:sessions}),status:async()=>({}),messages:async()=>messages}};
  const server=createV1Server({client,directory:projectDir,project:{directory:projectDir,canonical:projectDir},pollMs:100000,workerCall:async(project,operation,payload)=>{
    calls.push({project,operation,payload});
    if(operation==="coord_claim_next"){const result=nextRequest;nextRequest=undefined;return result;}
    if(operation==="coord_finish_request"){finished=payload;return {finished:true};}
    if(operation==="coord_get_snapshot")return snapshot;
    if(operation==="stats")return {beam:{working_memory:{total:2},episodic_memory:{total:1},triples:{total:0}},total_memories:3};
    if(operation==="invalidate")return true;
    return {};
  }});
  const dispatch=async(action,args=[])=>{
    const project=(await import("../index.js")).getProject({location:{directory:projectDir,project:{canonical:projectDir}}});
    nextRequest={operation_id:`op-${Date.now()}-${Math.random()}`,project:projectDir,session:"s",kind:"command",fingerprint:(await import("../index.js")).configFingerprint(project),payload:{action,args,sessionID:"s"}};
    finished=undefined;await server.processRequests();return finished;
  };
  t.after(async()=>{await server.dispose();delete process.env.MNEMOSYNE_BIN;});
  return {server,calls,dispatch,get finished(){return finished;}};
}

test("V1 request poll treats an empty claim as no request", async t => {
  const {projectDir}=fixture(t);const operations=[];
  const server=createV1Server({client:{session:{}},directory:projectDir,project:{directory:projectDir,canonical:projectDir},pollMs:100000,workerCall:async(_project,operation)=>{operations.push(operation);return null;}});
  await server.processRequests();
  assert.deepEqual(operations, ["coord_heartbeat", "coord_claim_next"]);
  await server.dispose();
});

test("V1 stats, backup, verify, and import command paths use worker/CLI only on valid requests", async t => {
  const {projectDir}=fixture(t);const h=requestHarness(t,projectDir,{cli:true});
  const stats=await h.dispatch("stats");assert.equal(stats.status,"complete");assert.equal(h.calls.filter(x=>x.operation==="stats").length,2);
  const backup=await h.dispatch("backup",["/tmp/safe backup"]);assert.match(backup.result.message,/backup/);assert.match(backup.result.message,/safe backup/);
  const verify=await h.dispatch("verify",["--full"]);assert.match(verify.result.message,/verify/);assert.doesNotMatch(verify.result.message,/--quick/);
  const missing=await h.dispatch("import",["hindsight"]);assert.match(missing.result.message,/needs a file path/);
  const extra=await h.dispatch("verify",["--full","--unsafe"]);assert.equal(extra.status,"failed");
  const imported=await h.dispatch("import",["hindsight","./source.json"]);assert.match(imported.result.message,/import-hindsight/);assert.match(imported.result.message,/source.json/);
});

test("V1 backend selection drains legacy sessions without snapshots", async t => {
  const {projectDir}=fixture(t);const {writeProjectConfig,getProject}=await import("../index.js");
  writeProjectConfig(projectDir,{enabled:true});
  const h=requestHarness(t,projectDir,{sessions:[{id:"legacy-session"}]});
  const result=await h.dispatch("file");
  assert.equal(result.status,"complete");
  assert.equal(getProject({location:{directory:projectDir,project:{canonical:projectDir}}}).backend,"mnemosyne-file");
});

test("V1 backend selection writes project config after safe drain; invalidation fails closed and confirms global", async t => {
  const {projectDir}=fixture(t);const {writeProjectConfig,configFingerprint,getProject}=await import("../index.js");
  writeProjectConfig(projectDir,{enabled:true});
  const message=[{info:{id:"u1",role:"user"},parts:[{type:"text",text:"question"}]}];
  const project=getProject({location:{directory:projectDir,project:{canonical:projectDir}}});
  const snap={generation:4,fingerprint:"snapshot-fp",claimed:true,payload:{messageID:"u1",text:"question",injected:true,configFingerprint:configFingerprint(project),results:[{id:"project-id",bank:project.bank,content:"project"},{id:"global-id",bank:"opencode_global",content:"shared"}]}};
  const h=requestHarness(t,projectDir,{snapshot:snap,sessions:[],messages:message});
  const missing=await h.dispatch("invalidate");assert.equal(missing.status,"failed");
  const invalidIndex=await h.dispatch("invalidate",["99"]);assert.equal(invalidIndex.status,"failed");
  const projectInvalidation=await h.dispatch("invalidate",["1"]);assert.equal(projectInvalidation.status,"complete");
  assert.equal(h.calls.filter(x=>x.operation==="invalidate").at(-1).payload.memory_id,"project-id");
  const globalSelection=await h.dispatch("invalidate",["2"]);assert.equal(globalSelection.status,"complete");assert.match(globalSelection.result.message,/mnemosyne-confirm/);
  const confirmed=await h.dispatch("confirm");assert.equal(confirmed.status,"complete");assert.equal(h.calls.filter(x=>x.operation==="invalidate").at(-1).payload.memory_id,"global-id");
  await h.dispatch("file");assert.equal(getProject({location:{directory:projectDir,project:{canonical:projectDir}}}).backend,"mnemosyne-file");
  await h.dispatch("embedded");assert.equal(getProject({location:{directory:projectDir,project:{canonical:projectDir}}}).backend,"mnemosyne-embedded");
});

test("V1 global invalidation confirmation is discarded after config or snapshot changes", async t => {
  const {projectDir}=fixture(t);const {writeProjectConfig,configFingerprint,getProject}=await import("../index.js");writeProjectConfig(projectDir,{enabled:true});
  const message=[{info:{id:"u1",role:"user"},parts:[{type:"text",text:"question"}]}];const project=getProject({location:{directory:projectDir,project:{canonical:projectDir}}});
  const snap={generation:1,fingerprint:"fp",claimed:true,payload:{messageID:"u1",text:"question",injected:true,configFingerprint:configFingerprint(project),results:[{id:"g1",bank:"opencode_global",content:"shared"}]}};
  const h=requestHarness(t,projectDir,{snapshot:snap,messages:message});
  await h.dispatch("invalidate",["1"]);
  writeProjectConfig(projectDir,{globalBank:false});
  const result=await h.dispatch("confirm");assert.equal(result.status,"failed");assert.equal(h.calls.filter(x=>x.operation==="invalidate").length,0);
});

test("V1 refuses invalidation when the injected snapshot is unavailable", async t => {
  const {projectDir}=fixture(t);const h=requestHarness(t,projectDir,{messages:[{info:{id:"m",role:"user"},parts:[{type:"text",text:"turn"}]}]});
  // Harness has no snapshot, so selection cannot be authorized from a recall result.
  const result=await h.dispatch("invalidate",["1"]);assert.equal(result.status,"failed");assert.equal(h.calls.some(call=>call.operation==="invalidate"),false);
});
