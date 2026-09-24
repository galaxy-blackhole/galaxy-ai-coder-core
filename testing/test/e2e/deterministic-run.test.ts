import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseDeterministicFixture } from "../../src/domain/fixture.js";
import { loadFixtures } from "../../src/io/load-fixtures.js";
import { runDeterministicFixture } from "../../src/lab/run-fixture.js";

test("deterministic fixture exercises inspect, write, validate, and final diff gates", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-e2e-"));
  const replayWorkspace = await mkdtemp(join(tmpdir(), "galaxy-code-replay-"));
  context.after(async () => {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(replayWorkspace, { recursive: true, force: true }),
    ]);
  });
  const [loaded] = await loadFixtures(resolve("fixtures/write-and-validate.json"));
  assert.ok(loaded);

  const report = await runDeterministicFixture({ fixture: loaded.fixture, workspacePath: workspace });

  assert.equal(report.passed, true, report.failures.join("\n"));
  assert.equal(report.status, "completed");
  assert.deepEqual(report.toolSequence, [
    "list_files",
    "write_file",
    "validate_project",
    "search_tools",
    "git_operation",
  ]);
  assert.equal(report.writes.length, 1);
  assert.equal(report.validation.some((entry) => entry.status === "passed"), true);

  const replay = await runDeterministicFixture({ fixture: loaded.fixture, workspacePath: replayWorkspace });
  assert.equal(replay.passed, true, replay.failures.join("\n"));
  assert.equal(replay.replayHash, report.replayHash);
});

test("the checked-in recursive fixture suite is executable as one deterministic eval set", async (context) => {
  const loaded = await loadFixtures(resolve("fixtures"));
  assert.equal(loaded.length >= 6, true);
  assert.equal(new Set(loaded.map((item) => item.fixture.name)).size, loaded.length);
  for (const item of loaded) {
    const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-suite-"));
    context.after(() => rm(workspace, { recursive: true, force: true }));
    const report = await runDeterministicFixture({ fixture: item.fixture, workspacePath: workspace });
    assert.equal(report.passed, true, `${item.fixture.name}: ${report.failures.join("\n")}`);
    assert.equal(report.checkpointsValid, true, item.fixture.name);
  }
});

test("repeated compaction fixture remains replay-stable across isolated workspaces", async (context) => {
  const [loaded] = await loadFixtures(resolve("fixtures/scenarios/repeated-compaction-write.json"));
  assert.ok(loaded);
  const replayHashes = new Set<string>();
  const checkpointHashes = new Set<string>();
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const workspace = await mkdtemp(join(tmpdir(), `galaxy-code-soak-${iteration}-`));
    context.after(() => rm(workspace, { recursive: true, force: true }));
    const report = await runDeterministicFixture({ fixture: loaded.fixture, workspacePath: workspace });
    assert.equal(report.passed, true, `iteration ${iteration}: ${report.failures.join("\n")}`);
    assert.equal(report.modelContextAudit.allRequestsContainTask, true);
    assert.equal(report.checkpointAudits.length, 4);
    assert.equal(report.modelContextAudit.observedCheckpointHashes.length, 4);
    assert.deepEqual(report.checkpointAudits.map((item) => item.compactionCount), [1, 2, 3, 4]);
    replayHashes.add(report.replayHash);
    for (const audit of report.checkpointAudits) checkpointHashes.add(audit.contentHash);
  }
  assert.equal(replayHashes.size, 1, "replay hash must not depend on the temporary workspace root");
  assert.equal(checkpointHashes.size > 4, true, "checkpoint hashes should still bind the concrete workspace root");
});

test("long multilingual fixture preserves the task and progressive evidence through twelve compactions", async (context) => {
  const [loaded] = await loadFixtures(resolve("fixtures/scenarios/long-context-multilanguage.json"));
  assert.ok(loaded);
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-long-context-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const report = await runDeterministicFixture({ fixture: loaded.fixture, workspacePath: workspace });

  assert.equal(report.passed, true, report.failures.join("\n"));
  assert.equal(report.modelContextAudit.allRequestsContainTask, true);
  assert.equal(report.checkpointAudits.length, 12);
  assert.equal(report.modelContextAudit.observedCheckpointHashes.length, 12);
  assert.deepEqual(report.checkpointAudits.map((item) => item.compactionCount), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.deepEqual(report.checkpointAudits.at(-1)?.editPaths, [
    "generated",
    "generated/handler.ts",
    "python/generated.py",
    "rust/src/generated.rs",
  ]);
  assert.deepEqual(report.checkpointAudits.at(-1)?.validationIds, ["project.validate:test:."]);
  assert.equal(report.checkpointAudits.at(-1)?.diffReviewed, true);
});

test("fixture completeness rejects an unused token-count queue and an unfired control", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-incomplete-fixture-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const fixture = parseDeterministicFixture({
    schemaVersion: 2,
    name: "detect incomplete fixture consumption",
    task: "Finish without consuming deliberately unreachable scripted steps.",
    controls: [{ event: "tool_start", occurrence: 99, action: "pause" }],
    model: { tokenCountSteps: Array.from({ length: 64 }, () => 1) },
    runtime: { completion: { requireInspection: false, requireValidation: false } },
    rounds: [{ content: "Finished the bounded fixture.", finishReason: "stop" }],
    expected: {
      status: "completed",
      errorCode: null,
      allowedChanges: [],
      allModelStepsConsumed: true,
    },
  });

  const report = await runDeterministicFixture({ fixture, workspacePath: workspace });

  assert.equal(report.status, "completed");
  assert.equal(report.passed, false);
  assert.equal(report.allModelStepsConsumed, false);
  assert.equal(report.controlsFired, 0);
  assert.equal(report.modelRoundsConsumed, 1);
  assert.equal(report.modelTokenCountStepsConsumed < 64, true);
  assert.equal(report.failures.some((failure) => failure.includes("token-count steps")), true);
  assert.equal(report.failures.some((failure) => failure.includes("fixture controls to fire")), true);
});
