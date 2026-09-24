import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseDeterministicFixture } from "../../src/domain/fixture.js";
import { loadFixtures } from "../../src/io/load-fixtures.js";
import { runDeterministicCampaign } from "../../src/lab/run-campaign.js";

async function findLockFiles(directory: string): Promise<readonly string[]> {
  const found: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".galaxy-code.lock")) found.push(path);
    }
  };
  await visit(directory);
  return Object.freeze(found.sort());
}

test("progressive campaign keeps one project correct through failure and fresh-host resume", async (context) => {
  const loaded = await loadFixtures(resolve("campaigns/progressive-project"));
  assert.deepEqual(loaded.map((item) => item.fixture.name), [
    "campaign 01 scaffold project",
    "campaign 02 inspect existing project",
    "campaign 03 edit with observed hashes",
    "campaign 04 empty terminal response",
    "campaign 05 fresh host resume",
  ]);

  const campaignHashes = new Set<string>();
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const workspacePath = await mkdtemp(join(tmpdir(), `galaxy-code-campaign-${iteration}-`));
    context.after(() => rm(workspacePath, { recursive: true, force: true }));
    const report = await runDeterministicCampaign({
      fixtures: loaded.map((item) => item.fixture),
      workspacePath,
    });

    assert.equal(report.passed, true, report.failures.join("\n"));
    assert.equal(report.plannedStages, 5);
    assert.equal(report.completedStages, 5);
    assert.equal(new Set(report.reports.map((item) => item.runId)).size, 5, "each stage needs isolated run state");
    assert.deepEqual(report.reports.map((item) => item.status), ["completed", "completed", "completed", "failed", "completed"]);

    const emptyTerminal = report.reports[3];
    assert.ok(emptyTerminal);
    assert.equal(emptyTerminal.passed, true, emptyTerminal.failures.join("\n"));
    assert.equal(emptyTerminal.error?.code, "INVALID_MODEL_STREAM");
    assert.equal(emptyTerminal.modelRequestCount, 1);
    assert.deepEqual(emptyTerminal.toolSequence, []);

    const resumed = report.reports[4];
    assert.ok(resumed);
    assert.equal(resumed.passed, true, resumed.failures.join("\n"));
    assert.deepEqual(resumed.executionStatuses, ["failed", "completed"]);
    assert.deepEqual(resumed.checkpointReasons, ["provider_overflow", "failure"]);
    assert.deepEqual(resumed.toolSequence, [
      "list_files",
      "update_checkpoint",
      "search_tools",
      "write_file",
      "update_checkpoint",
      "validate_project",
      "git_operation",
    ]);
    assert.equal(resumed.modelContextAudit.allRequestsContainTask, true);
    assert.equal(resumed.checkpointAudits.at(-1)?.editPaths.includes("docs/usage.md"), true);

    assert.match(await readFile(join(workspacePath, "src/math.js"), "utf8"), /export function multiply/);
    assert.match(await readFile(join(workspacePath, "test/math.test.mjs"), "utf8"), /multiply\(4, 5\), 20/);
    assert.match(await readFile(join(workspacePath, "docs/usage.md"), "utf8"), /Run `npm test`/);
    assert.deepEqual(await findLockFiles(workspacePath), []);
    campaignHashes.add(report.campaignReplayHash);
  }
  assert.equal(campaignHashes.size, 1, "campaign replay hash must not depend on the temporary workspace root");
});

test("campaign rejects shared run identities and stops after the first unexpected result", async (context) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "galaxy-code-campaign-stop-"));
  context.after(() => rm(workspacePath, { recursive: true, force: true }));
  const unexpectedEmpty = parseDeterministicFixture({
    schemaVersion: 2,
    name: "unexpected empty stage",
    task: "This deliberately has the wrong oracle.",
    runtime: { completion: { requireInspection: false, requireFinalReportPersistence: false } },
    rounds: [{ content: "", finishReason: "stop" }],
    expected: { status: "completed", errorCode: null, allowedChanges: [], allModelStepsConsumed: true },
  });
  const unreachable = parseDeterministicFixture({
    schemaVersion: 2,
    name: "unreachable stage",
    task: "This stage must not run after an unexpected failure.",
    runtime: { completion: { requireInspection: false, requireFinalReportPersistence: false } },
    rounds: [{ content: "unreachable", finishReason: "stop" }],
    expected: { status: "completed", errorCode: null, allowedChanges: [], allModelStepsConsumed: true },
  });

  const report = await runDeterministicCampaign({ fixtures: [unexpectedEmpty, unreachable], workspacePath });
  assert.equal(report.passed, false);
  assert.equal(report.completedStages, 1);
  assert.equal(report.plannedStages, 2);
  assert.match(report.failures.join("\n"), /stage 1 \(unexpected empty stage\)/);

  await assert.rejects(
    () => runDeterministicCampaign({ fixtures: [unexpectedEmpty, unexpectedEmpty], workspacePath }),
    /unique fixture names/,
  );
});

test("campaign arrangement treats an identical initial file as an idempotent no-op", async (context) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "galaxy-code-campaign-idempotent-"));
  context.after(() => rm(workspacePath, { recursive: true, force: true }));
  const sharedFile = { path: "package.json", content: "{\"private\":true}\n" };
  const stage = (name: string) => parseDeterministicFixture({
    schemaVersion: 2,
    name,
    task: "Confirm identical campaign arrangement remains safe.",
    initialFiles: [sharedFile],
    runtime: { completion: { requireInspection: false, requireValidation: false } },
    rounds: [{ content: "No workspace mutation was required.", finishReason: "stop" }],
    expected: { status: "completed", errorCode: null, allowedChanges: [], allModelStepsConsumed: true },
  });

  const report = await runDeterministicCampaign({
    fixtures: [stage("idempotent stage one"), stage("idempotent stage two")],
    workspacePath,
  });

  assert.equal(report.passed, true, report.failures.join("\n"));
  assert.equal(report.completedStages, 2);
  assert.equal(await readFile(join(workspacePath, "package.json"), "utf8"), sharedFile.content);
});
