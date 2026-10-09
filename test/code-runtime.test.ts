/**
 * The sandbox contract: a program can call tools, cannot reach the machine any other way, and never hangs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkerCodeRuntime } from "../src/adapters/node/code-runtime/worker-code-runtime.js";

const runtime = new WorkerCodeRuntime();
const limits = { heapMb: 256, maxToolCalls: 8, outputBytes: 4096, wallClockMs: 20_000 } as const;

test("a program may call tools, log, and return a value", async () => {
  const seen: string[] = [];
  const result = await runtime.run({
    callTool: async (name, args) => {
      seen.push(name + " " + JSON.stringify(args));
      return { ok: true, value: "file-a\nfile-b" };
    },
    goal: "list the workspace",
    limits,
    program: [
      'const listing = await list_files({ path: "." });',
      'console.log("listed", listing);',
      'const first = listing.split("\\n")[0];',
      "return { first };",
    ].join("\n"),
    toolNames: ["list_files"],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(seen, ['list_files {"path":"."}']);
  assert.match(result.ok ? result.value : "", /file-a/, "the program's value comes back as JSON");
  assert.ok(result.logs.some(line => line.includes("listed")), "console.log is captured: " + JSON.stringify(result.logs));
});

test("the sandbox has no ambient authority: no loader, no process, no filesystem", async () => {
  const result = await runtime.run({
    callTool: async () => ({ ok: true, value: null }),
    goal: "probe the machine",
    limits,
    program: [
      'const report = {};',
      'try { require("node:fs"); report.loader = "escaped"; } catch (error) { report.loader = "no loader"; }',
      'report.process = typeof process;',
      'try { await import("node:fs"); report.dynamic = "escaped"; } catch (error) { report.dynamic = "refused"; }',
      "return report;",
    ].join("\n"),
    toolNames: [],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.ok ? result.value : "", /no loader/, "require is not available");
  assert.match(result.ok ? result.value : "", /"process":"undefined"/, "process is not in scope");
  assert.match(result.ok ? result.value : "", /refused|escaped/, "a dynamic import is refused or unresolved, never a live fs");
});

test("a program that never finishes is killed at the deadline", async () => {
  const started = Date.now();
  const result = await runtime.run({
    callTool: async () => ({ ok: true, value: null }),
    goal: "spin",
    limits: { ...limits, wallClockMs: 700 },
    program: "while (true) {}",
    toolNames: [],
  });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.ok === false ? result.code : "", "RUN_CODE_TIMEOUT");
  assert.ok(Date.now() - started < 15_000, "the deadline is what ended it, not the test timeout");
});

test("a denied tool call throws inside the program, where it can be caught", async () => {
  const result = await runtime.run({
    callTool: async () => ({ code: "APPROVAL_DENIED", error: "the human said no", ok: false }),
    goal: "write",
    limits,
    program: [
      'let outcome = "";',
      'try { await write_file({ path: "a.txt", content: "x" }); outcome = "allowed"; }',
      'catch (error) { outcome = "denied: " + error.message; }',
      "return outcome;",
    ].join("\n"),
    toolNames: ["write_file"],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.ok ? result.value : "", /denied: the human said no/);
});

test("a program that fails reports why, with its logs", async () => {
  const result = await runtime.run({
    callTool: async () => ({ ok: true, value: null }),
    goal: "fail",
    limits,
    program: 'console.log("before"); throw new Error("boom");',
    toolNames: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.code : "", "RUN_CODE_FAILED");
  assert.match(result.ok === false ? result.error : "", /boom/);
});
test("a call that waits for a human does not spend the program's clock", async () => {
  const result = await runtime.run({
    callTool: async () => {
      await new Promise(resolve => setTimeout(resolve, 900));
      return { ok: true, value: "late but allowed" };
    },
    goal: "wait for an approval",
    limits: { ...limits, wallClockMs: 400 },
    program: 'const answer = await ask_user({ questions: [] }); return answer;',
    toolNames: ["ask_user"],
  });
  assert.equal(result.ok, true, "a human thinking is not the program looping: " + JSON.stringify(result));
  assert.match(result.ok ? result.value : "", /late but allowed/);
});

test("inner calls are reported to the host as they happen", async () => {
  const events: string[] = [];
  const result = await runtime.run({
    callTool: async () => ({ ok: true, value: "ok" }),
    goal: "report",
    limits,
    onEvent: (event) => {
      events.push(event.type === "code/log" ? "log:" + event.text : event.type + ":" + (event.type === "code/tool-start" ? event.name : event.summary));
    },
    program: 'console.log("hello"); await list_files({ path: "." }); return "done";',
    toolNames: ["list_files"],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(events, ["log:hello", "code/tool-start:list_files", "code/tool-result:ok"], JSON.stringify(events));
});
