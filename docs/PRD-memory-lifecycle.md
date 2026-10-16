# PRD — Memory lifecycle and configuration of the Mnemosyne OpenCode plugin

Status: **all design questions answered; implementation ready** · Version 1.2 · 16 October 2026 · Author: Chris Engelhard

Every open design question has been answered (§8). Two earlier recommendations of mine were withdrawn after research (§11.2, §12.2). This document was translated from Dutch on 16 October 2026; the Dutch original is preserved in the private archive repository `digi4care/mnemosyne-opencode-research-history`.

---

## 0. Summary

Four questions, four answers:

| # | Question | Answer | Size |
|---|---|---|---|
| 1 | Configuration | The plugin has **no** config file and never reads `opencode.jsonc` | medium |
| 2 | Staleness | The plugin does **nothing** about keeping memories current | medium |
| 3 | Tiers and backends | File versus embedded differs only in ranking, not in storage | small, mostly documentation |
| 4 | Global memory | Every project is its own bank, so personal facts must be repeated per project | small code, high value |

The two real gaps are **1** and **2**. Question 3 is largely a documentation problem. Question 4 is small in code but painful in daily use.

A fifth issue surfaced during research and is now the most important one: **the plugin stores raw conversation turns, not facts.** That single fact shapes most of §4.

---

## 1. Problem statement

The plugin does exactly what its README says: per project, it stores memory automatically and reads it back. What the README does **not** say, and what the code shows:

- There is no way to configure anything except through `/mnemosyne` commands.
- Nothing ever marks a memory as outdated, corrects it, or expires it.
- There is no shared memory; everything is isolated per project bank.
- Mnemosyne has a consolidation mechanism that is never invoked.

The practical result: the plugin remembers a great deal, but nothing it remembers is ever updated. That is a refrigerator, not a memory.

---

## 2. Evidence

Measurements are in `~/projects/opencode-agents/research/2026-10-16-mnemosyne-plugin-memory-lifecycle.md`. Core facts:

| Fact | Source |
|---|---|
| No call to `update`, `invalidate`, `sleep` or `reindex` | `index.js` lines 404–463 |
| Every memory: `importance=0.7`, `scope=global`, no `valid_until` | `memory_worker.py` lines 47–58 |
| Bank is per project: `opencode_<hash>` | `index.js` lines 56–60 |
| Project bank: 225 working memories, **0 episodic**, 89 embeddings | SQLite inspection, 16 October |
| `auto_sleep_enabled: true`, but the plugin never calls `sleep` | `config.yaml` plus source |
| `llm_enabled: false` → no extraction, no conflict detection | `config.yaml` |

Two further facts were verified while writing §4:

- **Metadata does not survive `recall`.** A memory stored with `metadata={"perishability": 0.2}` comes back from `recall()` without a `metadata` key at all. It does survive `get(memory_id)`.
- **The bank grows on its own.** 186 rows in the morning, 225 in the evening of the same day, all with `source: opencode`. Write-back is actively running.

**Explicitly not verified**, and therefore not to be treated as fact:
- whether `wm_ttl_hours` actually removes rows;
- whether `config.yaml` or env vars win (indirect evidence says env vars);
- what `sleep` actually produces;
- whether the `memory_worker.py` recall payload is the full row.

---

## 3. Question 1 — Configuration

### Problem
The plugin has three configuration sources that cannot talk to each other: `projects.json` (runtime state, written by the plugin), env vars (injected per backend), and Mnemosyne's own `config.yaml` (which the plugin never reads). Everything the user wants to set has to be edited into `projects.json` by hand, and most users do not know that file exists.

Extra pain: configuration and runtime state live in the same file. A corrupt `projects.json` can therefore overwrite your settings.

### Options considered

**A. Change nothing.** Current situation.
**B. `mnemosyne` block in `opencode.jsonc`.** Global and per project.
**C. Own `mnemosyne.json` in the storage tree.** A third location next to OpenCode's own config.
**D. Configuration via `/mnemosyne set`.** Not inspectable, not reviewable in git.

### Decision D1 — option B
```jsonc
"mnemosyne": {
  "backend": "mnemosyne-file",
  "recallLimit": 4,
  "enabled": false,
  "globalBank": true
}
```
With a hard separation: `opencode.jsonc` is what the user wants; `projects.json` is what happened. On startup the plugin takes **configuration** from `opencode.jsonc` and takes only `enabled`, `lastError` and `updatedAt` from `projects.json`. If an `opencode.jsonc` has a `mnemosyne` block, that wins; otherwise the current state is the fallback.

---

## 4. Question 2 — Staleness

### Problem
Every stored row is permanently valid. If a value changed in May and you repeat the new value today, both rows exist, and ranking decides which one the model sees rather than which one is true. With four memories injected per prompt, an old row can plausibly outrank a new one.

Mnemosyne ships the machinery. The plugin uses none of it:

| Mechanism | Status in our plugin |
|---|---|
| `sleep` (consolidation, working → episodic) | never invoked |
| `valid_until` per memory | never set |
| `invalidate` / `superseded_by` | never used |
| `wm_ttl_hours` | not set by us; behaviour unknown |
| conflict detection via LLM | off, `llm_enabled: false` |

### The root problem: the memory unit is wrong

Per-type decay assumes a memory **is a fact**. It is not. The plugin stores a raw conversation turn. A single stored turn can contain "the deploy runs on port 8080" and "answer me in Dutch" side by side. Assigning a type to such a block is not meaningful, which is why the original specification of decay was not implementable.

### Decision D6 — corrections first, decay second

At write-back time the plugin already knows which memories it injected into the system context for that session: `recallBySession` holds them. That is four candidates, not 225.

So: when a new turn contradicts one of the four injected memories, invalidate that one. Narrow, tractable, and it uses infrastructure that already exists. Decay then becomes preventive rather than corrective, and only afterwards is it worth building.

### Decision D3 — per-type decay, after the correction path

Two decisions that were open at the start of this round:

- **How is the type determined?** Not now. First the correction path. Afterwards: only short declarative turns get classified; long turns get no decay. LLM classification is excluded (network dependency in the write path). Pattern matching over raw turns is untestable.
- **Where does the coefficient live?** In `metadata`, because it survives `get()`. An own table is months of work for a value read four times per prompt. Cost: four extra SQLite point reads per prompt.
- **What about the 225 existing memories?** They are not discarded. They are real content, not a test fixture, and throwing them away is not an upgrade. They stay in their project bank.

### The design decision still deferred

Recognising a contradiction is an LLM step.

- **LLM on**: good conflict detection, but a network dependency in the write path, which was exactly what this plugin was built to avoid.
- **LLM off, heuristic**: no extra dependency, but false positives mark good memories as outdated.

The correction path (D6) deliberately does **not** resolve this: it narrows the candidate set to four, it does not need to judge them automatically. Automatic judging stays deferred.

---

## 5. Question 3 — working_memory, episodic_memory, file versus embedded

Not a defect but a knowledge gap: the README describes the two backends as if they were two kinds of memory. That is misleading and it misled me too.

Facts:
- Both backends use the **same tables** and the same `recall`.
- File = FTS5 + importance + recency. Embedded = the same plus dense vectors, which take 50% of the ranking.
- In the project bank: 225 working, 0 episodic. The episodic layer is empty. Whether that is a defect is a separate question, and the answer is **no**: `sleep` never runs, and per §11.2 episodic-only retention is the safer state.
- `memory_embeddings`: 89. Embeddings are per stored row, not a property of the backend choice.

The real tiers: `working_memory` (raw turns) → `episodic_memory` (summarised by `sleep`) → `memories`/`facts` (extracted, durable).

### Decision D2 — document, and make tiers visible

`/mnemosyne stats` shows what is in each tier. Small change, and it makes question 2 observable: the tier counts are the measuring point for D3, not for `sleep`.

### Decision — `sleep` becomes an explicit command

See §11.2. `sleep` is never automatic. `episodic_memory = 0` is a legitimate state, not a bug to report.

---

## 6. Question 4 — Global memory, and Mnemosyne versus Hindsight

### The design gap
`scope="global"` sounds cross-project. It is not: it means global **within one bank**. Every project gets its own bank, so personal preferences — language, answer style, commit conventions — must be repeated in each project's bank. That is a real gap, not cosmetics.

### Options considered

**A. Change nothing.**
**B. Shared bank `opencode_global` next to the project bank.**
**C. B plus a `/mnemosyne global on` switch.**
**D. Persona tier.** Rejected, see §11.1.
**E. Per-type decay.** Discussed in §4.

### Decision D4 + D7 — shared bank, driven by a mode switch

Recall consults two banks: the project bank and `opencode_global`. The project bank always wins; global results are damped.

Write-back follows a **mode**, not a per-message marker:

```
/mnemosyne global on      everything you type from now on goes to the global bank
/mnemosyne global off     back to the project bank
```

Why a mode and not the other two options:

- **Not per-message marking.** The plugin promises automatic memory. A marker you have to type makes that promise untrue.
- **Not automatic detection.** The plugin would have to classify raw turns, which §4 shows is not meaningful.

The honest cost of a mode: everything typed while it is on goes to the global bank, including project details. It is reversible with the same command, and it costs zero effort per message.

### Mnemosyne versus Hindsight

Correction first, because it matters: the 422 Hindsight documents were raw conversation transcripts with zero extracted facts. That is **not** evidence that Hindsight is poor. We configured it that way ourselves (`retain_extraction_mode: "chunks"`, observations disabled). It is a configuration observation, not a product verdict. I had stated it too strongly earlier.

What was actually observed:

| | Mnemosyne | Hindsight |
|---|---|---|
| Form | local SQLite, optional Ollama | HTTP service in a container |
| Cost per recall | ~0.08 s, no money | network + container + 3.5 GB volume |
| Lifecycle machinery | `sleep`, tiers, TTL, persona | not used by us |
| Sharing between agents | via export/sync | inherent, one shared service |
| Extra maintenance | none | container, volume, backups, versions |

**Recommendation: stay with Mnemosyne.** Not because Hindsight is inferior, but because the three complaints at hand — recall quality, staleness, global memory — all already exist inside Mnemosyne and are simply not wired up. Switching vendors does not buy them; it buys them again, in a different shape, without the three.

My answer to "is this the right vendor": the difference is not the database, it is whether someone wires up the lifecycle. We have not done that. That is our work, not their product.

---

## 7. Implementation order

| # | What | Depends on | Estimate |
|---|---|---|---|
| 1 | Separate config (`opencode.jsonc`) from state (`projects.json`) | — | 1 day |
| 2 | Shared global bank plus mode switch | 1 | 0.5 day |
| 3 | `/mnemosyne stats` per tier | — | 2 h |
| 4 | `/mnemosyne sleep` as an **explicit** command, no auto-trigger | 3 | 2 h |
| 5 | Correction path: invalidate a contradicted injected memory | 3 | 1 day |
| 6 | Per-type decay (D3) | 5 | 3 days |
| 7 | Automatic contradiction detection | 6, plus the LLM decision | deferred |

Items 1, 2 and 3 can be built separately but not in arbitrary order: item 1 adds `globalBank` and `recallLimit` to the config, item 2 uses `globalBank`, item 3 shows the outcome of item 2 in `/mnemosyne stats`. The order 1 → 2 → 3 is therefore real. Items 4, 5 and 6 all want item 3 first so their effect is measurable. Item 7 is deliberately deferred.

**Item 5 changed the plan.** Decay used to be item 5. It is now item 6, behind the correction path, because decay without correction leaves the actively wrong memory in place, merely ranked lower.

### Documentation as a deliverable

One user-facing document: **`docs/working-with-memory.md`**.

Audience: a developer who can read OpenCode and code, but has never worked with agent memory. Length: compact, one to two pages. Content: what the plugin does, five rules for working with it, what it deliberately does not do, and briefly why it is built this way.

The README links to it with a **relative markdown link**, not a symlink. A symlink with an absolute path breaks once the package is on npm, and a symlink to a path outside the repository does not work for other users at all.

That document describes only what is **shipped**. Planned features are not presented as existing, and where a rule changes through D1–D7 the document must change with it.

---

## 8. Decisions

| # | Question | Decision | Status |
|---|---|---|---|
| D1 | Where does configuration live? | `mnemosyne` block in `opencode.jsonc`, global plus per project | decided 16-10-2026 |
| D2 | `sleep`: automatic or explicit? | **Explicit command**, never automatic | decided 16-10-2026 |
| D3 | Build per-type decay? | **Build**, after the correction path | decided 16-10-2026 |
| D4 | Global memory always on or switchable? | **Switchable per project**, default on | decided 16-10-2026 |
| D5 | Is the persona tier better than a hand-built bank? | **No** — §11.1 | decided 16-10-2026 |
| D6 | Corrections or decay first? | **Corrections first** | decided 16-10-2026 |
| D7 | How is something routed to the global bank? | **A mode switch**, not per-message marking and not automatic detection | decided 16-10-2026 |
| D8 | Language of this document | **Translate in place**; the Dutch original stays in the private archive | decided 16-10-2026 |

### Consequences of the decisions

- **D1** means `projects.json` is no longer configuration. What the user wants comes from `opencode.jsonc`; what happened stays in `projects.json`.
- **D2** means `episodic_memory = 0` is not a bug and no longer has to be reported as one.
- **D3** stores the coefficient in `metadata`, which costs four extra point reads per prompt because `recall` drops metadata.
- **D4 + D7** mean recall touches two banks, and the project bank always wins.
- **D6** means decay is preventive instead of corrective, and that the expensive part of contradiction detection is narrowed to four candidates per prompt rather than postponed entirely.

---

## 9. Out of scope

- Vendor choice. See §6; the recommendation is no change.
- Migrating the 422 Hindsight documents. They remain test material.
- A benchmark campaign between backends. The latency measurement in the research note is sufficient for the choice.
- Cross-backend migration of existing memories.
- Automatic contradiction detection, pending the LLM decision in §4.

## 10. Acceptance criteria for this document

- [x] Persona versus hand-built global bank researched and decided (§11.1)
- [x] D1 through D4 answered (16 October 2026)
- [x] Implementation order approved, with the correction inserted before decay
- [x] Document translated to English
- [ ] Implementation of §7 completed, each item verified separately
- [ ] `docs/working-with-memory.md` updated for every behaviour change from D1–D7

---

## 11. Research results, 16 October 2026

Supporting detail in `~/projects/opencode-agents/research/2026-10-16-persona-laag-en-agent-memory-literatuur.md` (Dutch, internal).

### 11.1 Persona tier: rejected

Two independent reasons.

**Reason 1 — the code is dead in 3.15.1.** `PersonaExtractor`, `PersonaTriggers` and `write_persona_file` have no callers inside the package. The `Mnemosyne` SDK class has no persona method at all. The only thing that reads `persona.md` is a Hermes integration, and our OpenCode plugin does not even inject it.

There is also a design conflict independent of the dead code: the source (`memoria_persona`) is per bank, the target file is global (`~/.hermes/memory/persona.md`). With multiple projects every project bank overwrites the same file.

**Reason 2 — the pattern is criticised in the literature.** arXiv **2608.01708** (PGMem): existing systems *"store personas as flat profiles detached from the events that justify them"*, which causes the **memory-persona validity gap**. Their fix connects persona nodes to events through typed provenance and evidence edges. Mnemosyne's persona approach is exactly the criticised pattern.

**Consequence:** option D is struck. Global memory uses a shared bank (D4, D7).

### 11.2 Consolidation: my earlier advice was too strong, withdrawn

arXiv **2605.12978** ("Useful Memories Become Faulty When Continuously Updated by LLMs"):

- consolidation raises usefulness first, then degrades it below a no-memory baseline;
- consolidating from ground-truth solutions fails on 54% of ARC-AGI problems the model had previously solved without memory;
- an episodic-only control stays competitive with the consolidators tested;
- agents that retain raw episodes double their accuracy against forced consolidation.

**Consequences:** `episodic_memory = 0` is a defensible state rather than a defect. `sleep` becomes an explicit command instead of a step in the write path. This withdraws my earlier "do C now, D later" recommendation, and it is why decay became a separate, later decision (D3) instead of the immediate one.

### 11.3 What is substantiated

| Topic | Finding | Ours |
|---|---|---|
| Staleness | **2608.04746** (ScrubJay-MEM): existing architectures treat all memories as equally persistent and *"systematically contaminate retrieved context with outdated facts"*. The fix is per-memory, type-conditioned perishability (`π_i`), not a single recency penalty. Ablating the decay collapses the GenGap by 5.7×. | becomes D3 |
| Global memory | **2601.21545** (ShardMemo): hard admissibility (scope) must come before relevance ranking, otherwise retrieval budget is wasted. +6.8 F1 on LoCoMo. | confirms D4 |
| File versus embedded | **2602.23368**: agentic keyword search reaches over 90% of RAG metrics without a vector database. Our own measurement: 0.083 s per embedding. | file stays the default |

### 11.4 Name collision, stated explicitly

An arXiv paper called "Mnemosyne" exists (**2510.08601**, *Unsupervised, Human-Inspired Long-Term Memory Architecture for Edge-Based LLMs*, 2025-10-07, healthcare dialogues, edge devices). It is **not** our package: ours is by Abdias J, repo `AxDSan/mnemosyne`. The paper is a name collision and is not evidence for the software being run.

Related: `core/persona.py` in the package refers to a "Hy-Memory PersonaTrigger pattern". Hy-Memory has its own paper (**2610.22196**, 2026-10-15) whose central claim is that the quality of external memory sits in **the write path** — what to retain, how to represent it, how new evidence updates existing state. That is precisely our weakest point, and it points the same way as D6.

---

## 12. Findings from reviewing this document

Six issues found on 16 October 2026. All six are resolved; they are recorded here because a decision document that hides its own corrections is not trustworthy.

**B1 — the status line was false.** It said "ready for implementation" while items were still undecided. Corrected.

**B2 — D3 was not implementable as specified.** Three design decisions were missing: how the type is determined, where the coefficient is stored, and what happens to existing memories. Resolved in §4; the first remains partly deferred on purpose.

**B3 — §4 and §5 contradicted each other.** §5 said the empty episodic layer was caused by `sleep` never running; §4 said that is not a defect. Both cannot be true. Options B and C were still listed as live after being withdrawn, and §5 still referred to the effect of a withdrawn option. All corrected.

**B4 — "automatic" versus "the user marks globals".** §6 originally required a `global` marker on write-back, which contradicts the promise of automatic memory. Resolved by D7: a mode switch, so nothing has to be marked per message.

**B5 — no gate per item.** The order had estimates but no exit criteria. Now each item names its dependency; the verification per item is an acceptance criterion in §10.

**B6 — the independence claim was too strong.** Items 1, 2 and 3 were described as independent, but item 1 adds `globalBank`, item 2 uses it, and item 3 displays its result. The order 1 → 2 → 3 is real.