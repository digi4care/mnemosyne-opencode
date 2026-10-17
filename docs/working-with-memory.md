# Working with Mnemosyne memory in OpenCode

New to AI memory? Start here. You do not need to know how agents or databases work.
Think of Mnemosyne as a notebook OpenCode can search while it helps you code. This
guide explains what it saves, how to turn it on, and how to fix a wrong memory. The
[plugin README](../plugins/mnemosyne-opencode/README.md) has the full command list.

## What it does

Once you turn it on for a project, the plugin works in the background:

- **Recall.** Before a prompt is sent, Mnemosyne looks for useful notes from this
  project. If shared memory is enabled, it may add one useful note from there too.
- **Save.** When a chat session goes quiet, Mnemosyne saves what you and the assistant
  said. It does not save tool output or copy recalled notes back into storage.
- **Shared memory (optional).** `/mnemosyne global on` sends new chat turns to the
  shared notebook instead of this project's notebook. Use `/mnemosyne global off` to
  switch back. While it is on, project-specific details can also be saved there.

You do not need to ask the AI to remember something. Mnemosyne saves chat turns
automatically. It does not ask an AI model to decide what to save.

## Five rules for working with it

**1. Turn it on once for each project.**
```
/mnemosyne
/mnemosyne file
/mnemosyne on
```
Do this once. After that, saving and finding memories happens automatically.
`/mnemosyne on` adds a small Mnemosyne setting to the project's `opencode.jsonc`.
It leaves the rest of the file alone. You can check that it worked with
`/mnemosyne status`.

**2. You usually do not need to repeat facts for Mnemosyne.**
Your chat is saved when the session goes quiet. Mnemosyne may still miss an old or
poorly phrased detail, so check with `/mnemosyne status` if something seems wrong.

**3. Fix outdated notes yourself.**
Mnemosyne does not know that a newer statement makes an older one wrong. First say
the correct value in chat. If the old note appears in the memories shown to the AI,
remove it using its number:

```
/mnemosyne invalidate 2
```

Use the number shown beside the outdated note in the AI's current context. Project
notes are removed right away. For a shared note, Mnemosyne shows you what will be
removed and asks you to run `/mnemosyne confirm` before it makes the change. The new
value is saved with the rest of the chat when the session goes quiet.

Just saying the new value does not remove the old one. If you do not remove an old
note, both versions may remain and the AI could see either one.

**4. Be careful with private or temporary details.**
Memories are plain text in a local database. Do not put passwords, API keys, or other
secrets in a prompt. Old notes do not expire automatically. Recent notes get a small
ranking boost, but a wrong note can still show up until you remove it.

**5. If something looks wrong, check the status.**
```
/mnemosyne status     # backend, enabled, bank, last error
/mnemosyne stats      # counters per memory tier
/mnemosyne backup     # compressed .db.gz before anything risky
```
`status` shows whether memory is on and whether the plugin hit an error. `backup`
creates a compressed copy of the local memory database before risky changes.

`stats` is an optional, more technical report. It shows how many notes are in the
project notebook and, if enabled, the shared notebook. You can ignore it during normal
use.

## What it deliberately does not do

| What Mnemosyne does not do | What that means for you |
|---|---|
| It does not spot contradictions for you | If a remembered fact is out of date, say the correct one and remove the old note yourself. |
| It does not delete old notes automatically | Newer notes get a small advantage, but old ones can still appear. |
| It does not summarize chats automatically | On OpenCode V2, `/mnemosyne sleep` can make a summary only after you preview it, allow the provider call, and approve the result. OpenCode V1 reports this command as unsupported. Your original chat stays saved. |
| It does not hide secrets | Memory is plain text on your computer. Never include passwords or API keys in a prompt. |

`/mnemosyne sleep` makes an optional summary from your chat. It is available in
OpenCode V2, but not V1. **Why?** V1 does not give plugins the same built-in safe way
to ask for a draft without putting it in your chat first. We could build a separate
V1-specific way to do that; it was left out of this version. Using V1's normal chat
route would put the draft in the conversation before you approved it, so that route is
disabled. Your normal memory features—saving chat turns and finding old notes—still
work in V1.

On V2, sleep first shows what chat information would be sent, and to which AI service.
The summary is not saved unless you approve it:

```
/mnemosyne sleep          # preview
/mnemosyne sleep consent  # allow this one AI request
# review the summary shown by the plugin
/mnemosyne sleep approve  # save it, or use "reject" to discard it
```

The summary does not replace or delete your original chat. Sleep never runs by itself.

## Why it is built this way

In short: you stay in control. Saving ordinary chat turns does not call an AI provider
just to organize your memories. The optional V2 `sleep` feature is different: it sends
the previewed conversation to a provider only after you choose `consent`, then waits
for your approval before saving the summary. This two-step flow keeps provider use and
storage under your control.

**Finding a note is not the same as knowing it is true.** Mnemosyne ranks notes by how
well they match your question. The optional `embedded` backend can also match similar
phrasing; the simpler `file` backend uses words and text search.

**Old information is the main limitation.** Mnemosyne keeps what it saved until you
remove it. That is why the guide recommends checking and correcting outdated notes
yourself instead of trusting memory as a source of truth.

## Where to look next

If you just want memory while coding, you are ready to go. For install instructions and
the full command list, see the [plugin README](../plugins/mnemosyne-opencode/README.md).
