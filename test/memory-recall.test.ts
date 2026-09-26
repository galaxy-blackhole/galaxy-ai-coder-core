import assert from "node:assert/strict";
import test from "node:test";
import { SqliteAgentMemory } from "../src/adapters/node/memory/sqlite-memory.js";
import { fakeEmbeddings, measureRecall, RECALL_NOTES } from "./helpers/recall-set.js";

test("semantic memory recall beats lexical on the labeled Vietnamese/cross-lingual set", async () => {
  const lexical = new SqliteAgentMemory(":memory:", "recall");
  const semantic = new SqliteAgentMemory(":memory:", "recall", { embeddings: fakeEmbeddings() });
  for (const memory of [lexical, semantic]) for (const [key, content] of RECALL_NOTES) await memory.remember({ key, content, source: "seed", trust: "confirmed" });
  try {
    const lexicalScore = await measureRecall(lexical);
    const semanticScore = await measureRecall(semantic);
    console.log(`recall lexical@1=${(lexicalScore.at1 * 100).toFixed(0)}% @3=${(lexicalScore.at3 * 100).toFixed(0)}% | semantic@1=${(semanticScore.at1 * 100).toFixed(0)}% @3=${(semanticScore.at3 * 100).toFixed(0)}%`);
    assert.equal(semanticScore.at1, 1, `semantic@1 misses: ${semanticScore.misses.join("; ")}`);
    assert.ok(semanticScore.at1 > lexicalScore.at1, "semantic must beat lexical on paraphrase/cross-lingual queries");
  } finally { lexical.close(); semantic.close(); }
});
