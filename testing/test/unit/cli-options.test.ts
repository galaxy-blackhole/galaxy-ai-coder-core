import assert from "node:assert/strict";
import test from "node:test";

import { parseCliCommand } from "../../src/domain/cli-options.js";

test("run command requires an explicit fixture", () => {
  assert.throws(() => parseCliCommand(["run", "do", "work"], { cwd: "/tmp/work" }), /--fixture/);
});

test("run command keeps task, workspace and output format deterministic", () => {
  assert.deepEqual(
    parseCliCommand([
      "run",
      "create",
      "hello.txt",
      "--fixture",
      "fixtures/write.json",
      "--workspace",
      "/tmp/lab",
      "--json",
    ], { cwd: "/ignored" }),
    {
      kind: "run",
      task: "create hello.txt",
      fixturePath: "fixtures/write.json",
      workspacePath: "/tmp/lab",
      format: "json",
    },
  );
});

test("run command leaves workspace selection to the application when omitted", () => {
  assert.deepEqual(
    parseCliCommand(["run", "--fixture", "fixtures/write.json", "--json"], { cwd: "/must-not-be-used" }),
    {
      kind: "run",
      fixturePath: "fixtures/write.json",
      format: "json",
    },
  );
});

test("commands reject ambiguous or unrelated options", () => {
  assert.throws(
    () => parseCliCommand(["doctor", "--fixture", "x.json"], { cwd: "/tmp/work" }),
    /accepts only --json/,
  );
  assert.throws(
    () => parseCliCommand(["tools", "--json", "--json"], { cwd: "/tmp/work" }),
    /Duplicate option/,
  );
  assert.throws(
    () => parseCliCommand(["eval", "unexpected", "--fixture", "x.json"], { cwd: "/tmp/work" }),
    /does not accept a positional task/,
  );
});

test("campaign command accepts one ordered fixture source and an optional shared workspace", () => {
  assert.deepEqual(
    parseCliCommand([
      "campaign",
      "--fixture",
      "campaigns/progressive-project",
      "--workspace",
      "/tmp/shared-project",
      "--json",
    ], { cwd: "/ignored" }),
    {
      kind: "campaign",
      fixturePath: "campaigns/progressive-project",
      workspacePath: "/tmp/shared-project",
      format: "json",
    },
  );
});

test("health requires explicit live consent and a scenario", () => {
  assert.throws(
    () => parseCliCommand(["health", "--scenario", "live.json"], { cwd: "/tmp/work" }),
    /requires --live/,
  );
  assert.throws(
    () => parseCliCommand(["health", "--live"], { cwd: "/tmp/work" }),
    /requires --scenario/,
  );
  assert.deepEqual(
    parseCliCommand([
      "health", "--live", "--scenario", "live.json", "--workspace", "/tmp/health",
      "--store-dir", "/tmp/store", "--run-id", "live-123", "--resume",
      "--model", "kimi-k2.7-code:cloud", "--base-url", "https://ollama.example", "--config", "manual.json", "--json",
    ], { cwd: "/ignored" }),
    {
      kind: "health",
      live: true,
      resume: true,
      scenarioPath: "live.json",
      workspacePath: "/tmp/health",
      storeDir: "/tmp/store",
      runId: "live-123",
      model: "kimi-k2.7-code:cloud",
      baseUrl: "https://ollama.example",
      configPath: "manual.json",
      format: "json",
    },
  );
});

test("durable live options fail closed when resume identity or storage is incomplete", () => {
  assert.throws(
    () => parseCliCommand(["health", "--live", "--scenario", "live.json", "--resume"], { cwd: "/tmp/work" }),
    /requires --run-id, --store-dir, and --workspace/,
  );
  assert.throws(
    () => parseCliCommand(["health", "--live", "--scenario", "live.json", "--run-id", "run"], { cwd: "/tmp/work" }),
    /--run-id option requires --store-dir/,
  );
  assert.throws(
    () => parseCliCommand(["health", "--live", "--scenario", "live.json", "--store-dir", "store"], { cwd: "/tmp/work" }),
    /--store-dir option requires a persistent --workspace/,
  );
  assert.throws(
    () => parseCliCommand([
      "health", "--live", "--scenario", "live.json", "--workspace", "/tmp/workspace",
      "--store-dir", "/tmp/store", "--run-id", "run", "--resume", "--pause-after-tool-calls", "1",
    ], { cwd: "/tmp/work" }),
    /--resume command does not accept --pause-after-tool-calls/,
  );
  assert.throws(
    () => parseCliCommand([
      "health", "--live", "--scenario", "live.json", "--pause-after-tool-calls", "0",
    ], { cwd: "/tmp/work" }),
    /integer from 1 to 10000/,
  );
});

test("deterministic commands reject live-only provider flags", () => {
  assert.throws(
    () => parseCliCommand(["run", "--fixture", "x.json", "--model", "kimi"], { cwd: "/tmp/work" }),
    /does not accept --model/,
  );
  assert.throws(
    () => parseCliCommand(["tools", "--live"], { cwd: "/tmp/work" }),
    /does not accept --live/,
  );
});
