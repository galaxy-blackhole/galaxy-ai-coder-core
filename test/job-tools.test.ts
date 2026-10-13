import assert from "node:assert/strict";
import { test } from "node:test";
import { JobRegistry } from "../src/adapters/node/host/job-registry.js";

/**
 * The end-to-end shape of background work: a command is started, its id comes back at once, and its output arrives
 * when it is asked for. This is what a long build needs — a call that returns immediately instead of one that holds
 * a tool call open until its deadline ends the run.
 */
test("a background command returns an id, and its output is read afterwards", async () => {
  const registry = new JobRegistry();
  const started = Date.now();
  const job = registry.start("echo bat dau; sleep 0.4; echo ket thuc", { cwd: process.cwd(), kind: "command" });
  assert.ok(Date.now() - started < 250, "starting must not wait for the command");
  assert.match(job.id, /^job-\d+$/);
  assert.equal(job.status, "running");
  const first = await registry.output(job.id, false, 0);
  assert.equal(first?.status, "running");
  const done = await registry.output(job.id, true, 5_000);
  assert.equal(done?.status, "completed");
  assert.match(done?.text ?? "", /ket thuc/);
  const rows = registry.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "command");
});
