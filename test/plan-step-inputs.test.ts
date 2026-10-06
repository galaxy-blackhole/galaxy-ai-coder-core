/**
 * The checkpoint tool has to accept the step form the model actually sends. A real gymflow run failed its
 * very first step because the input schema demanded the shorthand string while the checkpoint record and the
 * checklist both use objects: the call was rejected, the tool never ran, and the run aborted.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parsePlanStep, parsePlanSteps } from "../src/runtime/plan.js";

test("the object form parses exactly like the shorthand string", () => {
  const fromObject = parsePlanStep({ status: "done", title: "Inspect the workspace" });
  const fromString = parsePlanStep("done: Inspect the workspace");
  assert.deepEqual(fromObject, fromString);
  assert.equal(fromObject?.status, "completed");
  assert.equal(fromObject?.id, "inspect-the-workspace");
});

test("ids, status aliases and unusable steps are handled", () => {
  assert.equal(parsePlanStep({ id: "s1", status: "doing", title: "Scaffold" })?.id, "s1", "an explicit id wins");
  assert.equal(parsePlanStep({ status: "todo", title: "Frontend" })?.status, "pending");
  assert.equal(parsePlanStep({ status: "skipped", title: "Docs" })?.status, "skipped");
  assert.equal(parsePlanStep({ status: "done" }), null, "a step without a title is dropped");
  assert.equal(parsePlanStep({ title: "   " }), null);
  assert.equal(parsePlanStep("   "), null);
  const mixed = parsePlanSteps([{ status: "done", title: "A" }, "todo: B"]);
  assert.deepEqual(mixed.map(step => step.status + ":" + step.title), ["completed:A", "pending:B"], "both forms mix in one call");
});