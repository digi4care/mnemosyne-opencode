# Mnemosyne OpenCode plugin

Automatic project and shared memory for OpenCode, backed by Mnemosyne. Turn it on
once, then keep coding: it saves chat turns and looks for useful past notes when you
start a prompt. You do not need to ask the AI to remember or search for anything.

New to AI memory? Start with the [plain-language guide](https://github.com/digi4care/mnemosyne-opencode/blob/main/docs/working-with-memory.md).
This README is the detailed setup and command reference.

**Backends**
- `mnemosyne-file` — SQLite + FTS, no embeddings (offline, recommended default).
- `mnemosyne-embedded` — adds dense embeddings via Ollama `nomic-embed-text`.

**Commands**

| Command | Action |
|---|---|
| `/mnemosyne` | show help |
| `/mnemosyne on\|off` | enable/disable automatic memory for this project |
| `/mnemosyne global on\|off` | route writes to shared/project bank after flushing pending turns |
| `/mnemosyne sleep` | preview the exact provider prompt; then run `/mnemosyne sleep consent`, review the output, and run `approve` or `reject` |
| `/mnemosyne invalidate <n>` | invalidate a memory from this session's injected snapshot; global memories require confirmation |
| `/mnemosyne confirm` | confirm the pending global-memory invalidation for the same session/snapshot |
| `/mnemosyne status` | backend, enabled, bank, storage, config source, last error |
| `/mnemosyne stats` | per-tier counts for the project bank and (when enabled) shared bank |
| `/mnemosyne file` | Mnemosyne without embeddings |
| `/mnemosyne embedded` | Mnemosyne with Ollama embeddings |
| `/mnemosyne backup [dir]` | write a compressed `.db.gz` backup |
| `/mnemosyne verify` | database integrity check |
| `/mnemosyne import hindsight <src>` | import legacy Hindsight data |

Retrieval retains Mnemosyne's relevance ranking and applies a fixed, bounded
recency boost independently in each bank (up to 5%, 30-day half-life). It never
filters memories by age or changes stored validity fields. Memories without a
usable timestamp receive no age boost. This policy is fixed and is not configurable.

## Configuration

`/mnemosyne stats` reports working-memory total/consolidated/unconsolidated counts,
episodic-memory and vector counts, and triples separately for the project bank and,
when `globalBank` is enabled, `opencode_global`. These are worker-instance database
stats; legacy `total_memories` is shown separately and is not a BEAM fact count.
The returned `banks` listing is not per-bank counts. A global stats error is shown
alongside the project report; a project stats error fails the command.

Configuration lives in an `mnemosyne` block in `opencode.jsonc`, not in the plugin's
state file. Global defaults go in `~/.config/opencode/opencode.jsonc`; per-project
overrides go in the project's own `opencode.jsonc`.

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "mnemosyne": {
    "backend": "mnemosyne-file",
    "recallLimit": 4,
    "enabled": false,
    "globalBank": true,
    "writeMode": "project",
    "sleep": {
      "model": "inherit"
    }
  }
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | memory on for this project |
| `backend` | string | `mnemosyne-file` | `mnemosyne-file` or `mnemosyne-embedded` |
| `recallLimit` | integer 1–20 | `4` | memories injected per prompt |
| `globalBank` | boolean | `true` | master switch for shared-bank recall and writes; `false` disables both |
| `writeMode` | string | `project` | write destination: `project` or shared `opencode_global` |
| `dataDir` | string | storage root | override the bank directory |
| `sleep.model` | string | `inherit` | sleep model: the current V2 session model or one explicit `provider/model`; no plugin fallback list |

**Precedence:** project config, then global config, then the legacy
`projects.json` value, then the default. `/mnemosyne status` prints which layer
won, so a disagreement is visible rather than silent.

**`/mnemosyne on|off` writes the project's `opencode.jsonc`.** It touches only the
`mnemosyne` block and preserves comments and formatting elsewhere in the file. The
command reports the path it wrote. Note that this creates a file in your project
directory, which is likely to be picked up by version control — that is usually
what you want for a shared team setting, but be aware of it.

Sleep is manual and requires two confirmations: `/mnemosyne sleep` displays the
provider, model, bank, and exact prompt; `/mnemosyne sleep consent` allows generation;
then review the generated summary and run `/mnemosyne sleep approve` to store it or
`/mnemosyne sleep reject` to discard it. A failed storage attempt can be retried with
`approve` without another model call. Sleep is available in V2 only: V1 does not
provide the same built-in safe way to generate a draft outside the chat. A separate
V1-specific path could be built, but is not included here. The normal V1 chat route
would put the draft in the conversation before review, so it is not used. Regular V1
memory features still work; only sleep is unavailable.
Sleep stores an episodic summary and source linkage atomically; it preserves raw turns
but does not run Mnemosyne's native conflict detection, refresh proposals, or
degradation logic. It targets the current effective write bank (project or shared),
never mixes banks, and permits only one pending sleep per bank.

**Environment variables still win over config** for the variables the plugin sets
itself, notably `MNEMOSYNE_NO_EMBEDDINGS`, which is derived from `backend`.

## OpenCode version and V1 registration

The package root (`@digi4care/mnemosyne-opencode`) remains the V2 plugin entrypoint.
OpenCode V1.18.35 requires two distinct registrations: the server adapter handles
recall, context injection, idle flushes, and configuration changes; the TUI companion
provides `/mnemosyne` commands and local notifications. Register both modules:

```jsonc
// V1 server plugin configuration
"plugin": ["@digi4care/mnemosyne-opencode/v1-server"]
```

```jsonc
// ~/.config/opencode/tui.json
{ "plugin": ["@digi4care/mnemosyne-opencode/tui"] }
```

The package subpaths `./v1-server` and `./tui` are explicit V1 exports. TUI command output
is local to the terminal, not inserted into chat. Open a session before using the
commands. V1 exposes discrete TUI commands: `/mnemosyne-help`, `/mnemosyne-on`,
`/mnemosyne-off`, `/mnemosyne-status`, `/mnemosyne-global-on`,
`/mnemosyne-global-off`, `/mnemosyne-stats`, `/mnemosyne-invalidate`,
`/mnemosyne-confirm`, `/mnemosyne-file`, `/mnemosyne-embedded`,
`/mnemosyne-backup`, `/mnemosyne-verify`, `/mnemosyne-verify-full`,
`/mnemosyne-import-hindsight`, and `/mnemosyne-sleep`. Commands needing arguments
use the supported TUI prompt dialog. Global invalidation requires a second
`/mnemosyne-confirm`; stale snapshots/configuration are rejected. Sleep reports
unsupported and performs no writes or provider calls. V1 server and TUI processes coordinate through the same
`MNEMOSYNE_PLUGIN_COORD_DB` file (default:
`~/.local/share/opencode/storage/plugin/mnemosyne-opencode/plugin-coord.db`).
If project session inventory or idle status cannot be confirmed completely, V1
refuses a global/project mode switch.

The V1 adapter was smoke-tested with OpenCode V1.18.35: a local fake-provider
request contained recalled memory in its system prompt before the user's question.
This verifies that tested version and path only; other V1 versions are not covered.
Message lists reaching the requested cap are treated as incomplete and are not flushed.

## Prerequisites

- OpenCode v2 (≥ 2.0.18), or OpenCode V1.18.35 with both V1 registrations above.
- `uvx` (provided by `uv`).
- `mnemosyne-memory==3.15.1` available via PyPI.
- Optional: Ollama on `localhost:11434` with `nomic-embed-text` for the
  `embedded` backend.
- Node 20+.

## Installation

**From npm** (planned for corrected package version `0.3.0`; not published yet):

```jsonc
"plugins": [ "@digi4care/mnemosyne-opencode" ]
```

OpenCode installs npm plugins with Bun at startup. The root package name remains the V2
entrypoint; `./server` also maps to the V2 entrypoint because OpenCode 2.0.30's
package-name resolver selects that subpath. V1.18.35 users must register
`@digi4care/mnemosyne-opencode/v1-server` and the TUI subpath as shown above.

**Migration from 0.2.x:** if your V1 server config used
`@digi4care/mnemosyne-opencode/server`, change it to
`@digi4care/mnemosyne-opencode/v1-server` before upgrading. In 0.3.0, `/server` is
reserved for V2 resolver compatibility and no longer loads the V1 adapter.

**From a local checkout:**

```jsonc
"plugins": [
  "/absolute/path/to/mnemosyne-opencode"
]
```

Either way, restart OpenCode (`opencode service restart`) or start a fresh session,
then pick a project directory.

## Quick start

```text
# Once per project
/mnemosyne
/mnemosyne file
/mnemosyne on

# Then just work. Everything is automatic:
#  - relevant memories are injected before each prompt
#  - new turns get stored once per session cursor
```

Check state with `/mnemosyne status`. Disable or quiet background failures with
`/mnemosyne off`.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `MNEMOSYNE_STATE_FILE` | `~/.local/share/opencode/storage/plugin/mnemosyne-opencode/projects.json` | per-project runtime state (`last_error`, `updated_at`) |
| `MNEMOSYNE_DATA_DIR` | `~/.local/share/opencode/storage/plugin/mnemosyne-opencode/data/banks/opencode_<hash>` | bank DB directory |
| `MNEMOSYNE_NO_EMBEDDINGS` | (1 when file) | disables embeddings without changing bank |
| `MNEMOSYNE_EMBEDDING_API_URL` | `http://localhost:11434/v1` | Ollama base URL (embedded only) |
| `MNEMOSYNE_EMBEDDING_MODEL` | `nomic-embed-text` | embedding model name |
| `MNEMOSYNE_EMBEDDING_DIM` | `768` | dimension |
| `MNEMOSYNE_MCP_BANK` | auto | bank name override |
| `HINDSIGHT_API_URL` / `HINDSIGHT_API_TOKEN` | `http://localhost:8888` | only for `import hindsight` |
| `OPENCODE_MODEL` | takes precedence over file default in the smoke script | smoke-model hint |

## Troubleshooting

- No recall: `/mnemosyne status`; check `last_error` in output.
- Embedded backend impotent: ensure Ollama has `nomic-embed-text` pulled.
- Backup output empty: check dir permissions (defaults to storage root).
- Whenever in doubt, `/mnemosyne status` is the source of truth; errors are
  surfaced, never swallowed.

## License

MIT. Local data, not shared; backups are plaintext.
