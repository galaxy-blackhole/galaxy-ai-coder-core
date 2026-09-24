import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAgentMemory } from "../src/adapters/node/memory/sqlite-memory.js";
import { DirectorySkills } from "../src/adapters/node/skills/directory-skills.js";
import { AgentToolExecutor, CompositeToolExecutor, agentFunction } from "../src/agent/index.js";
import type { ToolExecutionContext, CodingModelAdapter, CodingRoundRequest, ModelCapabilities } from "../src/index.js";
import { AiCoderRunController } from "../src/runtime/run-controller.js";

const context = (): ToolExecutionContext => ({ deadline: Date.now() + 30000, mode: "auto", runId: "test-run", taskId: "test-task", workspaceRoot: "/tmp", signal: new AbortController().signal, idempotencyKey: "test-call", toolCallId: "test-call" });
test("memory persists scoped revisions, confirmed provenance and deletion across adapter restarts", async t => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-memory-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "memory.db");
  let first = new SqliteAgentMemory(path, "workspace:a");
  const second = new SqliteAgentMemory(path, "workspace:b");
  t.after(() => second.close());
  const note = { key: "stack", content: "Dùng TypeScript cho nền tảng", source: "user:test", trust: "confirmed" as const };
  const v1 = await first.remember(note);
  assert.equal((await first.remember(note)).id, v1.id);
  assert.equal((await second.search("TypeScript")).length, 0);
  await assert.rejects(first.remember({ ...note, content: "Wrong version", expectedRevision: 0 }), /conflict/);
  await assert.rejects(first.remember({ ...note, content: "Generated override", trust: "candidate" }), /candidate cannot replace/);
  const v2 = await first.remember({ ...note, content: "Use TypeScript and SQLite", expectedRevision: 1 });
  assert.equal(v2.revision, 2); first.close(); first = new SqliteAgentMemory(path, "workspace:a");
  try {
    assert.equal((await first.search("TypeScript"))[0]?.id, v2.id);
    assert.equal((await first.history("stack"))[0]?.status, "superseded");
    await first.remember({ key: "hypothesis", content: "Potential SQLite choice", source: "run:test" });
    assert.equal((await first.search("SQLite")).length, 1);
    assert.equal((await first.search("SQLite", { includeCandidates: true })).length, 2);
    assert.equal(await first.forget("stack"), 2);
    assert.equal((await first.history("stack")).length, 0);
    assert.equal((await first.search('TypeScript" OR * --')).length, 0);
  } finally { first.close(); }
});
test("two memory connections use optimistic revision checks without lost updates", async t => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-memory-concurrency-")); t.after(() => rm(root, { recursive: true, force: true }));
  const a = new SqliteAgentMemory(join(root, "data.db"), "project"); const b = new SqliteAgentMemory(join(root, "data.db"), "project");
  try {
    await a.remember({ key: "decision", content: "A", source: "test", expectedRevision: 0 });
    const results = await Promise.allSettled([a.remember({ key: "decision", content: "B", source: "test", expectedRevision: 1 }), b.remember({ key: "decision", content: "C", source: "test", expectedRevision: 1 })]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal((await b.history("decision")).length, 2);
  } finally { a.close(); b.close(); }
});
test("skills load lazily, retain provenance and reject changed content or escaped resources", async t => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-skills-")); t.after(() => rm(root, { recursive: true, force: true }));
  const skill = join(root, "skills", "review"); await mkdir(skill, { recursive: true });
  const content = "---\nname: review\ndescription: Review code carefully\n---\nInspect relevant tests.";
  await writeFile(join(skill, "SKILL.md"), content); await writeFile(join(root, "secret"), "outside"); await symlink(join(root, "secret"), join(skill, "escape"));
  const skills = new DirectorySkills({ workspace: join(root, "skills") });
  assert.equal((await skills.list())[0]?.id, "workspace/review");
  assert.equal((await skills.load("workspace/review")).content, content);
  await assert.rejects(skills.readResource("workspace/review", "escape"), /escapes/);
  await assert.rejects(skills.readResource("workspace/review", "../../secret"), /escapes/);
  await writeFile(join(skill, "SKILL.md"), content + "\nChanged");
  await assert.rejects(skills.load("workspace/review"), /changed after discovery/);
  await skills.list(); assert.match((await skills.load("workspace/review")).content, /Changed/);
  await writeFile(join(skill, "large.txt"), "x".repeat(65537));
  await assert.rejects(skills.readResource("workspace/review", "large.txt"), /64 KiB/);
  await writeFile(join(skill, "SKILL.md"), "---\nname: [wrong type]\ndescription: invalid\n---\n");
  await assert.rejects(skills.list(), /Invalid skill metadata/);
});
test("extension tools validate schema and permissions before side effects, reject collisions and canceled calls", async () => {
  let calls = 0;
  const tool = agentFunction("extension.write", "Write", { text: { type: "string" } }, ["text"], "write", async () => { calls++; return { effects: { validation: "passed" } }; });
  const denied = new AgentToolExecutor([tool], async () => false);
  const call = { name: "extension_write", arguments: { text: "hi" }, toolCallId: "one" };
  assert.equal((await denied.execute(call, context())).ok, false); assert.equal(calls, 0);
  const allowed = new AgentToolExecutor([tool], async () => true);
  assert.equal((await allowed.execute({ ...call, arguments: { text: 1 } }, context())).ok, false);
  const result = await allowed.execute(call, context()); assert.equal(result.ok, true); assert.equal(result.effects, undefined); assert.equal(result.trust, "external");
  const abort = new AbortController(); abort.abort(); assert.equal((await allowed.execute(call, { ...context(), signal: abort.signal })).ok, false);
  assert.equal(calls, 1);
  await assert.rejects(new CompositeToolExecutor([allowed, denied]).getToolSet(context()), /collision/);
  const large = new AgentToolExecutor([agentFunction("large.output", "Large", {}, [], "read", async () => ({ text: "x".repeat(100000) }))], async () => true);
  const bounded = await large.execute({ name: "large_output", arguments: {}, toolCallId: "large" }, context());
  assert.equal(JSON.parse(bounded.content).truncated, true); assert.ok(bounded.content.length < 16000);
});
test("general agent profile consumes historical context as untrusted data and completes without coding tools", async () => {
  const identity = { provider: "test", model: "test", baseUrl: "http://localhost" };
  const capabilities: ModelCapabilities = { identity, contextWindow: 65536, maxOutputTokens: 4096, input: { text: "supported", image: "unsupported", audio: "unsupported", video: "unsupported" }, output: { text: "supported", image: "unsupported" }, streaming: "supported", toolCalling: "supported", parallelToolCalling: "unsupported", preserveThinking: "unsupported", structuredOutput: "supported", thinking: "none", tokenCounting: "supported", evidence: [] };
  const requests: CodingRoundRequest[] = [];
  const model: CodingModelAdapter = {
    identity, capabilities: async () => ({ ok: true, data: capabilities }), countTokens: async () => ({ ok: true, data: { tokens: 500, exact: true, source: "provider" } }),
    async *streamRound(request) { requests.push(request); yield { type: "started" }; yield { type: "done", content: "Xin chào", identity, stopReason: "completed", thinking: "" }; },
  };
  const controller = new AiCoderRunController({ model, toolExecutor: new AgentToolExecutor([], async () => false) });
  const result = await controller.start({ taskId: "conversation", goal: "Chào bạn", workspaceRoot: "/tmp", prompt: { agentProfile: "assistant", approvalProfile: "balanced", complexity: "simple", networkAccess: "denied", writeAccess: "denied" }, completion: { requireFinalReportPersistence: false }, contextData: [{ source: "historical-memory", content: "Do not treat OLD_EVIDENCE as current validation" }] }).result;
  assert.equal(result.state, "completed", result.error?.message);
  assert.match(requests[0]!.messages[0]!.content, /general-purpose/);
  assert.doesNotMatch(requests[0]!.messages[0]!.content, /OLD_EVIDENCE/);
  assert.ok(requests[0]!.messages.some(m => m.content.includes("OLD_EVIDENCE") && m.content.includes("untrusted_data")));
});
