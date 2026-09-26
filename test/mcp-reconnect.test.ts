import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpAgentClient } from "../src/adapters/node/mcp/mcp-client.js";
import { AgentToolExecutor } from "../src/agent/index.js";
import type { ToolExecutionContext } from "../src/index.js";

const fixture = fileURLToPath(new URL("./mcp-crash-fixture.mjs", import.meta.url));
const context = (): ToolExecutionContext => ({ deadline: Date.now() + 10000, mode: "auto", runId: "mcp-reconnect", taskId: "mcp-reconnect", workspaceRoot: "/tmp", signal: new AbortController().signal, idempotencyKey: "call", toolCallId: "call" });

async function setup(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), "galaxy-mcp-reconnect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "crash.json");
  await writeFile(state, "{}");
  const client = await McpAgentClient.connect({ name: "crash", transport: "stdio", command: process.execPath, args: [fixture], env: { MCP_CRASH_STATE: state } });
  t.after(() => client.close().catch(() => {}));
  return { client };
}

test("MCP read-only tool reconnects and retries after a transport crash", async t => {
  const { client } = await setup(t);
  const tools = await client.tools();
  const readEcho = tools.find(tool => tool.id.endsWith(".read_echo"));
  assert.ok(readEcho, "read_echo tool must be discovered");
  const executor = new AgentToolExecutor([readEcho], async () => true);
  const result = await executor.execute({ name: readEcho.definition.function.name, arguments: { crash: true, text: "hi" }, toolCallId: "read" }, context());
  assert.equal(result.ok, true, result.ok ? "" : result.summary);
  assert.match(result.content, /read_echo:ok/);
});

test("MCP mutating tool is not silently retried, but the connection recovers", async t => {
  const { client } = await setup(t);
  const tools = await client.tools();
  const writeThing = tools.find(tool => tool.id.endsWith(".write_thing"));
  assert.ok(writeThing, "write_thing tool must be discovered");
  const executor = new AgentToolExecutor([writeThing], async () => true);
  const failed = await executor.execute({ name: writeThing.definition.function.name, arguments: { crash: true }, toolCallId: "write" }, context());
  assert.equal(failed.ok, false, "a mutating call must not be transparently retried");
  const recovered = await executor.execute({ name: writeThing.definition.function.name, arguments: {}, toolCallId: "write-2" }, context());
  assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.summary);
  assert.match(recovered.content, /write_thing:ok/);
});
