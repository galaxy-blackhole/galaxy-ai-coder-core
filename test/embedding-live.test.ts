import assert from "node:assert/strict";
import test from "node:test";
import { OllamaEmbeddings } from "../src/adapters/node/memory/ollama-embeddings.js";
import { SqliteAgentMemory } from "../src/adapters/node/memory/sqlite-memory.js";
import { measureRecall, RECALL_NOTES } from "./helpers/recall-set.js";

const live = process.env.GALAXY_LIVE_EMBEDDINGS === "1";
const model = process.env.GALAXY_EMBEDDING_MODEL ?? "bge-m3";
const baseUrl = process.env.GALAXY_EMBEDDING_BASE_URL ?? "http://127.0.0.1:11434";

test("live Ollama embeddings recall on the labeled Vietnamese/cross-lingual set", { skip: live ? false : "set GALAXY_LIVE_EMBEDDINGS=1" }, async () => {
  const semantic = new SqliteAgentMemory(":memory:", "live", { embeddings: new OllamaEmbeddings({ baseUrl, model }) });
  const lexical = new SqliteAgentMemory(":memory:", "live");
  for (const memory of [semantic, lexical]) for (const [key, content] of RECALL_NOTES) await memory.remember({ key, content, source: "seed", trust: "confirmed" });
  try {
    const lexicalScore = await measureRecall(lexical);
    const semanticScore = await measureRecall(semantic);
    console.log(`live[${model}] lexical@1=${(lexicalScore.at1 * 100).toFixed(0)}% @3=${(lexicalScore.at3 * 100).toFixed(0)}% | semantic@1=${(semanticScore.at1 * 100).toFixed(0)}% @3=${(semanticScore.at3 * 100).toFixed(0)}%`);
    assert.ok(semanticScore.at1 >= lexicalScore.at1, `semantic ${semanticScore.at1} below lexical ${lexicalScore.at1}`);
    assert.ok(semanticScore.at1 >= 0.75, `semantic@1 ${semanticScore.at1} misses: ${semanticScore.misses.join("; ")}`);
  } finally { semantic.close(); lexical.close(); }
});
