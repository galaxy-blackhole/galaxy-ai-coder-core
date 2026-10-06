/**
 * Workspace MCP servers, read from the editor's own file.
 *
 * VS Code keeps them in `.vscode/mcp.json` under a `servers` map, and that is where a team tends to put
 * the servers a project needs — so both the CLI and the extension honour it instead of inventing a
 * Galaxy-only location. Only stdio servers are read: there is no browser transport to host here.
 *
 * Precedence, most specific first: an explicit agent config (--agent-config or ~/.galaxy/agent.json),
 * then the workspace file, then the Galaxy defaults. A name is taken once, by the first layer that
 * names it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpConnection } from "../mcp/mcp-client.js";

/** Where the editor keeps a workspace's servers, relative to the workspace root. */
export const WORKSPACE_MCP_PATH = join(".vscode", "mcp.json");

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** Parse the editor's document; anything unreadable or malformed simply contributes nothing. */
export function parseWorkspaceMcpDocument(text: string): readonly McpConnection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Object.freeze([]);
  }
  const servers = (parsed as { servers?: unknown } | null)?.servers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return Object.freeze([]);
  const connections: McpConnection[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as { args?: unknown; command?: unknown; env?: unknown };
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    /* Only stdio servers can run here: a URL transport is the editor's business, not the agent's. */
    if (command.length === 0) continue;
    const args = Array.isArray(entry.args) ? entry.args.filter((value): value is string => typeof value === "string") : [];
    const env = stringRecord(entry.env);
    connections.push(Object.freeze({
      ...(env === undefined ? {} : { env }),
      args,
      command,
      name,
      timeoutMs: 120_000,
      transport: "stdio" as const,
    }));
  }
  return Object.freeze(connections);
}

export function readWorkspaceMcpServers(workspace: string): readonly McpConnection[] {
  try {
    return parseWorkspaceMcpDocument(readFileSync(join(workspace, WORKSPACE_MCP_PATH), "utf8"));
  } catch {
    return Object.freeze([]);
  }
}

/** Merge the three layers by name, keeping the most specific entry for each name. */
export function mergeMcpServers(input: Readonly<{ agentConfig: readonly McpConnection[]; defaults: readonly McpConnection[]; workspace: readonly McpConnection[] }>): readonly McpConnection[] {
  const merged = new Map<string, McpConnection>();
  for (const layer of [input.agentConfig, input.workspace, input.defaults]) {
    for (const connection of layer) if (!merged.has(connection.name)) merged.set(connection.name, connection);
  }
  return Object.freeze([...merged.values()]);
}