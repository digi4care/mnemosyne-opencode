# Release readiness

What has to be true before `mnemosyne-opencode` is published to npm and called
production-ready. This is a checklist derived from a verified inspection of the
current package, plus a testing ladder.

Scope note: this document covers packaging, testing and language policy. The
functional design is in [PRD-memory-lifecycle.md](PRD-memory-lifecycle.md).

## Language policy

**Everything that ships to npm is English.** That is not negotiable and not a
preference: an international audience cannot use a Dutch README.

| Surface | Language | Ships to npm? |
|---|---|---|
| `plugins/mnemosyne-opencode/README.md` | English | yes |
| Root `README.md` | English | no, but public on GitHub |
| Code comments, commit messages, command output | English | yes |
| `docs/working-with-memory.md` | English | no |
| CHANGELOG, issue templates | English | no |

| `docs/PRD-memory-lifecycle.md` | English (translated 16-10-2026) | no |

**Resolved.** The PRD was translated in place. The Dutch original is preserved in the
private archive repository `digi4care/mnemosyne-opencode-research-history`, together
with the pre-publication git history.

The research notes under `~/projects/opencode-agents/research/` remain in the working
language. They are not in the repository at all, so they are out of scope for this
policy.

## Verified packaging blockers

These were confirmed by running `npm pack --dry-run` and reading the published
schema. None is hypothetical.

| # | Blocker | Evidence | Fix |
|---|---|---|---|
| B1 | A compiled Python cache file ships in the tarball | `__pycache__/memory_worker.cpython-314.pyc` (4.1 kB) appears in `npm pack` output | add `files` to `package.json`, or a `.npmignore` |
| B2 | No LICENSE file | absent from tarball | add one, and set `license` in `package.json` |
| B3 | No `repository`, `author`, `homepage`, `bugs`, `keywords` | absent from `package.json` | required for a credible package page |
| B4 | `npm run smoke` is broken for consumers | script points at `../../scripts/smoke-native-abc.sh`, which is outside the published package | drop it, or ship the script inside the package |
| B5 | No `engines` field | absent | declare `node >= 20` |
| B6 | Install docs only show an absolute local path | root README and package README | document the npm form |
| B7 | Tests ship inside the tarball | `test/*.js` in pack output | acceptable, but decide: it aids verification and costs 6 kB |

### On the npm install form

The current config schema at `https://opencode.ai/config.json` accepts:

```jsonc
"plugins": [ "mnemosyne-opencode", { "package": "mnemosyne-opencode", "options": {} } ]
```

Note the docs page at `opencode.ai/docs/plugins` still shows the key `"plugin"`, which
the schema marks **deprecated**. `plugins` is correct.

npm plugins are installed by Bun at startup and cached in
`~/.cache/opencode/node_modules/`. **Not verified:** whether a version pin such as
`"mnemosyne-opencode@0.2.0"` is accepted. Test it before documenting it; do not
promise pinning until it is proven.

## Testing ladder

Each level has an exit criterion. Do not start the next one before the previous one
is green.

### L1 — Unit tests (`npm test`)

Current state: 5 tests, all passing. Covers command parsing, state handling, message
rendering, and a live worker round-trip in file-only mode.

To add before release:
- `/mnemosyne backup` and `/mnemosyne verify` argument handling
- `/mnemosyne import hindsight` with a missing or malformed source
- unknown-action path, including the renamed `/memory` spelling
- config resolution once D1 lands (global `opencode.jsonc` versus project override)

### L2 — Integration tests

No layer exists today. Needs a test that runs against a real `Mnemosyne` instance in a
temp directory, covering:
- remember then recall in the same bank
- recall returns nothing on an empty bank, and the plugin does not inject an empty block
- write-back is idempotent: flushing the same session twice does not duplicate rows
- disabled project performs no recall and no write-back

### L3 — End-to-end smoke (`scripts/smoke-native-abc.sh`)

This is the layer that actually proves the product. It stores a unique token in session
A and requires session B, a separate process, to return it with no manual
remember/recall.

Current state: passes for both `mnemosyne-file` and `mnemosyne-embedded`.

To add before release:
- run against a **freshly installed npm copy**, not the working tree
- version-pin check, which is currently unverified
- a negative case: memory disabled, then confirm the token is not recalled

### L4 — Environment matrix

Not yet attempted. Minimum before claiming production readiness:

| Dimension | Cases |
|---|---|
| OS | Linux, macOS |
| Node | 20, 22 |
| Backend | file, embedded |
| Install | npm, local path |
| Freshness | empty bank, bank with existing memories |

Known gap: all evidence so far comes from one machine and one project.

## Release mechanics

- **Version policy.** Semver. Renaming `/memory` to `/mnemosyne` was breaking, which is
  why this is `0.2.0` and not `1.0.0`. `0.x` means breaking changes are allowed in minor
  bumps.
- **CHANGELOG.md**, keep-a-changelog format, one section per version, written for users.
- **Publish checklist:** L1–L3 green, `npm pack --dry-run` inspected file by file,
  version bumped, CHANGELOG updated, README install steps verified from a clean machine.
- **First publish** should be `0.2.0` as-is, not `1.0.0`. The plugin has not yet proven
  itself across environments, and pretending otherwise costs credibility.

## Suggested order

1. Fix B1–B5. Half a day, no behaviour change.
2. Add the L1 tests listed above. One day.
3. Build L2. One to two days.
4. L4 matrix, starting with a second OS and a clean install.
5. CHANGELOG and publish dry run.
6. Only then the D1–D4 implementation work from the PRD.

Steps 1 and 2 are safe to do now. Steps 3 and 4 need a decision about whether this
happens before or after the PRD work, because a global bank changes the hot path that
every smoke test exercises.