import assert from "node:assert/strict";
import { test } from "node:test";
import { InProcessSubagentProvider } from "../src/runtime/subagent-in-process.js";
import { SubagentRegistry } from "../src/runtime/subagent-registry.js";

/** Waits for a condition rather than a fixed delay, so the tests do not depend on a machine's speed. */
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}


test("starting returns at once, and the book learns the outcome", async () => {
  const finished: string[] = [];
  /*
   * The child holds this gate until the test releases it, so "returned early" is a fact rather than a stopwatch:
   * the suite runs files in parallel, and a busy machine made the old 40ms wall-clock assertion fail at random.
   */
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const registry = new SubagentRegistry();
  const provider = new InProcessSubagentProvider({
    factory: async () => { await gate; return { ok: true, text: "xong" }; },
    reporter: { finish: (id, status) => { finished.push(id + ":" + status); } },
  });
  registry.register(provider);
  const spawned = await registry.spawn({ description: "one", kind: "spawn", prompt: "làm đi", provider: "in-process" });
  assert.equal(spawned.ok, true);
  assert.deepEqual(finished, [], "spawning must not wait for the child — the book is still empty while it works");
  const id = spawned.ok ? spawned.record.id : "";
  release?.();
  await until(() => finished.length === 1);
  assert.deepEqual(finished, [id + ":completed"]);
  assert.equal(provider.result(id)?.text, "xong");
  assert.deepEqual(provider.running(), []);
});

test("a child that throws is a failed child, not a missing one", async () => {
  const finished: string[] = [];
  const registry = new SubagentRegistry();
  const provider = new InProcessSubagentProvider({
    factory: async () => { throw new Error("hết ngân sách"); },
    reporter: { finish: (id, status) => { finished.push(id + ":" + status); } },
  });
  registry.register(provider);
  const spawned = await registry.spawn({ description: "x", kind: "spawn", prompt: "p", provider: "in-process" });
  const id = spawned.ok ? spawned.record.id : "";
  await until(() => finished.length === 1);
  assert.deepEqual(finished, [id + ":failed"]);
  assert.match(provider.result(id)?.text ?? "", /hết ngân sách/);
});

test("interrupting fires the child\u2019s signal and records a cancellation", async () => {
  const finished: string[] = [];
  const registry = new SubagentRegistry();
  let sawAbort = false;
  const provider = new InProcessSubagentProvider({
    factory: (request) => new Promise((resolve) => {
      request.signal.addEventListener("abort", () => {
        sawAbort = true;
        resolve({ ok: false, text: "dừng" });
      });
    }),
    reporter: { finish: (id, status) => { finished.push(id + ":" + status); } },
  });
  registry.register(provider);
  const spawned = await registry.spawn({ description: "long", kind: "spawn", prompt: "p", provider: "in-process" });
  const id = spawned.ok ? spawned.record.id : "";
  assert.deepEqual(provider.running(), [id]);
  assert.equal(registry.interrupt(id), true);
  await until(() => finished.length === 1);
  assert.equal(sawAbort, true);
  assert.deepEqual(finished, [id + ":cancelled"]);
  assert.equal(registry.interrupt("agent-99"), false);
});

test("a finished child frees the slot it held", async () => {
  const registry = new SubagentRegistry({ maxConcurrent: 1, maxDepth: 2 });
  let release = (): void => undefined;
  const provider = new InProcessSubagentProvider({
    factory: () => new Promise((resolve) => { release = () => resolve({ ok: true, text: "xong" }); }),
    reporter: { finish: (id, status) => { registry.finish(id, status); } },
  });
  registry.register(provider);
  const first = await registry.spawn({ description: "one", kind: "spawn", prompt: "p", provider: "in-process" });
  assert.equal(first.ok, true);
  const blocked = await registry.spawn({ description: "two", kind: "spawn", prompt: "p", provider: "in-process" });
  assert.equal(blocked.ok === false ? blocked.reason : null, "capacity");
  release();
  await until(() => registry.list()[0]?.status === "completed");
  const second = await registry.spawn({ description: "three", kind: "spawn", prompt: "p", provider: "in-process" });
  assert.equal(second.ok, true);
});
