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

**3. Corrections are manual; the plugin does not detect contradictions.**
State the new value clearly, then invalidate an obsolete memory from the current
injected snapshot:

```
/mnemosyne invalidate 2
```

The number refers to the numbered memory in the current prompt's injected block. A
project memory is invalidated immediately. A shared-bank memory first shows a preview
and requires `/mnemosyne confirm`; confirmation is one-time and becomes stale after a
new prompt or relevant configuration change. The new value is stored through normal
write-back when the session goes idle, but the plugin does not infer that it contradicts
the old one.

A bare repetition of the new value does not invalidate the old row. If you do not
manually invalidate it, both may remain and compete during retrieval.

**4. Say what kind of fact it is when it matters.**
The plugin stores everything with the same importance (0.7) and no expiry. A durable
preference ("answer in Dutch") and a volatile value ("the deploy runs on port 8080")
are treated identically, which means an old port number can outrank a current one.
Retrieval applies a fixed recency boost of up to 5% with a 30-day half-life, separately
in each bank. Missing or unusable timestamps get no boost. It does not expire or filter
old memories. Manual invalidation is the way to remove a known-obsolete injected memory.

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
| No automatic contradiction detection or updates | you must identify and invalidate obsolete injected memories yourself |
| No per-type expiry | a fixed recency boost can help recent memories rank higher, but old rows remain eligible for recall |
| No consolidation command or automatic `sleep` | `episodic_memory` stays empty; there is no summarised layer, and phase 4 is deferred |
| No secrets handling | memories are stored as plain text in a local SQLite file. Do not paste credentials into a prompt |

Manual invalidation is available through `/mnemosyne invalidate <n>`; shared-bank
memories require preview and confirmation. Automatic contradiction detection and
per-type decay remain unimplemented. Shared cross-project memory is available through
the global bank. The lack of consolidation is currently intentional, not an automatic
background action.

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
then degrade below a no-memory baseline. The plugin does not currently expose a `sleep`
command, and it never consolidates automatically.
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
