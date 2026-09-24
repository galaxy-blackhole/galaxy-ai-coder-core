import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { CORE_CONTRACT_VERSIONS, executeCliCommand } from "../../src/application.js";
import type { OutputWriter } from "../../src/io/output.js";

function captureOutput(): { readonly errors: string[]; readonly lines: string[]; readonly writer: OutputWriter } {
  const errors: string[] = [];
  const lines: string[] = [];
  return {
    errors,
    lines,
    writer: {
      write: (text) => { lines.push(text); },
      writeError: (text) => { errors.push(text); },
    },
  };
}

test("tools command exposes only adapter-backed lab tools", async () => {
  const output = captureOutput();
  const exitCode = await executeCliCommand({ kind: "tools", format: "json" }, {
    cwd: process.cwd(),
    output: output.writer,
  });

  assert.equal(exitCode, 0);
  const report = JSON.parse(output.lines.join("\n")) as { catalogCount: number; tools: { id: string }[] };
  assert.equal(report.catalogCount, 12);
  assert.equal(report.tools.some((tool) => tool.id === "research.search"), false);
  assert.equal(report.tools.some((tool) => tool.id === "git.exec"), true);
});

test("prompt command returns replay identifiers and a separated user-task envelope", async () => {
  const output = captureOutput();
  const exitCode = await executeCliCommand({ kind: "prompt", task: "Inspect the parser", format: "json" }, {
    cwd: process.cwd(),
    output: output.writer,
  });

  assert.equal(exitCode, 0);
  const report = JSON.parse(output.lines.join("\n")) as {
    promptHash: string;
    promptVersion: string;
    systemPrompt: string;
    userTask: string;
  };
  assert.match(report.promptHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(report.promptVersion, CORE_CONTRACT_VERSIONS.prompt);
  assert.equal(report.systemPrompt.includes("Inspect the parser"), false);
  assert.match(report.userTask, /Inspect the parser/);
});

test("run without --workspace uses and removes a temporary workspace instead of the CLI cwd", async (context) => {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "galaxy-code-source-sentinel-"));
  context.after(() => rm(sourceDirectory, { recursive: true, force: true }));
  const sentinelPath = join(sourceDirectory, "package.json");
  const sentinel = "{\"private\":true,\"name\":\"must-survive\"}\n";
  await writeFile(sentinelPath, sentinel, "utf8");
  const output = captureOutput();

  const exitCode = await executeCliCommand({
    kind: "run",
    fixturePath: resolve("fixtures/write-and-validate.json"),
    format: "json",
  }, {
    cwd: sourceDirectory,
    output: output.writer,
  });

  assert.equal(exitCode, 0);
  assert.equal(await readFile(sentinelPath, "utf8"), sentinel);
  const report = JSON.parse(output.lines.join("\n")) as { retainedWorkspace: null; workspacePath: string };
  assert.equal(report.retainedWorkspace, null);
  await assert.rejects(access(report.workspacePath));
});

test("run rejects an explicitly retained workspace that is not empty", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-nonempty-run-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "sentinel.txt"), "preserve me", "utf8");

  await assert.rejects(
    executeCliCommand({
      kind: "run",
      fixturePath: resolve("fixtures/write-and-validate.json"),
      workspacePath: workspace,
      format: "json",
    }, {
      cwd: process.cwd(),
      output: captureOutput().writer,
    }),
    /workspace must be empty/,
  );
  assert.equal(await readFile(join(workspace, "sentinel.txt"), "utf8"), "preserve me");
});
