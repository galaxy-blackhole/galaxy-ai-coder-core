import assert from "node:assert/strict";
import test from "node:test";
import { SqliteAgentMemory } from "../src/adapters/node/memory/sqlite-memory.js";
import type { AgentEmbeddingPort } from "../src/agent/index.js";

function fakeEmbeddings(): AgentEmbeddingPort {
  return { model: "fake-v1", async embed(texts) {
    return texts.map(text => text.includes("alpha") ? [1, 0] : text.includes("beta") ? [0, 1] : text.includes("gamma") ? [0.9, 0.1] : [0.5, 0.5]);
  } };
}

test("hybrid ranking prefers confirmed records when lexical and recency tie", async () => {
  const memory = new SqliteAgentMemory(":memory:", "scope");
  await memory.remember({ key: "candidate", content: "shared topic", source: "test", trust: "candidate" });
  await memory.remember({ key: "confirmed", content: "shared topic", source: "test", trust: "confirmed" });
  const hits = await memory.search("shared", { includeCandidates: true, limit: 5 });
  assert.equal(hits[0]?.key, "confirmed");
  memory.close();
});

test("semantic ranking surfaces a relevant record with no lexical hit", async () => {
  const memory = new SqliteAgentMemory(":memory:", "scope", { embeddings: fakeEmbeddings() });
  await memory.remember({ key: "alpha", content: "alpha note", source: "test", trust: "confirmed" });
  await memory.remember({ key: "beta", content: "beta note", source: "test", trust: "confirmed" });
  const hits = await memory.search("gamma", { limit: 5 });
  assert.equal(hits[0]?.key, "alpha");
  memory.close();
});

test("consolidation prunes superseded revisions", async () => {
  const memory = new SqliteAgentMemory(":memory:", "scope");
  for (const content of ["v1", "v2", "v3", "v4"]) await memory.remember({ key: "k", content, source: "test", trust: "confirmed" });
  assert.equal((await memory.history("k")).length, 4);
  const result = memory.consolidate({ keepSupersededRevisions: 1 });
  assert.equal(result.removedSuperseded, 2);
  assert.equal((await memory.history("k")).length, 2);
  memory.close();
});

test("forget removes embeddings through the delete trigger", async () => {
  const memory = new SqliteAgentMemory(":memory:", "scope", { embeddings: fakeEmbeddings() });
  await memory.remember({ key: "alpha", content: "alpha note", source: "test", trust: "confirmed" });
  assert.equal(await memory.forget("alpha"), 1);
  assert.equal((await memory.search("alpha", { limit: 5 })).length, 0);
  assert.equal(memory.consolidate().removedOrphanEmbeddings, 0);
  memory.close();
});
