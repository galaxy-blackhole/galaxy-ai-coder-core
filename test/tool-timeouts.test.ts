import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  TOOL_DISPATCH_GUARD_MARGIN_MS,
  dispatchGuardMs,
} from "../src/tools/tool-timeouts.js";

test("the host guard is derived from the timeout the agent chose", () => {
  // Measured: a step asked for 600000ms on a scaffolder command while the guard was a fixed
  // 600000ms, the guard won the race, and the step died with
  // "Tool run_command did not return within 600000ms" instead of getting a timeout result.
  assert.equal(dispatchGuardMs(600_000), 600_000 + TOOL_DISPATCH_GUARD_MARGIN_MS);
  assert.equal(dispatchGuardMs(900_000), 900_000 + TOOL_DISPATCH_GUARD_MARGIN_MS);
  assert.ok(dispatchGuardMs(900_000) > 900_000, "the tool's own timeout always fires first");
});

test("a call without a timeout falls back to the port default plus head-room", () => {
  assert.equal(dispatchGuardMs(undefined), DEFAULT_TOOL_TIMEOUT_MS + TOOL_DISPATCH_GUARD_MARGIN_MS);
  assert.equal(dispatchGuardMs(0), DEFAULT_TOOL_TIMEOUT_MS + TOOL_DISPATCH_GUARD_MARGIN_MS);
  assert.equal(dispatchGuardMs(Number.NaN), DEFAULT_TOOL_TIMEOUT_MS + TOOL_DISPATCH_GUARD_MARGIN_MS);
});
