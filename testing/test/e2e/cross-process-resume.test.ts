import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

type WorkerReport = Readonly<{
  checkpointDiff: Readonly<{ diffHash: string; sequence: number; workspaceFingerprint: string }> | null;
  checkpointHash: string | null;
  checkpointOpenProblems: readonly string[];
  checkpointWorkspaceFingerprint: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  finalReportStored: boolean;
  firstRequestToolCount: number | null;
  modelRequests: number;
  pid: number;
  state: string;
  toolStarts: number;
  writes: readonly string[];
}>;

async function runWorker(stage: "pause" | "resume", workspace: string, store: string): Promise<WorkerReport> {
  const worker = resolve("test/helpers/cross-process-resume-worker.ts");
  const result = await execFileAsync(process.execPath, ["--import", "tsx", worker, stage, workspace, store], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout) as WorkerReport;
}

test("a fresh process loads a durable checkpoint and resumes directly in tool-free finalization", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-cross-process-"));
  const workspace = join(root, "workspace");
  const store = join(root, "trusted-host-store");
  testContext.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(workspace);
  await mkdir(store);

  const paused = await runWorker("pause", workspace, store);
  assert.equal(paused.state, "paused");
  assert.equal(paused.errorCode, null);
  assert.equal(paused.modelRequests, 4);
  assert.equal(paused.toolStarts, 4);
  assert.deepEqual(paused.writes, ["hello.txt"]);
  assert.match(paused.checkpointHash ?? "", /^sha256:/);
  assert.equal(paused.finalReportStored, false);

  const resumed = await runWorker("resume", workspace, store);
  assert.notEqual(resumed.pid, paused.pid);
  assert.equal(resumed.state, "completed", JSON.stringify(resumed));
  assert.equal(resumed.errorCode, null);
  assert.equal(resumed.modelRequests, 1);
  assert.equal(resumed.firstRequestToolCount, 0, "verified checkpoint evidence must restore finalization mode");
  assert.equal(resumed.toolStarts, 0, "the new process must not repeat prior tool calls");
  assert.deepEqual(resumed.writes, ["hello.txt"]);
  assert.equal(resumed.checkpointHash, paused.checkpointHash);
  assert.equal(resumed.finalReportStored, true);
  assert.equal(await readFile(join(workspace, "hello.txt"), "utf8"), "hello\n");
});
