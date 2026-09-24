import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AiCoderTokenEstimator,
  boundAiCoderToolOutput,
  type AiCoderRuntimeToolResult,
  type ToolExecutionContext,
} from "@galaxy-stack/ai-coder-core";

import { parseLiveHealthScenario } from "../../src/domain/live-health-scenario.js";
import { sha256Text } from "../../src/host/content-hash.js";
import { NodeCommandPort } from "../../src/host/node-command-port.js";
import { NodeWorkspacePort } from "../../src/host/node-workspace-port.js";
import { createFixtureApprovalPort } from "../../src/lab/fixture-approval.js";
import { SCRIPTED_MODEL_CAPABILITIES } from "../../src/lab/scripted-model.js";
import { LabToolExecutor } from "../../src/lab/tool-executor.js";
import { runLiveHealth } from "../../src/live/run-live-health.js";
import { OllamaResearchPort } from "../../src/provider/ollama-research-port.js";

type TestContext = { after: (callback: () => Promise<void>) => unknown };
const source = "https://nodejs.org/api/globals.html";

async function createWorkspace(testContext: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "galaxy-research-output-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

async function executor(testContext: TestContext, payload: unknown) {
  const workspaceRoot = await createWorkspace(testContext);
  const context: ToolExecutionContext = {
    deadline: Date.now() + 30_000,
    idempotencyKey: "research-output",
    mode: "review_only",
    runId: "research-output",
    signal: new AbortController().signal,
    taskId: "research-output",
    toolCallId: "research-output",
    workspaceRoot,
  };
  const tools = new LabToolExecutor({
    approval: createFixtureApprovalPort({ "research.search": "allow", "research.fetch": "allow" }),
    capabilities: SCRIPTED_MODEL_CAPABILITIES,
    command: await NodeCommandPort.create(workspaceRoot),
    enableGit: false,
    research: new OllamaResearchPort({ apiKey: "unit-secret", fetch: async () => Response.json(payload) }),
    workspace: await NodeWorkspacePort.create(workspaceRoot),
  });
  const discovery = await tools.execute({ name: "search_tools", arguments: { category: "research" }, toolCallId: "discover" }, context);
  assert.equal(discovery.ok, true);
  return { context, tools };
}

function worstCaseEstimator(): AiCoderTokenEstimator {
  const estimator = new AiCoderTokenEstimator();
  estimator.calibrate("json", 1, 100);
  return estimator;
}

async function assertCorePreservesJson(result: AiCoderRuntimeToolResult): Promise<Record<string, any>> {
  assert.equal(result.ok, true, result.summary);
  assert.ok(result.outputLimits);
  const estimator = worstCaseEstimator();
  const bounded = await boundAiCoderToolOutput({
    content: result.content,
    estimator,
    limits: result.outputLimits,
    runId: "research-output",
    toolCallId: "bounded-output",
    toolName: result.canonicalToolId,
  });
  assert.equal(bounded.truncated, false, "The core limiter must not insert head/tail markers into research JSON.");
  assert.equal(bounded.content, result.content);
  assert.equal(bounded.originalTokens <= result.outputLimits.maxTokens, true);
  assert.equal(Buffer.byteLength(bounded.content) <= result.outputLimits.maxBytes, true);
  assert.equal(result.trust, "external");
  const output = JSON.parse(bounded.content) as Record<string, any>;
  assert.equal(output.provenance.trust, "untrusted_external");
  return output;
}

test("research bounds shorten long search snippets before dropping URLs at maximum token calibration", async (testContext) => {
  const urls = Array.from({ length: 10 }, (_, index) => `${source}?document=${index}`);
  const { context, tools } = await executor(testContext, {
    results: urls.map((url) => ({ title: "Official source", url, content: "ASCII research excerpt ".repeat(300) })),
  });
  const result = await tools.execute({ name: "search_web", arguments: { query: "official docs", maxResults: 10 }, toolCallId: "search" }, context);
  const output = await assertCorePreservesJson(result);
  assert.equal(result.effectsAuthority, "host");
  assert.equal(result.effects?.researchSources?.length, output.results.length);
  assert.equal(result.effects?.researchSources?.[0]?.kind, "search");
  assert.equal(output.truncated, true);
  assert.deepEqual(output.results.map((hit: { url: string }) => hit.url), urls);
  assert.ok(output.results.every((hit: { snippet: string }) => hit.snippet.length > 0 && hit.snippet.length < 4_096));
});

test("research bounds preserve UTF-8 content, source and matching hashes through the actual core limiter", async (testContext) => {
  for (const content of ["ASCII facts about cancellation. ".repeat(2_000), "Tiếng Việt 😀 漢字 \"quoted\"\tline\n".repeat(2_000)]) {
    const { context, tools } = await executor(testContext, { title: "Source", links: [], content });
    const result = await tools.execute({ name: "fetch_url", arguments: { url: source, maxBytes: 200_000 }, toolCallId: "fetch" }, context);
    const output = await assertCorePreservesJson(result);
    assert.equal(result.effectsAuthority, "host");
    assert.equal(result.effects?.researchSources?.[0]?.kind, "fetch");
    assert.equal(result.effects?.researchSources?.[0]?.contentHash, output.contentHash);
    assert.ok(Array.from(result.effects?.researchSources?.[0]?.summary ?? "").length <= 1_000);
    assert.equal(output.url, source);
    assert.equal(output.truncated, true);
    assert.ok(output.content.length > 0);
    assert.ok(content.startsWith(output.content));
    assert.equal(output.content.includes("�"), false);
    assert.equal(output.contentHash, sha256Text(output.content));
    assert.equal(output.provenance.contentHash, output.contentHash);
  }
});

test("research executor reuses successful identical search and fetch calls without another network request", async (testContext) => {
  const workspaceRoot = await createWorkspace(testContext);
  let requests = 0;
  const context: ToolExecutionContext = {
    deadline: Date.now() + 30_000,
    idempotencyKey: "research-cache",
    mode: "review_only",
    runId: "research-cache",
    signal: new AbortController().signal,
    taskId: "research-cache",
    toolCallId: "research-cache",
    workspaceRoot,
  };
  const tools = new LabToolExecutor({
    approval: createFixtureApprovalPort({ "research.search": "allow", "research.fetch": "allow" }),
    capabilities: SCRIPTED_MODEL_CAPABILITIES,
    command: await NodeCommandPort.create(workspaceRoot),
    enableGit: false,
    research: new OllamaResearchPort({ apiKey: "unit-secret", fetch: async (url) => {
      requests += 1;
      return String(url).endsWith("web_search")
        ? Response.json({ results: [{ title: "Node", url: source, content: "Fetch facts" }] })
        : Response.json({ title: "Node", links: [], content: "Fetch resolves HTTP responses." });
    } }),
    workspace: await NodeWorkspacePort.create(workspaceRoot),
  });
  await tools.execute({ name: "search_tools", arguments: { category: "research" }, toolCallId: "discover" }, context);
  const search1 = await tools.execute({ name: "search_web", arguments: { query: "Node fetch", maxResults: 3 }, toolCallId: "search-1" }, context);
  const search2 = await tools.execute({ name: "search_web", arguments: { query: "Node fetch", maxResults: 3 }, toolCallId: "search-2" }, context);
  const fetch1 = await tools.execute({ name: "fetch_url", arguments: { url: source }, toolCallId: "fetch-1" }, context);
  const fetch2 = await tools.execute({ name: "fetch_url", arguments: { url: `${source}#fetch` }, toolCallId: "fetch-2" }, context);

  assert.equal(requests, 2);
  assert.equal(search2.content, search1.content);
  assert.equal(fetch2.content, fetch1.content);
  assert.equal(fetch2.effects?.researchSources?.[0]?.url, source);
});

test("research bounds drop sources only when their metadata cannot fit even after snippet removal", async (testContext) => {
  const urls = Array.from({ length: 10 }, (_, index) => `${source}?document=${index}&detail=${"a".repeat(1_000)}`);
  const { context, tools } = await executor(testContext, {
    results: urls.map((url) => ({ title: "Source title ".repeat(40), url, content: "A long excerpt ".repeat(400) })),
  });
  const result = await tools.execute({ name: "search_web", arguments: { query: "official docs", maxResults: 10 }, toolCallId: "search" }, context);
  const output = await assertCorePreservesJson(result);
  assert.equal(output.truncated, true);
  assert.ok(output.results.length > 0 && output.results.length < 10);
  assert.deepEqual(output.results.map((hit: { url: string }) => hit.url), urls.slice(0, output.results.length));
  assert.ok(output.results.every((hit: { snippet: string }) => hit.snippet.length === 0));
});

test("mock live research keeps long search and multilingual fetched evidence readable after controller normalization", async (testContext) => {
  const workspacePath = await createWorkspace(testContext);
  const secondSource = "https://nodejs.org/api/errors.html";
  const contentBySource: Record<string, string> = {
    [source]: "Official ASCII documentation about bounded deadlines. ".repeat(1_000),
    [secondSource]: "Tiếng Việt 😀 漢字: lỗi mạng và giới hạn thời gian.\n".repeat(1_000),
  };
  const rounds: Array<{ content: string; name?: string; args?: unknown }> = [
    { content: "", name: "read_file", args: { path: "README.md" } },
    { content: "", name: "search_tools", args: { category: "research" } },
    { content: "", name: "search_web", args: { query: "site:nodejs.org timeout errors", maxResults: 10 } },
    { content: "", name: "fetch_url", args: { url: source, maxBytes: 200_000 } },
    { content: "", name: "fetch_url", args: { url: secondSource, maxBytes: 200_000 } },
    { content: `Use explicit deadlines. [Globals](${source}) and [Errors](${secondSource}).` },
  ];
  const delivered = new Map<string, Record<string, any>>();
  let roundIndex = 0;
  let webRequests = 0;
  const report = await runLiveHealth({
    connection: {
      apiKey: "integration-secret",
      baseUrl: "https://ollama.example",
      configPath: "/private/mock-config.json",
      credentialSource: "manual-config",
      model: "kimi-k2.7-code:cloud",
    },
    scenario: parseLiveHealthScenario({
      schemaVersion: 1,
      name: "bounded research envelope",
      mode: "review_only",
      task: "Inspect the project, search and fetch official docs, then propose with citations.",
      initialFiles: [{ path: "README.md", content: "A Node client needs a network timeout recommendation.\n" }],
      runtime: { research: { provider: "ollama" } },
      approvalDecisions: { "research.search": "allow", "research.fetch": "allow" },
      expected: { allowedChanges: [], files: [], research: { minSearchCalls: 1, minFetchCalls: 2, requireCitations: true, requiredDomains: ["nodejs.org"] } },
    }),
    workspacePath,
    fetch: async (url, init) => {
      if (String(url).endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"], model_info: { "kimi.context_length": 262_144 } });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; tool_name?: string; content: string }> };
      for (const message of body.messages) {
        const liveToolResult = message.role === "tool" && ["search_web", "fetch_url"].includes(message.tool_name ?? "");
        const retainedResearch = message.role === "user" && message.content.includes("GALAXY RETAINED RESEARCH EVIDENCE");
        if (!liveToolResult && !retainedResearch) continue;
        const jsonBoundary = message.content.lastIndexOf("\n{");
        assert.notEqual(jsonBoundary, -1);
        const raw = message.content.slice(jsonBoundary + 1);
        const output = JSON.parse(raw) as Record<string, any>;
        assert.equal(raw.includes("GALAXY OUTPUT TRUNCATED"), false);
        assert.equal(output.provenance.trust, "untrusted_external");
        delivered.set(output.url ?? "search", output);
      }
      const round = rounds[roundIndex++];
      assert.ok(round, "Core exceeded the scripted model flow.");
      return new Response(`${JSON.stringify({
        done: true, done_reason: "stop", prompt_eval_count: 50_000, eval_count: 10,
        message: { role: "assistant", content: round.content, thinking: "", tool_calls: round.name === undefined ? [] : [{
          id: `round-${roundIndex}`, type: "function", function: { name: round.name, arguments: round.args },
        }] },
      })}\n`);
    },
    researchFetch: async (url, init) => {
      webRequests += 1;
      if (String(url).endsWith("web_search")) return Response.json({ results: Array.from({ length: 10 }, (_, index) => ({
        title: "Node documentation", url: index === 0 ? source : `${source}?document=${index}`, content: "A search excerpt with many ASCII facts. ".repeat(200),
      })) });
      const body = JSON.parse(String(init?.body)) as { url: string };
      return Response.json({ title: "Node documentation", links: [], content: contentBySource[body.url] });
    },
  });
  assert.equal(report.passed, true, JSON.stringify(report.failures));
  assert.equal(report.error, null);
  assert.equal(report.research?.searchCalls, 1);
  assert.equal(report.research?.fetchCalls, 2);
  assert.deepEqual(report.research?.failedCalls, []);
  assert.deepEqual(report.research?.unsupportedCitations, []);
  assert.deepEqual(report.changedPaths, []);
  assert.equal(webRequests, 3);
  assert.equal(roundIndex, rounds.length);
  assert.equal(delivered.size, 3);
  assert.equal(delivered.get("search")?.results.length, 10);
  for (const url of [source, secondSource]) {
    const output = delivered.get(url);
    assert.ok(output);
    assert.equal(output.truncated, true);
    assert.equal(output.contentHash, sha256Text(output.content));
    assert.equal(output.provenance.contentHash, output.contentHash);
    assert.ok(contentBySource[url]?.startsWith(output.content));
  }
});
