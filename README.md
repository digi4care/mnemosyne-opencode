# Mnemosyne OpenCode integration

Automatic, per-project memory for OpenCode, backed by Mnemosyne.

- **[Working with memory](docs/working-with-memory.md)** — start here. What the plugin
  does, how to work with it, what it deliberately does not do, and why it is built this
  way. Read this before enabling it for the first time.
- **[Plugin reference](plugins/mnemosyne-opencode/README.md)** — command reference,
  configuration, environment variables, troubleshooting.
- **[PRD](docs/PRD-memory-lifecycle.md)** — the decided design: memory lifecycle,
  configuration model, global memory, and the open implementation order.
- **[Release readiness](docs/RELEASE-READINESS.md)** — packaging blockers, the test
  ladder, and the language policy for everything that ships.

## Install

Add the absolute path to the `plugins` array in `~/.config/opencode/opencode.jsonc`:

```jsonc
"plugins": [
  "/home/digi4care/projects/opencode-ab-test-Mnemosyne-vs-Hindsight/plugins/mnemosyne-opencode"
]
```

Then restart OpenCode and enable it once per project:

```
/mnemosyne mnemosyne file
/mnemosyne on
```

Requires `uv`/`uvx` and Node 20+. The `embedded` backend additionally requires Ollama
with `nomic-embed-text`; `file` has no extra dependency.

## Repository layout

- `plugins/mnemosyne-opencode` — the plugin. This is what gets installed into OpenCode.
- `docs/` — working guide and design decisions.
- `scripts/` — end-to-end smoke tests and runtime helpers.
- `interview/` — prior specs.
- `results/` — smoke test evidence.
- `.mnemosyne/` — local bank, gitignored.

## Development

```bash
cd plugins/mnemosyne-opencode
npm install
npm test

# end-to-end: proves automatic recall in a fresh session, per backend
OPENCODE_MODEL=opencode-go/cat-jam-free bash scripts/smoke-native-abc.sh
```