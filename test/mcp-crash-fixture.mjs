import { readFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const statePath = process.env.MCP_CRASH_STATE;
const alreadyCrashed = () => { try { return JSON.parse(readFileSync(statePath, "utf8")).crashed === true; } catch { return false; } };
const markCrashed = () => { writeFileSync(statePath, JSON.stringify({ crashed: true })); };

const server = new Server({ name: "galaxy-mcp-crash-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "read_echo", description: "Read-only echo", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { text: { type: "string" }, crash: { type: "boolean" } } } },
  { name: "write_thing", description: "Mutating thing", inputSchema: { type: "object", properties: { crash: { type: "boolean" } } } },
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const args = request.params.arguments ?? {};
  if (args.crash === true && statePath && !alreadyCrashed()) {
    markCrashed();
    process.exit(1); // Crash the transport mid-call so the client must reconnect.
  }
  return { content: [{ type: "text", text: request.params.name + ":ok" }] };
});
await server.connect(new StdioServerTransport());
