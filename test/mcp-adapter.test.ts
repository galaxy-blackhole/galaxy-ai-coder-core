import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { McpAgentClient } from "../src/adapters/node/mcp/mcp-client.js";
import { AgentToolExecutor } from "../src/agent/index.js";
import type { ToolExecutionContext } from "../src/index.js";
const context = (): ToolExecutionContext => ({ deadline: Date.now() + 5000, mode: "auto", runId: "mcp-test", taskId: "mcp-test", workspaceRoot: "/tmp", signal: new AbortController().signal, idempotencyKey: "call", toolCallId: "call" });
test("MCP stdio negotiates protocol, validates full schemas, enforces permissions and exposes resources/prompts", async () => {
  const client = await McpAgentClient.connect({ name: "local", transport: "stdio", command: process.execPath, args: [fileURLToPath(new URL("./mcp-fixture.mjs", import.meta.url))] });
  try {
    const tools = await client.tools(); assert.equal(tools.length, 1); assert.equal(tools[0]?.risk, "external");
    const call = { name: tools[0]!.definition.function.name, arguments: { text: "Xin chào" }, toolCallId: "echo" };
    const executor = new AgentToolExecutor(tools, async () => true);
    const success = await executor.execute(call, context()); assert.equal(success.ok, true); assert.match(success.content, /Xin chào/); assert.equal(success.effects, undefined);
    assert.equal((await executor.execute({ ...call, arguments: { text: [] } }, context())).ok, false);
    assert.equal((await new AgentToolExecutor(tools, async () => false).execute(call, context())).ok, false);
    assert.equal((await client.listResources()).resources.length, 1);
    assert.match(JSON.stringify(await client.readResource("test://note")), /Resource data/);
    assert.equal((await client.listPrompts()).prompts.length, 1);
    assert.match(JSON.stringify(await client.getPrompt("review", {})), /Review current/);
  } finally { await client.close(); }
});
test("MCP Streamable HTTP negotiates and calls tools, propagates abort and deadlines", async () => {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string };
    if (body.id === undefined) { res.writeHead(202).end(); return; }
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "http-test", version: "1" } }
      : body.method === "tools/list" ? { tools: [{ name: "wait", inputSchema: { type: "object", properties: {} } }] }
      : { content: [{ type: "text", text: "ok" }] };
    if (body.method === "tools/call") await new Promise(resolve => setTimeout(resolve, 100));
    if (!res.destroyed) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  const client = await McpAgentClient.connect({ name: "http", transport: "http", url: `http://127.0.0.1:${address.port}/mcp` });
  try {
    const tools = await client.tools(); const executor = new AgentToolExecutor(tools, async () => true);
    const call = { name: tools[0]!.definition.function.name, arguments: {}, toolCallId: "http" };
    assert.equal((await executor.execute(call, context())).ok, true);
    const abort = new AbortController(); const pending = executor.execute(call, { ...context(), signal: abort.signal });
    setTimeout(() => abort.abort(), 10); assert.equal((await pending).ok, false);
    assert.equal((await executor.execute(call, { ...context(), deadline: Date.now() - 1 })).ok, false);
  } finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
