import assert from "node:assert/strict";
import { test } from "node:test";
import { SubagentRegistry, type SubagentProvider } from "../src/runtime/subagent-registry.js";

/** A backend that does nothing but remember what it was asked, so the seam can be tested on its own. */
function fakeProvider(): SubagentProvider & { readonly started: string[]; readonly words: string[]; readonly ended: string[] } {
  const started: string[] = [];
  const words: string[] = [];
  const ended: string[] = [];
  return {
    ended,
    name: "in-process",
    send: (id, message) => { words.push(id + ":" + message); return true; },
    interrupt: (id) => { ended.push(id); return true; },
    start: (record) => { started.push(record.id); },
    started,
    words,
  };
}

test("a child is started under its provider, and appears in the list", async () => {
  const registry = new SubagentRegistry();
  const provider = fakeProvider();
  registry.register(provider);
  const result = await registry.spawn({ description: "Read the config", kind: "spawn", prompt: "read it", provider: "in-process" });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.record.id : null, "agent-1");
  assert.equal(result.ok ? result.record.status : null, "running");
  assert.deepEqual(provider.started, ["agent-1"]);
  assert.equal(registry.list().length, 1);
});

test("an unknown backend is refused by name, not guessed at", async () => {
  const registry = new SubagentRegistry();
  const result = await registry.spawn({ description: "x", kind: "spawn", prompt: "y", provider: "nowhere" });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : null, "unknown_provider");
  assert.equal(registry.list().length, 0);
});

test("depth is bounded: a child of a child of a child is refused", async () => {
  const registry = new SubagentRegistry({ maxConcurrent: 10, maxDepth: 2 });
  registry.register(fakeProvider());
  const first = await registry.spawn({ description: "one", kind: "spawn", prompt: "p", provider: "in-process" });
  assert.equal(first.ok, true);
  const second = await registry.spawn({ description: "two", kind: "spawn", parentId: first.ok ? first.record.id : null, prompt: "p", provider: "in-process" });
  assert.equal(second.ok, true);
  assert.equal(second.ok ? second.record.depth : -1, 2);
  const third = await registry.spawn({ description: "three", kind: "spawn", parentId: second.ok ? second.record.id : null, prompt: "p", provider: "in-process" });
  assert.equal(third.ok, false);
  assert.equal(third.ok === false ? third.reason : null, "depth");
});

test("width is bounded, and the refusal says so", async () => {
  const registry = new SubagentRegistry({ maxConcurrent: 2, maxDepth: 3 });
  registry.register(fakeProvider());
  for (let index = 0; index < 2; index += 1) {
    const ok = await registry.spawn({ description: "d" + index, kind: "spawn", prompt: "p", provider: "in-process" });
    assert.equal(ok.ok, true);
  }
  const overflow = await registry.spawn({ description: "third", kind: "spawn", prompt: "p", provider: "in-process" });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.ok === false ? overflow.reason : null, "capacity");
});

test("a finished child frees its slot, and words and stops reach the backend", async () => {
  const registry = new SubagentRegistry({ maxConcurrent: 1, maxDepth: 2 });
  const provider = fakeProvider();
  registry.register(provider);
  const first = await registry.spawn({ description: "one", kind: "spawn", prompt: "p", provider: "in-process" });
  assert.equal(first.ok, true);
  const blocked = await registry.spawn({ description: "two", kind: "spawn", prompt: "p", provider: "in-process" });
  assert.equal(blocked.ok === false ? blocked.reason : null, "capacity");
  const id = first.ok ? first.record.id : "";
  assert.equal(registry.send(id, "xin chao"), true);
  assert.deepEqual(provider.words, [id + ":xin chao"]);
  assert.equal(registry.interrupt(id), true);
  assert.deepEqual(provider.ended, [id]);
  registry.finish(id, "completed");
  assert.equal(registry.get(id)?.status, "completed");
  const after = await registry.spawn({ description: "three", kind: "spawn", prompt: "p", provider: "in-process" });
  assert.equal(after.ok, true);
});

test("a backend that throws leaves a failed record, not a running one", async () => {
  const registry = new SubagentRegistry();
  registry.register({ name: "in-process", start: () => { throw new Error("no room"); } });
  await assert.rejects(() => registry.spawn({ description: "x", kind: "spawn", prompt: "p", provider: "in-process" }));
  assert.equal(registry.list()[0]?.status, "failed");
});
