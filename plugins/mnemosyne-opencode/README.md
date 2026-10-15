# `/mnemosyne` — native OpenCode memory plugin

One native OpenCode v2 plugin with selectable backends for project-bound automatic memory. Activate per project; memory is disabled by default. After activation the plugin enriches prompts with relevant older memories and writes new user/assistant turns back into the project bank.

## Commands

```text
/mnemosyne                         show command help, changes nothing
/mnemosyne on                      enable automatic memory for this project
/mnemosyne off                     stop future injection/write-back; old data stays
/mnemosyne status                  show backend, bank, data directory and last_error
/mnemosyne mnemosyne file          use Mnemosyne without embeddings (SQLite FTS)
/mnemosyne mnemosyne embedded      use Mnemosyne with Ollama embeddings
/mnemosyne backup [dir]            write a compressed database backup
/mnemosyne verify                  check database integrity
/mnemosyne import hindsight <src>  import Hindsight memories from a file or URL
```

`/mnemosyne stats` shows backend statistics. The tool is **not needed for daily use**: after activation, recall and write-back are automatic.

## Installation

Add the absolute directory to the OpenCode v2 `plugins` array in `~/.config/opencode/opencode.jsonc`:

```jsonc
"plugins": [
  "/home/digi4care/projects/opencode-ab-test-Mnemosyne-vs-Hindsight/plugins/mnemosyne-opencode"
]
```

Then run `opencode service restart` or start a new session. This configuration changes neither agents nor MCP servers.

## Backends

| Backend | Storage | Extra service |
|---|---|---|
| `mnemosyne-file` | Mnemosyne SQLite + FTS, no embeddings | none |
| `mnemosyne-embedded` | Mnemosyne + dense embeddings | Ollama `nomic-embed-text` on `localhost:11434` |

Project banks are named `opencode_<16-hex-hash>` and use the canonical project path as their identity. Everything from this plugin lives under OpenCode's own data tree:

```
~/.local/share/opencode/storage/plugin/mnemosyne-opencode/projects.json
~/.local/share/opencode/storage/plugin/mnemosyne-opencode/data/banks/opencode_<hash>/
```

There are no loose `~/.config/mnemosyne-opencode` or `~/.local/share/mnemosyne-opencode` directories, and nothing inside the repository itself. `MNEMOSYNE_STATE_FILE` and `MNEMOSYNE_DATA_DIR` remain as overrides so tests use their own temporary directory.

`mnemosyne embedded` uses `MNEMOSYNE_EMBEDDING_API_URL` (default `http://localhost:11434/v1`), `MNEMOSYNE_EMBEDDING_MODEL` (`nomic-embed-text`) and `MNEMOSYNE_EMBEDDING_DIM` (`768`). The wrapper never sends a cloud API key to local HTTP-Ollama.

## Behavior

- `/mnemosyne` without arguments shows only help, as a visible chat line without a model call.
- The visible output of every `/mnemosyne` subcommand lives in the `description` field of the synthetic message; the TUI skips synthetic messages without a `description`. `text` contains only a short model note.
- After activation the plugin looks up at most four relevant memories per prompt and injects them as historical evidence in system context.
- New user/assistant text is stored exactly once per session cursor. Tool output and earlier memory injections are never retained.
- `/mnemosyne off` disables future recall injection and write-back without removing existing memories.
- Recall/write-back errors are logged and visible via `/mnemosyne status` under `last_error`.

## Tests

```bash
cd plugins/mnemosyne-opencode
npm install
npm test
```

The end-to-end smoke test uses real OpenCode processes and requires `OPENCODE_MODEL` with allowed tool calls:

```bash
OPENCODE_MODEL=opencode/space-bunny-free bash scripts/smoke-native-abc.sh
```

The test proves per backend that a unique convention from session A is answered in session B without manual remember/recall. Never store secrets in prompts; memories are unreadable from other project banks but live in plain-text local storage.
