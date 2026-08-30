import assert from "node:assert/strict";
import test from "node:test";
import {
  retrieveAiCoderLexicalEvidence,
  type AiCoderLexicalRetrievalAdapter,
} from "../src/retrieval/lexical-retriever.js";
import { createAiCoderLexicalRetrievalPlan } from "../src/retrieval/retrieval-policy.js";

test("lexical retrieval is deterministic, bounded and adapter-neutral", async () => {
  const calls: string[] = [];
  const adapter: AiCoderLexicalRetrievalAdapter = Object.freeze({
    async readRange(input: Parameters<AiCoderLexicalRetrievalAdapter["readRange"]>[0]) {
      calls.push(`read:${input.path}:${input.startLine}-${input.endLine}`);
      return Object.freeze({
        content: "export function runController() {}",
        contentHash: "sha256:file",
        endLine: input.endLine,
        path: input.path,
        startLine: input.startLine,
        truncated: false,
      });
    },
    async searchPaths(input: Parameters<AiCoderLexicalRetrievalAdapter["searchPaths"]>[0]) {
      calls.push(`paths:${input.query}`);
      return Object.freeze([{ path: "src/runtime/run-controller.ts", score: 0.8 }]);
    },
    async searchText(input: Parameters<AiCoderLexicalRetrievalAdapter["searchText"]>[0]) {
      calls.push(`text:${input.query}`);
      return Object.freeze([
        { line: 42, path: "src/runtime/run-controller.ts", preview: "class AiCoderRunController", score: 0.9 },
        { line: 42, path: "src/runtime/run-controller.ts", preview: "class AiCoderRunController", score: 0.9 },
      ]);
    },
  });
  const plan = createAiCoderLexicalRetrievalPlan({
    budget: { maxBytes: 1_000, maxFiles: 2, maxMatches: 10, maxQueries: 2, readContextLines: 3 },
    goal: "Find AiCoderRunController in src/runtime/run-controller.ts",
  });
  const result = await retrieveAiCoderLexicalEvidence({ adapter, plan, reason: "Locate the runtime implementation" });
  assert.ok(calls.some((item) => item.startsWith("paths:")));
  assert.ok(calls.some((item) => item.startsWith("text:")));
  assert.equal(result.filesRead, 1);
  assert.equal(result.evidence.filter((item) => item.kind === "text_match").length, 1);
  assert.equal(result.evidence.filter((item) => item.kind === "file_range").length, 1);
  assert.ok(result.bytesRead <= 1_000);
});

test("lexical retrieval honors cancellation before touching the adapter", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  let touched = false;
  const adapter: AiCoderLexicalRetrievalAdapter = Object.freeze({
    async readRange() { touched = true; throw new Error("unexpected"); },
    async searchPaths() { touched = true; return []; },
    async searchText() { touched = true; return []; },
  });
  const plan = createAiCoderLexicalRetrievalPlan({ goal: "find runtime" });
  await assert.rejects(retrieveAiCoderLexicalEvidence({ adapter, plan, reason: "test", signal: controller.signal }), /stop/);
  assert.equal(touched, false);
});
