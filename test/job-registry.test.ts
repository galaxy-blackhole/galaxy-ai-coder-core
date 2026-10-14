import assert from "node:assert/strict";
import { test } from "node:test";
import { JobRegistry, type JobRow } from "../src/adapters/node/host/job-registry.js";

const registry = new JobRegistry();

test("a job is started, read, and listed", async () => {
  const job = registry.start("echo xin chao", { cwd: process.cwd(), kind: "command" });
  assert.match(job.id, /^job-\d+$/);
  assert.equal(job.status, "running");
  const read = await registry.output(job.id, true, 5_000);
  assert.notEqual(read, null);
  assert.equal(read?.status, "completed");
  assert.match(read?.text ?? "", /xin chao/);
  assert.equal(registry.list().some((row: JobRow) => row.id === job.id), true);
});

test("a second read returns only what arrived since the first", async () => {
  const job = registry.start("echo mot; sleep 0.3; echo hai", { cwd: process.cwd(), kind: "command" });
  const first = await registry.output(job.id, true, 5_000);
  assert.match(first?.text ?? "", /mot/);
  const second = await registry.output(job.id, false, 0);
  assert.equal(second?.text, "");
});

test("a failed command is failed, not completed", async () => {
  const job = registry.start("exit 3", { cwd: process.cwd(), kind: "command" });
  const read = await registry.output(job.id, true, 5_000);
  assert.equal(read?.status, "failed");
  assert.equal(read?.exitCode, 3);
});

test("a job that will not end is ended", async () => {
  const job = registry.start("sleep 30", { cwd: process.cwd(), kind: "command" });
  assert.equal(registry.kill(job.id), true);
  /*
   * A kill is a signal and a reap, and how long that takes is the machine's business rather than this test's: a busy
   * CI runner does it slower than a laptop, which is how this went from green to red without anything changing in
   * the code under test. So the wait is a poll with a generous bound — the claim is that the job IS ended, not that
   * it ends inside ten seconds.
   */
  const deadline = Date.now() + 30_000;
  let read = await registry.output(job.id, false, 0);
  while (read?.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    read = await registry.output(job.id, false, 0);
  }
  assert.equal(read?.status, "killed");
  assert.equal(registry.kill(job.id), false);
});

test("an unknown job reads as nothing", async () => {
  assert.equal(await registry.output("job-9999", false, 0), null);
});
