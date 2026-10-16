# Working with Mnemosyne memory in OpenCode

Companion to the [plugin README](../plugins/mnemosyne-opencode/README.md). Read this
if you have never worked with agent memory before. It covers what the plugin does,
how to work with it, and what it deliberately does not do.

## What it does

Once enabled for a project, the plugin runs without any further action from you:

- **Recall.** Before each of your prompts, it searches the project bank first and can
  add one non-duplicate result from the shared bank, within the configured recall limit.
  Results are wrapped in a `<mnemosyne_memory>` block.
- **Write-back.** When a session goes idle, new user and assistant turns are stored in
  the configured bank. Tool output is not stored. Injected memories are not stored back.
- `/mnemosyne global on` switches new writes to the shared `opencode_global` bank;
  `/mnemosyne global off` returns to project writes. Pending turns are flushed before
  switching. Setting `globalBank: false` disables both shared-bank recall and writes.

You never call remember or recall yourself. The model does not decide what to store.

## Five rules for working with it

**1. Enable once per project.**
```
/mnemosyne
/mnemosyne file
/mnemosyne on
```
Do this once. From then on it is automatic. `/mnemosyne on` writes the `mnemosyne`
block in the project's `opencode.jsonc`; it touches only that block and leaves
comments and other settings alone.

**2. Do not repeat yourself. The plugin already writes it down.**
Every turn you type is stored. Repeating a decision because you assume it was lost
creates duplicate rows that compete with the original during retrieval.

**3. Corrections are the hard part, and you have to be explicit.**
Nothing in the plugin updates or invalidates an existing memory. If a value changes,
the old and the new row both stay, and ranking decides which one the model sees. So
state the correction as a correction:

> "From now on the port is 9090, not 8080."

A bare repetition of the new value may lose against the higher-ranked old row.
This is the single most important thing to know. See "planned" below.

**4. Say what kind of fact it is when it matters.**
The plugin stores everything with the same importance (0.7) and no expiry. A durable
preference ("answer in Dutch") and a volatile value ("the deploy runs on port 8080")
are treated identically, which means an old port number can outrank a current one.
Marking volatile facts in your prompt text is currently the only lever you have.

**5. When something is wrong, ask the plugin.**
```
/mnemosyne status     # backend, enabled, bank, last error
/mnemosyne stats      # counters per memory tier
/mnemosyne backup     # compressed .db.gz before anything risky
```
`last_error` in `status` is the only place recall failures surface. They are logged
but never shown to you otherwise.

Stats show working-memory (including consolidated and unconsolidated), episodic-memory,
vector, and triple counts for the project bank, followed by `opencode_global` when
`globalBank` is enabled. Global stats failures leave the project report visible; project
stats failures stop the command. Mnemosyne 3.15.1 stats apply to the worker instance's
database. The legacy `total_memories` count is shown separately, not as a BEAM fact
count; the `banks` field is only a directory listing, not counts per bank.

## What it deliberately does not do

| Not supported | Why it matters to you |
|---|---|
| No updating or invalidation | old and new values compete; you cannot rely on "latest wins" |
| No consolidation | `episodic_memory` stays empty; there is no summarised layer |
| No secrets handling | memories are stored as plain text in a local SQLite file. Do not paste credentials into a prompt |

Updating/invalidation is specified in the [PRD](PRD-memory-lifecycle.md) and remains
planned for phase 5. Shared cross-project memory is available through the global bank.
The lack of consolidation is a deliberate choice, not a defect.

## Why it is built this way

Stated briefly, with sources in the PRD.

**Recall is a ranking problem, not a storage problem.** The plugin stores raw turns and
retrieves by hybrid score: 0.5 dense vector, 0.3 full-text, 0.2 importance, plus a
recency boost. That is why the `embedded` backend finds a memory when you phrase the
question differently than the fact was stored, and the `file` backend does not.

**Staleness is the known weakness, not an oversight.** Every stored row is equally
persistent, so retrieved context accumulates outdated facts. This is a documented
failure mode of agent memory in general, not specific to this plugin.

**Two claims this plugin previously made were wrong, and are corrected here.**
Consolidation (`sleep`) was presented as an obvious win. The literature does not
support making it automatic: continuously consolidated memories rise in usefulness and
then degrade below a no-memory baseline. It is a command you run deliberately now.
Separately, the `persona` tier looked like a clean route for global memory; in version
3.15.1 it has no callers, and the flat-profile pattern it uses is a known source of
invalid persona state.

## Where to look next

| Question | File |
|---|---|
| What exactly was decided, and what is built next | [PRD](PRD-memory-lifecycle.md) |
| Measurements: bank contents, ranking, latency | `~/projects/opencode-agents/research/2026-10-16-mnemosyne-plugin-memory-lifecycle.md` |
| Literature behind the consolidation and staleness calls | `~/projects/opencode-agents/research/2026-10-16-persona-laag-en-agent-memory-literatuur.md` |
| Command reference and configuration | [plugin README](../plugins/mnemosyne-opencode/README.md) |
