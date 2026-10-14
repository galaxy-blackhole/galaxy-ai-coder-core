import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PRUNE_HEAD_CHARS, DEFAULT_PRUNE_TAIL_CHARS, pruneToolText } from "../src/context/tool-result-pruner.js";

test("a short result is left exactly as it was", () => {
  const short = "hai dòng\nbình thường";
  const result = pruneToolText(short);
  assert.equal(result.pruned, false);
  assert.equal(result.text, short);
  assert.equal(result.removedChars, 0);
});

test("the head and the tail survive, and the middle is marked", () => {
  const long = "ĐẦU".repeat(500) + "GIỮA".repeat(2_000) + "CUỐI".repeat(500);
  const result = pruneToolText(long);
  assert.equal(result.pruned, true);
  assert.ok(result.text.startsWith("ĐẦU"), "the beginning is kept");
  assert.ok(result.text.endsWith("CUỐI"), "the end is kept, because that is where a failure says so");
  assert.match(result.text, /đã bỏ khi gọt context/);
  assert.equal(result.removedChars, long.length - DEFAULT_PRUNE_HEAD_CHARS - DEFAULT_PRUNE_TAIL_CHARS);
  assert.ok(result.text.length < long.length / 2, "pruning that saves nothing is not pruning");
});

test("pruning is deterministic, so a replay rebuilds the same context", () => {
  const long = "x".repeat(9_000);
  assert.equal(pruneToolText(long).text, pruneToolText(long).text);
});

test("a result that would lose everything is not pruned at all", () => {
  const text = "y".repeat(600);
  const result = pruneToolText(text, { headChars: 400, tailChars: 400, thresholdChars: 500 });
  assert.equal(result.pruned, false, "head plus tail must leave something to remove");
  assert.equal(result.text, text);
});
