import assert from "node:assert/strict";
import test from "node:test";
import { legacyBucketsFromSteps, mergePlanSnapshot, parsePlanStep, parsePlanSteps, stepsFromLegacyBuckets } from "../src/runtime/plan.js";

test("plan steps accept the compact status form and default to pending", () => {
  assert.deepEqual(parsePlanStep("doing: Viết test"), { id: "viet-test", status: "in_progress", title: "Viết test" });
  assert.deepEqual(parsePlanStep("done: Đọc mã nguồn"), { id: "doc-ma-nguon", status: "completed", title: "Đọc mã nguồn" });
  assert.deepEqual(parsePlanStep("Sửa lỗi build"), { id: "sua-loi-build", status: "pending", title: "Sửa lỗi build" });
  assert.deepEqual(parsePlanStep("skip: Không cần"), { id: "khong-can", status: "skipped", title: "Không cần" });
  assert.equal(parsePlanStep("   "), null);
  assert.equal(parsePlanStep("done:"), null, "a status without a title is not a step");
});

test("plan step ids stay unique when titles repeat", () => {
  const steps = parsePlanSteps(["todo: Viết test", "todo: Viết test", "todo: Viết test"]);
  assert.deepEqual(steps.map((step) => step.id), ["viet-test", "viet-test-2", "viet-test-3"]);
});

test("the legacy buckets are derived from rich steps and the other way round", () => {
  const steps = parsePlanSteps(["done: Đọc mã", "doing: Viết test", "todo: Chạy suite"]);
  assert.deepEqual(legacyBucketsFromSteps(steps), {
    completed: ["Đọc mã"],
    inProgress: "Viết test",
    pending: ["Chạy suite"],
  });
  const derived = stepsFromLegacyBuckets({ completed: ["Đọc mã"], inProgress: "Viết test", pending: ["Chạy suite"] });
  assert.deepEqual(derived.map((step) => step.status), ["completed", "in_progress", "pending"]);
  assert.deepEqual(derived.map((step) => step.title), ["Đọc mã", "Viết test", "Chạy suite"]);
});

test("merging prefers rich steps and keeps a previous list when the update has none", () => {
  const first = mergePlanSnapshot(undefined, {
    completed: Object.freeze([]),
    inProgress: "Viết test",
    pending: Object.freeze([]),
    steps: parsePlanSteps(["doing: Viết test"]),
  });
  assert.equal(first.steps.length, 1);
  assert.equal(first.inProgress, "Viết test");

  const legacyOnly = mergePlanSnapshot(first, { completed: Object.freeze(["Đọc mã"]), inProgress: null, pending: Object.freeze([]) });
  assert.deepEqual(legacyOnly.completed, ["Đọc mã"]);
  assert.equal(legacyOnly.steps.length, 1, "a legacy-only update keeps the steps the host already renders");

  const untouched = mergePlanSnapshot(first, { completed: Object.freeze([]), inProgress: null, pending: Object.freeze([]) });
  assert.equal(untouched.steps.length, 1, "an update with neither steps nor buckets never blanks what the host renders");

  const skipped = mergePlanSnapshot(first, { completed: Object.freeze([]), inProgress: null, pending: Object.freeze([]), steps: parsePlanSteps(["skip: Viết test"]) });
  assert.deepEqual(skipped.steps.map((step) => step.status), ["skipped"], "an explicit update replaces the list");
});
