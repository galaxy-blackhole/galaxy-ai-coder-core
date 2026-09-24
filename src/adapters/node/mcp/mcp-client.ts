import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { createHash } from "node:crypto";
import type { AgentTool } from "../../../agent/index.js";
import { FileOAuthProvider } from "./oauth-provider.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

export type McpConnectOptions = {
  stateDir?: string;
  /** Hosts may inject their own credential storage (VS Code SecretStorage, Tauri keychain). */
  oauthProviderFactory?: (serverUrl: string) => OAuthClientProvider;
};

export type McpConnection = { name: string; timeoutMs?: number } & (
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { transport: "http"; url: string; headers?: Record<string, string>; auth?: "oauth" }
);
/** Server annotations are display hints, never authorization or verified runtime effects. */
export class McpAgentClient {
  private constructor(private readonly client: Client, readonly name: string, private readonly timeout: number) {}
  static async connect(config: McpConnection, signal?: AbortSignal, options?: McpConnectOptions): Promise<McpAgentClient> {
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(config.name)) throw new Error("Invalid MCP server name.");
    const timeout = Math.max(100, Math.min(120000, config.timeoutMs ?? 30000));
    let provider: OAuthClientProvider | undefined;
    if (config.transport === "http") {
      const url = new URL(config.url);
      if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("MCP requires an HTTP(S) URL without embedded credentials.");
      if (config.auth === "oauth") provider = options?.oauthProviderFactory?.(config.url) ?? new FileOAuthProvider(config.url, options?.stateDir);
    }
    const initial = await this.open(config, timeout, signal, provider);
    if (initial) return initial;
    if (config.transport !== "http" || !provider) throw new Error(`MCP server ${config.name} requires authentication. Configure "auth": "oauth" and run blackhole mcp login.`);
    return this.login(config, timeout, signal, provider);
  }
  private static async open(config: McpConnection, timeout: number, signal: AbortSignal | undefined, provider?: OAuthClientProvider): Promise<McpAgentClient | undefined> {
    const client = new Client({ name: "galaxy-agent", version: "0.1.0" });
    const transport = config.transport === "stdio"
      ? new StdioClientTransport({ command: config.command, args: config.args ?? [], ...(config.env ? { env: config.env } : {}), ...(config.cwd ? { cwd: config.cwd } : {}), stderr: "pipe" })
      : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers ?? {} }, ...(provider ? { authProvider: provider } : {}) });
    try {
      // SDK transport optional sessionId typing predates exactOptionalPropertyTypes.
      if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
      await client.connect(transport as unknown as Transport, { timeout, ...(signal ? { signal } : {}) });
      // Drain stderr to prevent a verbose local server blocking on a full pipe.
      if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
      return new McpAgentClient(client, config.name, timeout);
    } catch (error) {
      await transport.close().catch(() => {});
      if (provider && error instanceof UnauthorizedError) return undefined;
      throw error;
    }
  }
  /** OAuth authorization-code completion: browser login, token exchange, reconnect. */
  private static async login(config: Extract<McpConnection, { transport: "http" }>, timeout: number, signal: AbortSignal | undefined, provider: OAuthClientProvider & { waitForAuthorizationCode?: () => Promise<string> }): Promise<McpAgentClient> {
    if (signal?.aborted) throw new Error("OAuth login canceled.");
    if (!provider.waitForAuthorizationCode) throw new Error("OAuth provider does not support interactive login.");
    const code = await Promise.race([provider.waitForAuthorizationCode(), this.abortPromise(signal)]);
    const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
    const result = await auth(provider, { serverUrl: config.url, authorizationCode: code });
    if (result !== "AUTHORIZED") throw new Error("OAuth login did not complete.");
    const client = await this.open(config, timeout, signal, provider);
    if (!client) throw new Error("OAuth login succeeded but the MCP server still refuses the connection.");
    return client;
  }
  private static abortPromise(signal?: AbortSignal): Promise<never> {
    return new Promise((_, reject) => { if (signal?.aborted) reject(new Error("OAuth login canceled.")); else signal?.addEventListener("abort", () => reject(new Error("OAuth login canceled.")), { once: true }); });
  }
  async tools(signal?: AbortSignal): Promise<AgentTool[]> {
    const tools: AgentTool[] = [];
    const validator = new AjvJsonSchemaValidator();
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 32; page++) {
      const result = await this.client.listTools(cursor ? { cursor } : {}, { timeout: this.timeout, ...(signal ? { signal } : {}) });
      for (const tool of result.tools) {
        if (tools.length >= 1000 || seen.has(tool.name)) throw new Error("MCP tool catalog is oversized or contains duplicate names.");
        seen.add(tool.name);
        if (JSON.stringify(tool.inputSchema).length > 65536) throw new Error("MCP tool schema exceeds 64 KiB.");
        const hash = createHash("sha256").update(`${this.name}\0${tool.name}`).digest("hex").slice(0, 12);
        const name = `mcp_${this.name.slice(0, 16)}_${tool.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 24)}_${hash}`;
        const validate = validator.getValidator(tool.inputSchema as Parameters<typeof validator.getValidator>[0]);
        tools.push({
          validateArguments: args => { const result = validate(args); return { valid: result.valid, errors: result.valid ? [] : [result.errorMessage] }; },
          id: `mcp.${this.name}.${tool.name}`, risk: "external", trust: "external",
          definition: { type: "function", function: { name, description: (tool.description ?? tool.name).slice(0, 4096), parameters: tool.inputSchema } },
          execute: async (args, context) => {
            const result = await this.client.callTool({ name: tool.name, arguments: { ...args } }, undefined, { signal: context.signal, timeout: Math.max(1, Math.min(this.timeout, context.deadline - Date.now())) });
            if (result.isError) throw new Error(`MCP ${this.name}/${tool.name}: ${JSON.stringify(result.content).slice(0, 2048)}`);
            return { server: this.name, tool: tool.name, trust: "external", result };
          },
        });
      }
      if (!result.nextCursor) return tools;
      if (result.nextCursor === cursor) throw new Error("MCP pagination cursor did not advance.");
      cursor = result.nextCursor;
    }
    throw new Error("MCP pagination limit reached.");
  }
  listResources(cursor?: string) { return this.client.listResources(cursor ? { cursor } : {}, { timeout: this.timeout }); }
  readResource(uri: string, signal?: AbortSignal) { return this.client.readResource({ uri }, { timeout: this.timeout, ...(signal ? { signal } : {}) }); }
  listPrompts(cursor?: string) { return this.client.listPrompts(cursor ? { cursor } : {}, { timeout: this.timeout }); }
  getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal) { return this.client.getPrompt({ name, arguments: args }, { timeout: this.timeout, ...(signal ? { signal } : {}) }); }
  async close(): Promise<void> { await this.client.close(); }
}
