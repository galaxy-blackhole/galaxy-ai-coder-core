import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { writeFile, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

type CliResult = Readonly<{ code: number; stderr: string; stdout: string }>;

function ndjson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function tool(name: string, argumentsValue: Readonly<Record<string, unknown>>, id: string): unknown {
  return {
    done: true,
    done_reason: "stop",
    message: {
      content: "",
      role: "assistant",
      thinking: "",
      tool_calls: [{ function: { arguments: argumentsValue, name }, id, type: "function" }],
    },
  };
}

function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), ...args], {
      cwd: resolve("."),
      encoding: "utf8",
      timeout: 60_000,
    }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException | null)?.code === "number"
        ? (error as unknown as { code: number }).code
        : error === null ? 0 : 1;
      resolveResult(Object.freeze({ code, stderr, stdout }));
    });
  });
}

test("health CLI persists and resumes one Ollama run across process boundaries", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-live-cli-resume-"));
  const workspace = join(root, "workspace");
  const store = join(root, "trusted-store");
  const config = join(root, "config.json");
  await Promise.all([mkdir(workspace), mkdir(store), writeFile(config, "{\"agent\":[]}\n", "utf8")]);
  testContext.after(async () => rm(root, { force: true, recursive: true }));

  let phase: "checkpoint" | "resume" = "checkpoint";
  const requestBodies: string[] = [];
  const checkpointResponses: unknown[] = [
    tool("list_files", { depth: 2, path: "." }, "inspect"),
  ];
  const resumeResponses: unknown[] = [
    tool("write_file", { content: "hello\n", path: "hello.txt", precondition: { kind: "must_not_exist" } }, "write"),
    tool("validate_project", { checks: ["test"], path: ".", timeoutMs: 30_000 }, "validate"),
    tool("git_operation", { action: "diff", paths: ["hello.txt"] }, "diff"),
    {
      done: true,
      done_reason: "stop",
      message: { content: "CLI resumed, finished the edit, validated it, and reviewed the final diff.", role: "assistant", thinking: "", tool_calls: [] },
    },
  ];
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    await once(request, "end");
    requestBodies.push(body);
    response.setHeader("content-type", request.url === "/api/show" ? "application/json" : "application/x-ndjson");
    if (request.url === "/api/show") {
      response.end(JSON.stringify({ capabilities: ["completion", "tools", "thinking"], model_info: { "kimi.context_length": 262_144 } }));
      return;
    }
    const value = phase === "checkpoint" ? checkpointResponses.shift() : resumeResponses.shift();
    response.end(ndjson(value ?? { error: "unexpected extra request" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  testContext.after(async () => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const baseArgs = [
    "health", "--live", "--scenario", resolve("live/scenarios/01-write-and-validate.json"),
    "--workspace", workspace, "--store-dir", store, "--run-id", "live-cli-durable",
    "--base-url", `http://127.0.0.1:${address.port}`, "--config", config, "--json",
  ] as const;

  const first = await runCli([...baseArgs, "--pause-after-tool-calls", "1"]);
  assert.equal(first.code, 1, first.stderr);
  const firstReport = JSON.parse(first.stdout) as { checkpointReasons: string[]; status: string; toolSequence: string[] };
  assert.equal(firstReport.status, "paused");
  assert.deepEqual(firstReport.checkpointReasons, ["pause"]);
  assert.deepEqual(firstReport.toolSequence, ["list_files"]);

  phase = "resume";
  requestBodies.length = 0;
  const second = await runCli([...baseArgs, "--resume"]);
  assert.equal(second.code, 0, `${second.stderr}\n${second.stdout}`);
  const secondReport = JSON.parse(second.stdout) as {
    changedPaths: string[];
    persistence: { resumed: boolean; resumedCheckpointHash: string | null };
    status: string;
    toolSequence: string[];
  };
  assert.equal(secondReport.status, "completed");
  assert.equal(secondReport.persistence.resumed, true);
  assert.match(secondReport.persistence.resumedCheckpointHash ?? "", /^sha256:/);
  assert.deepEqual(secondReport.changedPaths, ["hello.txt"]);
  assert.deepEqual(secondReport.toolSequence, ["write_file", "validate_project", "git_operation"]);
  const firstResumedChat = JSON.parse(requestBodies[1] ?? "{}") as { tools?: unknown[] };
  assert.ok((firstResumedChat.tools?.length ?? 0) > 0);
  const finalResumedChat = JSON.parse(requestBodies.at(-1) ?? "{}") as { tools?: unknown[] };
  assert.equal(Object.hasOwn(finalResumedChat, "tools"), false);

  requestBodies.length = 0;
  const duplicateResume = await runCli([...baseArgs, "--resume"]);
  assert.equal(duplicateResume.code, 2);
  assert.match(duplicateResume.stderr, /already completed and cannot be overwritten or resumed/);
  assert.deepEqual(requestBodies, [], "a completed run must be rejected before provider access");
});

test("health CLI rejects a durable store overlapping the model-writable workspace before provider access", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-live-store-scope-"));
  const workspace = join(root, "workspace");
  const config = join(root, "config.json");
  await Promise.all([mkdir(workspace), writeFile(config, "{\"agent\":[]}\n", "utf8")]);
  testContext.after(async () => rm(root, { force: true, recursive: true }));

  const result = await runCli([
    "health", "--live", "--scenario", resolve("live/scenarios/01-write-and-validate.json"),
    "--workspace", workspace, "--store-dir", join(await realpath(workspace), "store"),
    "--run-id", "overlap-must-fail", "--config", config, "--json",
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /store and model-writable workspace must not overlap/);
  assert.deepEqual(await readdir(workspace), []);
});
