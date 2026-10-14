import assert from "node:assert/strict";
import test from "node:test";
import { mergeProgramToolEffects } from "../src/adapters/node/tools/tool-executor.js";

/*
 * A program's nested calls are the run's calls.
 *
 * The executor used to answer run_code with empty effects, so every read performed inside a program was invisible:
 * a session that inspected a repository through programs looked like it had never looked at the workspace, the
 * completion gate refused the report with INSPECTION_MISSING, and three refusals ended the run. These assertions
 * are what keeps that from coming back silently.
 */

test("a program with no calls reports no effects at all", () => {
  assert.deepEqual(mergeProgramToolEffects([]), {});
});

test("reads inside a program become the run's own inspection evidence", () => {
  const merged = mergeProgramToolEffects([
    Object.freeze({ inspectedPaths: Object.freeze(["src/a.ts"]) }),
    Object.freeze({ inspectedPaths: Object.freeze(["src/b.ts", "src/a.ts"]) }),
  ]);
  assert.deepEqual(merged.inspectedPaths, ["src/a.ts", "src/b.ts", "src/a.ts"]);
});

test("writes, validations and research sources are concatenated, not replaced", () => {
  const merged = mergeProgramToolEffects([
    Object.freeze({ validations: Object.freeze([{ detail: "ok", id: "v1", scope: "workspace" as const, status: "passed" as const }]) }),
    Object.freeze({ validations: Object.freeze([{ detail: "ok", id: "v2", scope: "paths" as const, status: "failed" as const }]) }),
    Object.freeze({ researchSources: Object.freeze([{ contentHash: "h", kind: "fetch" as const, summary: "s", truncated: false, url: "https://example.test/a" }]) }),
  ]);
  assert.deepEqual(merged.validations?.map((item) => item.id), ["v1", "v2"]);
  assert.equal(merged.researchSources?.length, 1);
});

test("the last plan and diff review describe the state the program ended in", () => {
  const merged = mergeProgramToolEffects([
    Object.freeze({ plan: Object.freeze({ completed: Object.freeze(["a"]), inProgress: "b", pending: Object.freeze([]) }), nextAction: "first" }),
    Object.freeze({ plan: Object.freeze({ completed: Object.freeze(["a", "b"]), inProgress: null, pending: Object.freeze([]) }), nextAction: "second" }),
  ]);
  assert.deepEqual(merged.plan?.completed, ["a", "b"]);
  assert.equal(merged.nextAction, "second");
});