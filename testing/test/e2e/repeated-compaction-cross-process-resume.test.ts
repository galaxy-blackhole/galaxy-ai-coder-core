import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

type WorkerReport = Readonly<{
  checkpointCompactions: number | null;
  checkpointHash: string | null;
  checkpointReason: string | null;
  compactTransitions: number;
  errorCode: string | null;
  finalReportStored: boolean;
  firstRequestContainsCheckpoint: boolean;
  firstRequestContainsOriginalTask: boolean;
  modelRequests: number;
  pid: number;
  state: string;
  tokenCountSteps: number;
  toolSequence: readonly string[];
  validation: readonly Readonly<{ id: string; status: string }>[];
  writes: readonly string[];
}>;

async function runWorker(stage: "pause" | "resume", workspace: string, store: string): Promise<WorkerReport> {
  const worker = resolve("test/helpers/compaction-resume-worker.ts");
  const result = await execFileAsync(process.execPath, ["--import", "tsx", worker, stage, workspace, store], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout) as WorkerReport;
}

test("a long run compacts repeatedly, restarts in a fresh process, and resumes without replay", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-long-compaction-resume-"));
  const workspace = join(root, "workspace");
  const store = join(root, "trusted-store");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(workspace);
  await mkdir(store);

  const paused = await runWorker("pause", workspace, store);
  assert.equal(paused.state, "paused", JSON.stringify(paused));
  assert.equal(paused.errorCode, null);
  assert.equal(paused.modelRequests, 6);
  assert.equal(paused.tokenCountSteps, 12);
  assert.equal(paused.compactTransitions, 6);
  assert.equal(paused.checkpointCompactions, 6);
  assert.equal(paused.checkpointReason, "pause");
  assert.deepEqual(paused.toolSequence, ["detect_project", "read_file", "read_file", "write_file", "read_file", "validate_project"]);
  assert.deepEqual(paused.writes, ["src", "src/order.mjs"]);
  assert.equal(paused.finalReportStored, false);
  assert.equal(paused.validation.at(-1)?.status, "passed");

  const resumed = await runWorker("resume", workspace, store);
  assert.notEqual(resumed.pid, paused.pid);
  assert.equal(resumed.state, "completed", JSON.stringify(resumed));
  assert.equal(resumed.errorCode, null);
  assert.equal(resumed.modelRequests, 3);
  assert.equal(resumed.tokenCountSteps, 6);
  assert.equal(resumed.compactTransitions, 3);
  assert.equal(resumed.checkpointCompactions, 9);
  assert.equal(resumed.checkpointReason, "provider_overflow");
  assert.deepEqual(resumed.toolSequence, ["search_text", "git_operation"]);
  assert.deepEqual(resumed.writes, ["src", "src/order.mjs"]);
  assert.equal(resumed.firstRequestContainsCheckpoint, true);
  assert.equal(resumed.firstRequestContainsOriginalTask, true);
  assert.equal(resumed.finalReportStored, true);
  assert.equal(resumed.validation.at(-1)?.status, "passed");
  assert.match(await readFile(join(workspace, "src/order.mjs"), "utf8"), /calculateTotal/);
});
