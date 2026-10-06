import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeMcpServers, parseWorkspaceMcpDocument, readWorkspaceMcpServers } from "../src/adapters/node/config/workspace-mcp.js";

const connection = (name: string) => ({ command: "npx", name, transport: "stdio" as const });

test("the editor's .vscode/mcp.json is read as stdio servers, and only as those", () => {
  const parsed = parseWorkspaceMcpDocument(JSON.stringify({
    servers: {
      "galaxy-orbit": { args: ["-y", "@galaxy-stack/orbit-mcp"], command: "npx", env: { ORBIT_TOKEN: "x" }, type: "stdio" },
      "remote-docs": { type: "http", url: "https://example.com/mcp" },
      "broken-entry": { args: ["-y"] },
    },
  }));
  assert.deepEqual(parsed.map(item => item.name), ["galaxy-orbit"], "stdio entries only: no command, no server");
  assert.deepEqual(parsed[0], { args: ["-y", "@galaxy-stack/orbit-mcp"], command: "npx", env: { ORBIT_TOKEN: "x" }, name: "galaxy-orbit", timeoutMs: 120000, transport: "stdio" });
  assert.deepEqual(parseWorkspaceMcpDocument("{ not json"), []);
  assert.deepEqual(parseWorkspaceMcpDocument(JSON.stringify({ servers: [] })), []);
});

test("precedence is agent config, then the workspace file, then the defaults", () => {
  const merged = mergeMcpServers({
    agentConfig: [connection("shared")],
    defaults: [connection("galaxy-orbit"), connection("shared")],
    workspace: [connection("shared"), connection("project-only")],
  });
  assert.deepEqual(merged.map(item => item.name), ["shared", "project-only", "galaxy-orbit"]);
});

test("a workspace without the editor file contributes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-mcp-"));
  try {
    assert.deepEqual(readWorkspaceMcpServers(root), []);
    await mkdir(join(root, ".vscode"), { recursive: true });
    await writeFile(join(root, ".vscode", "mcp.json"), JSON.stringify({ servers: { local: { command: "node", args: ["server.js"] } } }), "utf8");
    assert.deepEqual(readWorkspaceMcpServers(root).map(item => item.name), ["local"]);
    assert.deepEqual(mergeMcpServers({ agentConfig: [], defaults: [connection("galaxy-orbit")], workspace: readWorkspaceMcpServers(root) }).map(item => item.name), ["local", "galaxy-orbit"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
