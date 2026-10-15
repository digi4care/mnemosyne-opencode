# Mnemosyne OpenCode integration

This repository houses the **native OpenCode v2 plugin**
(unner `plugins/mnemosyne-opencode`) that gives OpenCode automatic,
per-project Mnemosyne memory.

## Repository layout

- `plugins/mnemosyne-opencode` — the plugin (TypeScript-free JSDoc).
  Primary target. This is what gets installed into OpenCode.
- `scripts/` — end-to-end smoke tests, runtime helpers.
- `interview/` — specs and prior answers (interim).
- `results/` — tracked (when not gitignored) smoke evidence artifacts.
- `.mnemosyne/` — local mnemonic bank, gitignored.

## Quick install

```bash
# add the absolute path to OpenCode's config
"plugins": [ "/home/digi4care/projects/opencode-ab-test-Mnemosyne-vs-Hindsight/plugins/mnemosyne-opencode" ]

opencode service restart
```

## See the plugin README for full usage

`plugins/mnemosyne-opencode/README.md`
