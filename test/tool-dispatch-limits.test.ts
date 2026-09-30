import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMAND_TIMEOUT_MARGIN_MS,
  TOOL_DISPATCH_TIMEOUT_MS,
  clampToolTimeoutMs,
} from "../src/runtime/tool-dispatch-limits.js";

test("a model-chosen tool timeout always stays below the host dispatch bound", () => {
  // Measured: a step asked for exactly 600000ms on a scaffolder command that took longer,
  // the host bound was the same 600000ms, the host won the race, and the step died with
  // "Tool run_command did not return within 600000ms" instead of returning a tool result.
  assert.equal(clampToolTimeoutMs(TOOL_DISPATCH_TIMEOUT_MS), TOOL_DISPATCH_TIMEOUT_MS - COMMAND_TIMEOUT_MARGIN_MS);
  assert.equal(clampToolTimeoutMs(TOOL_DISPATCH_TIMEOUT_MS + 60_000), TOOL_DISPATCH_TIMEOUT_MS - COMMAND_TIMEOUT_MARGIN_MS);
  assert.ok((clampToolTimeoutMs(900_000) ?? 0) < TOOL_DISPATCH_TIMEOUT_MS);
});

test("a smaller timeout and an absent timeout are left alone", () => {
  assert.equal(clampToolTimeoutMs(180_000), 180_000);
  assert.equal(clampToolTimeoutMs(undefined), undefined);
});
