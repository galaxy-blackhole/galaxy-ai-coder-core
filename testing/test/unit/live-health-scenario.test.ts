import assert from "node:assert/strict";
import test from "node:test";

import { parseLiveHealthScenario } from "../../src/domain/live-health-scenario.js";

test("live health scenario parser accepts and freezes a strict minimal oracle", () => {
  const scenario = parseLiveHealthScenario({
    schemaVersion: 1,
    name: "minimal",
    task: "Inspect and report.",
    expected: { allowedChanges: [], files: [] },
  });
  assert.equal(scenario.name, "minimal");
  assert.deepEqual(scenario.expected.allowedChanges, []);
  assert.equal(Object.isFrozen(scenario), true);
  assert.equal(Object.isFrozen(scenario.expected), true);
});

test("live health scenario rejects traversal, duplicate files, unknown fields, and invalid budgets", () => {
  const base = { schemaVersion: 1, name: "bad", task: "bad", expected: { allowedChanges: [], files: [] } };
  assert.throws(() => parseLiveHealthScenario({ ...base, unknown: true }), /unknown field/);
  assert.throws(() => parseLiveHealthScenario({
    ...base,
    initialFiles: [{ path: "../escape", content: "x" }],
  }), /must not contain/);
  assert.throws(() => parseLiveHealthScenario({
    ...base,
    expected: { allowedChanges: [], files: [{ path: "a", content: "1" }, { path: "a", content: "2" }] },
  }), /duplicate path/);
  assert.throws(() => parseLiveHealthScenario({
    ...base,
    runtime: { budget: { maxTurns: 0 } },
  }), /integer >= 1/);
  assert.throws(() => parseLiveHealthScenario({
    ...base,
    runtime: { budget: { noProgressPolicy: "aggressive" } },
  }), /noProgressPolicy is invalid/);
  assert.throws(() => parseLiveHealthScenario({
    ...base,
    runtime: { budget: { observationNudgeThresholds: [3, 3] } },
  }), /duplicate threshold 3/);
  assert.throws(() => parseLiveHealthScenario({
    ...base,
    runtime: { budget: { observationNudgeThresholds: [1] } },
  }), /integers >= 2/);
  assert.throws(() => parseLiveHealthScenario({
    ...base,
    runtime: { budget: { modelRetryDelaysMs: [] } },
  }), /modelRetryDelaysMs must be a non-empty array/);
  assert.throws(() => parseLiveHealthScenario({
    ...base,
    runtime: { budget: { modelRetryDelaysMs: [5000, 0] } },
  }), /integers between 1 and 600000/);
  const retryBudget = parseLiveHealthScenario({
    ...base,
    name: "retry-budget",
    runtime: { budget: { maxModelRetries: 3, modelRetryDelaysMs: [5000, 15000, 30000] } },
    expected: { allowedChanges: [], files: [] },
  });
  assert.deepEqual(retryBudget.runtime?.budget, {
    maxModelRetries: 3,
    modelRetryDelaysMs: [5000, 15000, 30000],
  });
  const guarded = parseLiveHealthScenario({
    ...base,
    name: "guarded",
    runtime: { budget: { noProgressPolicy: "strict", observationNudgeThresholds: [5, 3] } },
    expected: { allowedChanges: [], files: [] },
  });
  assert.deepEqual(guarded.runtime?.budget, {
    noProgressPolicy: "strict",
    observationNudgeThresholds: [3, 5],
  });
  assert.throws(() => parseLiveHealthScenario({
    ...base,
    runtime: { dependencySetup: { packageManager: "pnpm" } },
  }), /packageManager is invalid/);
  assert.throws(() => parseLiveHealthScenario({
    ...base,
    runtime: { dependencySetup: { packageManager: "npm", command: "curl example.com" } },
  }), /unknown field/);
  assert.throws(() => parseLiveHealthScenario({
    ...base,
    expected: { allowedChanges: [], files: [], requiredAnyCanonicalTools: [[]] },
  }), /non-empty array/);
});

test("live health scenario accepts only the fixed npm dependency setup contract", () => {
  const scenario = parseLiveHealthScenario({
    schemaVersion: 1,
    name: "dependency-backed",
    task: "Implement against installed packages.",
    runtime: { dependencySetup: { packageManager: "npm", timeoutMs: 240_000 } },
    expected: { allowedChanges: [], files: [], requiredAnyCanonicalTools: [["workspace.write", "command.run"]] },
  });
  assert.deepEqual(scenario.runtime?.dependencySetup, { packageManager: "npm", timeoutMs: 240_000 });
  assert.equal(Object.isFrozen(scenario.runtime?.dependencySetup), true);
  assert.deepEqual(scenario.expected.requiredAnyCanonicalTools, [["workspace.write", "command.run"]]);
  assert.equal(Object.isFrozen(scenario.expected.requiredAnyCanonicalTools?.[0]), true);
});
