# Mnemosyne OpenCode plugin

Automatic, project-scoped memory for OpenCode. Backed by Mnemosyne. Once enabled
in a project, the plugin recalls relevant past memories before each prompt and
writes new user/assistant turns back to the project bank. No model-driven
remember/recall required.

**Backends**
- `mnemosyne-file` — SQLite + FTS, no embeddings (offline, recommended default).
- `mnemosyne-embedded` — adds dense embeddings via Ollama `nomic-embed-text`.

**Commands**

| Command | Action |
|---|---|
| `/mnemosyne` | show help |
| `/mnemosyne on\|off` | enable/disable automatic memory for this project |
| `/mnemosyne status` | backend, enabled, bank, storage, config source, last error |
| `/mnemosyne stats` | backend counters |
| `/mnemosyne file` | Mnemosyne without embeddings |
| `/mnemosyne embedded` | Mnemosyne with Ollama embeddings |
| `/mnemosyne backup [dir]` | write a compressed `.db.gz` backup |
| `/mnemosyne verify` | database integrity check |
| `/mnemosyne import hindsight <src>` | import legacy Hindsight data |

## Configuration

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
    "globalBank": true
  }
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | memory on for this project |
| `backend` | string | `mnemosyne-file` | `mnemosyne-file` or `mnemosyne-embedded` |
| `recallLimit` | integer 1–20 | `4` | memories injected per prompt |
| `globalBank` | boolean | `true` | also recall from the shared global bank |
| `dataDir` | string | storage root | override the bank directory |

**Precedence:** project config, then global config, then the legacy
`projects.json` value, then the default. `/mnemosyne status` prints which layer
won, so a disagreement is visible rather than silent.

**`/mnemosyne on|off` writes the project's `opencode.jsonc`.** It touches only the
`mnemosyne` block and preserves comments and formatting elsewhere in the file. The
command reports the path it wrote. Note that this creates a file in your project
directory, which is likely to be picked up by version control — that is usually
what you want for a shared team setting, but be aware of it.

**Environment variables still win over config** for the variables the plugin sets
itself, notably `MNEMOSYNE_NO_EMBEDDINGS`, which is derived from `backend`.

## Prerequisites

- OpenCode v2 (≥ 2.0.18).
- `uvx` (provided by `uv`).
- `mnemosyne-memory==3.15.1` available via PyPI.
- Optional: Ollama on `localhost:11434` with `nomic-embed-text` for the
  `embedded` backend.
- Node 20+.

## Installation

**From npm** (recommended once published):

```jsonc
"plugins": [ "@digi4care/mnemosyne-opencode" ]
```

OpenCode installs npm plugins with Bun at startup and caches them in
`~/.cache/opencode/node_modules/`. **Not yet verified:** whether a version pin such as
`"@digi4care/mnemosyne-opencode@0.2.0"` is accepted. Do not promise pinning until it is
tested.

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
/mnemosyne mnemosyne file
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
