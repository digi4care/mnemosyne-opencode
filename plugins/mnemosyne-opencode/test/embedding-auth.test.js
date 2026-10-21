import test from "node:test";
import assert from "node:assert/strict";
import { embeddingAuthAllowed, sanitizeEmbeddingEnv } from "../index.js";

test("embedding auth is allowed for HTTPS endpoints", () => {
  assert.equal(embeddingAuthAllowed("https://openrouter.ai/api/v1"), true);
  assert.equal(embeddingAuthAllowed("https://gateway.example.com:8443/v1"), true);
});

test("embedding auth is allowed for loopback HTTP endpoints", () => {
  assert.equal(embeddingAuthAllowed("http://localhost:11434/v1"), true);
  assert.equal(embeddingAuthAllowed("http://127.0.0.1:11434/v1"), true);
  assert.equal(embeddingAuthAllowed("http://[::1]:11434/v1"), true);
});

test("embedding auth is refused for plain HTTP beyond loopback", () => {
  assert.equal(embeddingAuthAllowed("http://192.168.1.10:11434/v1"), false);
  assert.equal(embeddingAuthAllowed("http://gateway.example.com/v1"), false);
  assert.equal(embeddingAuthAllowed("not a url"), false);
  assert.equal(embeddingAuthAllowed(undefined), false);
});

test("sanitizeEmbeddingEnv strips generic provider keys unconditionally", () => {
  const env = {
    OPENAI_API_KEY: "sk-openai",
    OPENROUTER_API_KEY: "sk-openrouter",
    MNEMOSYNE_EMBEDDING_API_URL: "https://openrouter.ai/api/v1",
  };
  sanitizeEmbeddingEnv(env);
  assert.equal("OPENAI_API_KEY" in env, false);
  assert.equal("OPENROUTER_API_KEY" in env, false);
});

test("sanitizeEmbeddingEnv keeps the embedding key for HTTPS and loopback", () => {
  for (const url of ["https://openrouter.ai/api/v1", "http://localhost:11434/v1"]) {
    const env = { MNEMOSYNE_EMBEDDING_API_KEY: "sk-embed", MNEMOSYNE_EMBEDDING_API_URL: url };
    sanitizeEmbeddingEnv(env);
    assert.equal(env.MNEMOSYNE_EMBEDDING_API_KEY, "sk-embed");
  }
});

test("sanitizeEmbeddingEnv defaults to the loopback Ollama URL when none is set", () => {
  const env = { MNEMOSYNE_EMBEDDING_API_KEY: "sk-embed" };
  sanitizeEmbeddingEnv(env);
  assert.equal(env.MNEMOSYNE_EMBEDDING_API_KEY, "sk-embed");
});

test("sanitizeEmbeddingEnv drops the embedding key for plain HTTP beyond loopback", () => {
  const env = {
    MNEMOSYNE_EMBEDDING_API_KEY: "sk-embed",
    MNEMOSYNE_EMBEDDING_API_URL: "http://192.168.1.10:11434/v1",
  };
  sanitizeEmbeddingEnv(env);
  assert.equal("MNEMOSYNE_EMBEDDING_API_KEY" in env, false);
});
