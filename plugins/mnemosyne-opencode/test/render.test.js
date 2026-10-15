import test from "node:test";
import assert from "node:assert/strict";
import { renderMessages, stripInjectedMemory } from "../index.js";

test("renderMessages keeps user/assistant text and drops tools and memory blocks", () => {
  const turns = renderMessages([
    { type: "system", content: [{ type: "text", text: "system" }] },
    { type: "user", text: "remember this" },
    {
      type: "assistant",
      content: [
        { type: "text", text: "answer" },
        { type: "tool", name: "read", state: { input: { path: "secret-output" } } },
      ],
    },
    { type: "assistant", content: [{ type: "text", text: "<mnemosyne_memory>old</mnemosyne_memory> fresh" }] },
  ]);
  assert.deepEqual(turns, [
    { role: "user", content: "remember this" },
    { role: "assistant", content: "answer" },
    { role: "assistant", content: "fresh" },
  ]);
  assert.equal(stripInjectedMemory("a <mnemosyne_memory>x</mnemosyne_memory> b"), "a  b");
});
