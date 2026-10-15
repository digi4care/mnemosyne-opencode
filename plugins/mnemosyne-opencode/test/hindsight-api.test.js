import test from "node:test";
import assert from "node:assert/strict";

const base = (process.env.HINDSIGHT_API_URL || "http://localhost:8888").replace(/\/$/, "");

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status})`);
  return response.json();
}

test("Hindsight chunks retain and recall", async (t) => {
  try {
    await request("GET", "/health");
  } catch {
    t.skip("Hindsight API is not available");
    return;
  }

  const bank = `smoke-${Date.now()}`;
  const marker = `hindsight-${bank}: preserve this exact convention`;
  t.after(async () => {
    await request("DELETE", `/v1/default/banks/${bank}`).catch(() => {});
  });

  await request("PUT", `/v1/default/banks/${bank}`, {
    retain_extraction_mode: "chunks",
    enable_observations: false,
  });
  await request("POST", `/v1/default/banks/${bank}/memories`, {
    items: [{ content: marker, context: "api-test" }],
    async: false,
  });
  const recalled = await request("POST", `/v1/default/banks/${bank}/memories/recall`, {
    query: "preserve convention",
    types: ["world", "experience"],
    budget: "low",
    max_tokens: 1000,
  });
  assert.ok(recalled.results.some((item) => item.text === marker));
});
