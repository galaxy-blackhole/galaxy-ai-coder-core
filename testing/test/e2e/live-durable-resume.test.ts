import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);

type WorkerReport = Readonly<{
  changedPaths: readonly string[];
  checkpointReasons: readonly string[];
  errorCode: string | null;
  finalReportStored: boolean;
  firstChatToolCount: number | null;
  modelRequests: number;
  persistence: Readonly<{ kind: string; resumed: boolean; resumedCheckpointHash: string | null }>;
  pid: number;
  status: string;
  toolSequence: readonly string[];
}>;

async function worker(stage: "checkpoint" | "resume", workspace: string, store: string): Promise<WorkerReport> {
  const path = resolve("test/helpers/live-durable-resume-worker.ts");
  const result = await execFileAsync(process.execPath, ["--import", "tsx", path, stage, workspace, store], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 60_000,
  });
  return JSON.parse(result.stdout) as WorkerReport;
}

test("live Ollama protocol resumes from FileRunStore in a separate process without repeating tools", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-live-durable-"));
  testContext.after(async () => rm(root, { force: true, recursive: true }));
  const workspace = join(root, "workspace");
  const store = join(root, "trusted-store");
  await Promise.all([mkdir(workspace), mkdir(store)]);

  const first = await worker("checkpoint", workspace, store);
  assert.equal(first.status, "failed");
  assert.equal(first.errorCode, "PROVIDER_ERROR");
  assert.deepEqual(first.checkpointReasons, ["failure"]);
  assert.deepEqual(first.toolSequence, ["list_files", "write_file", "validate_project", "git_operation"]);
  assert.equal(first.persistence.kind, "durable");
  assert.equal(first.persistence.resumed, false);
  assert.equal(first.finalReportStored, false);

  const second = await worker("resume", workspace, store);
  assert.notEqual(second.pid, first.pid);
  assert.equal(second.status, "completed");
  assert.equal(second.errorCode, null);
  assert.equal(second.modelRequests, 1);
  assert.equal(second.firstChatToolCount, null, "tool-free resume must omit Ollama's optional tools field");
  assert.deepEqual(second.toolSequence, []);
  assert.deepEqual(second.changedPaths, ["hello.txt"]);
  assert.equal(second.persistence.kind, "durable");
  assert.equal(second.persistence.resumed, true);
  assert.match(second.persistence.resumedCheckpointHash ?? "", /^sha256:/);
  assert.equal(second.finalReportStored, true);
});
