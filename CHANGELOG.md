# Changelog

User-visible changes to the Mnemosyne OpenCode plugin.

## [0.2.1] - 2026-10-17

- Added optional, manual memory summaries on OpenCode V2. You can preview what will be
  sent to the selected AI provider, approve the provider call, review the summary, and
  approve or reject saving it. Original chat turns stay in memory. OpenCode V1 reports
  this feature as unsupported.
- Added separate OpenCode V1 server and TUI plugin entrypoints so existing memory
  commands and automatic memory features can be used on V1. TUI results appear in the
  terminal, not in chat.
- Added shared-memory controls, per-memory-tier stats, and manual removal of an
  outdated remembered item.
- Fixed production installation of the V1 entrypoints, clarified results when a sleep
  save is already in progress, and stopped old chats with no Mnemosyne activity from
  blocking V1 settings changes.
- Updated setup instructions and tests for both OpenCode plugin interfaces.

> Version 0.2.1 is published. Its npm package-name install currently fails on OpenCode
> V2 because the resolver selects the V1 `./server` export. Use the local-checkout
> installation instructions until a corrective release is available.

## [0.3.0] - Unreleased

- Fix OpenCode V2 package-name loading by reserving `./server` for the V2 plugin and
  exposing the V1 server adapter as `./v1-server`. Existing V1 registrations using
  `/server` must migrate to `/v1-server`.
