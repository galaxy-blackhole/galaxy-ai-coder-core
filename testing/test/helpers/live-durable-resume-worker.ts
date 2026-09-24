import { FileRunStore } from "../../src/host/file-run-store.js";
import { loadLiveHealthScenario } from "../../src/io/load-live-health-scenario.js";
import { runLiveHealth } from "../../src/live/run-live-health.js";

const [stage, workspacePath, storePath] = process.argv.slice(2);
if (!(stage === "checkpoint" || stage === "resume") || !workspacePath || !storePath) {
  throw new Error("Usage: live-durable-resume-worker <checkpoint|resume> <workspace> <store>");
}

const runId = "live-durable-resume";
const scenario = await loadLiveHealthScenario("live/scenarios/01-write-and-validate.json");
const store = await FileRunStore.create(storePath);
const connection = Object.freeze({
  baseUrl: "https://ollama.example",
  configPath: "/not-used/manual.json",
  credentialSource: "none" as const,
  model: "kimi-k2.7-code:cloud",
});
const bodies: string[] = [];

function response(message: unknown): Response {
  return new Response(`${JSON.stringify(message)}\n`, {
    headers: { "content-type": "application/x-ndjson" },
    status: 200,
  });
}

function tool(name: string, argumentsValue: Readonly<Record<string, unknown>>, id: string): Response {
  return response({
    done: true,
    done_reason: "stop",
    message: {
      content: "",
      role: "assistant",
      thinking: "",
      tool_calls: [{ function: { arguments: argumentsValue, name }, id, type: "function" }],
    },
  });
}

const checkpointResponses = [
  tool("list_files", { depth: 2, path: "." }, "inspect"),
  tool("write_file", {
    content: "hello\n",
    path: "hello.txt",
    precondition: { kind: "must_not_exist" },
  }, "write"),
  tool("validate_project", { checks: ["test"], path: ".", timeoutMs: 30_000 }, "validate"),
  tool("git_operation", { action: "diff", paths: ["hello.txt"] }, "diff"),
  response({ done: true, done_reason: "stop", message: { content: "", role: "assistant", thinking: "", tool_calls: [] } }),
  response({ done: true, done_reason: "stop", message: { content: "", role: "assistant", thinking: "", tool_calls: [] } }),
];

const report = await runLiveHealth({
  connection,
  fetch: async (input, init) => {
    bodies.push(String(init?.body ?? ""));
    if (String(input).endsWith("/api/show")) {
      return Response.json({
        capabilities: ["completion", "tools", "thinking"],
        model_info: { "kimi.context_length": 262_144 },
      });
    }
    if (stage === "checkpoint") {
      return checkpointResponses.shift() ?? Response.json({ error: "unexpected request" }, { status: 500 });
    }
    return response({
      done: true,
      done_reason: "stop",
      message: {
        content: "Resumed from durable evidence; the file, validation, and final Git diff are verified.",
        role: "assistant",
        thinking: "",
        tool_calls: [],
      },
    });
  },
  ...(stage === "resume" ? { resume: true } : {}),
  runId,
  scenario,
  store,
  workspacePath,
});
const finalReport = await store.loadFinalReport(runId);
const chatBodies = bodies.slice(1).map((body) => JSON.parse(body) as { tools?: unknown[] });

process.stdout.write(JSON.stringify({
  changedPaths: report.changedPaths,
  checkpointReasons: report.checkpointReasons,
  errorCode: report.error?.code ?? null,
  finalReportStored: finalReport !== null,
  firstChatToolCount: chatBodies[0]?.tools?.length ?? null,
  modelRequests: report.modelDiagnostics.chatRequests,
  persistence: report.persistence,
  pid: process.pid,
  status: report.status,
  toolSequence: report.toolSequence,
}));
