import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpAgentClient } from "../src/adapters/node/mcp/mcp-client.js";
import { FileOAuthProvider } from "../src/adapters/node/mcp/oauth-provider.js";

const ACCESS_TOKEN = "galaxy-access-token";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => { const chunks: Buffer[] = []; req.on("data", c => chunks.push(c as Buffer)); req.on("end", () => resolve(Buffer.concat(chunks).toString())); });
}
function json(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}
async function closeServer(server: ReturnType<typeof createServer>): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

/** Local OAuth2 authorization server: discovery, dynamic registration, PKCE code + token exchange. */
async function startAuthServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const url = new URL(req.url ?? "/", base);
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: base, registration_endpoint: `${base}/register`,
        authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (req.method === "POST" && url.pathname === "/register") {
      const body = JSON.parse(await readBody(req)) as { redirect_uris: string[] };
      return json(res, 201, { client_id: "galaxy-test-client", client_id_issued_at: Math.floor(Date.now() / 1000), client_name: "Galaxy Code", redirect_uris: body.redirect_uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri")!;
      const state = url.searchParams.get("state") ?? "";
      res.writeHead(302, { location: `${redirect}?code=galaxy-test-code&state=${encodeURIComponent(state)}` });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("grant_type") !== "authorization_code" || !form.get("code_verifier")) return json(res, 400, { error: "invalid_grant" });
      return json(res, 200, { access_token: ACCESS_TOKEN, token_type: "Bearer", refresh_token: "galaxy-refresh-token", expires_in: 3600 });
    }
    res.writeHead(404).end();
  });
  await listen(server);
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => closeServer(server) };
}

/** Streamable-HTTP MCP endpoint that refuses requests without the OAuth bearer token. */
async function startGatedMcpServer(authBaseUrl: string): Promise<{ url: string; close: () => Promise<void>; unauthorizedRequests: () => number }> {
  let unauthorized = 0;
  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number }).port;
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      return json(res, 200, { resource: `${url.origin}/mcp`, authorization_servers: [authBaseUrl] });
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
      unauthorized++;
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"` });
      return res.end();
    }
    const body = JSON.parse(await readBody(req)) as { id?: number; method: string };
    if (body.id === undefined) { res.writeHead(202).end(); return; }
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "oauth-test", version: "1" } }
      : { tools: [{ name: "secure_echo", inputSchema: { type: "object", properties: {} } }] };
    if (!res.destroyed) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result })); }
  });
  await listen(server);
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, close: () => closeServer(server), unauthorizedRequests: () => unauthorized };
}

test("MCP OAuth: 401 discovery, browser login, token exchange, reconnect with bearer and persisted tokens", async t => {
  const auth = await startAuthServer();
  const gated = await startGatedMcpServer(auth.url);
  t.after(async () => { await auth.close(); await gated.close(); });

  const root = await mkdtemp(join(tmpdir(), "galaxy-mcp-oauth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  /** Replaces the OS browser step with a direct fetch against the local authorize endpoint. */
  class TestProvider extends FileOAuthProvider {
    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      const page = await fetch(authorizationUrl, { redirect: "manual" });
      assert.equal(page.status, 302);
      await fetch(page.headers.get("location")!, { redirect: "manual" });
    }
  }
  const provider = new TestProvider(gated.url, root);
  const client = await McpAgentClient.connect({ name: "auth", transport: "http", url: gated.url, auth: "oauth" }, undefined, { stateDir: root, oauthProviderFactory: () => provider });
  try {
    const tools = await client.tools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.id, "mcp.auth.secure_echo");
    assert.ok(gated.unauthorizedRequests() >= 1, "the server must have refused the unauthenticated attempt");
    // Tokens persist in the host state file with restrictive permissions.
    const tokenFile = JSON.parse(await readFile(join(root, "mcp-auth.json"), "utf8")) as { tokens: Record<string, { access_token: string }> };
    assert.equal(Object.values(tokenFile.tokens)[0]!.access_token, ACCESS_TOKEN);
  } finally { await client.close(); await provider.close(); }
});

test("FileOAuthProvider persists credentials with 0600 and forgets them on logout", async t => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-oauth-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = new FileOAuthProvider("https://fixture.test/mcp", root);
  await provider.saveTokens({ access_token: "a", token_type: "Bearer" });
  await provider.saveCodeVerifier("v");
  assert.equal((await stat(join(root, "mcp-auth.json"))).mode & 0o777, 0o600);
  assert.equal((await provider.tokens())?.access_token, "a");
  await FileOAuthProvider.clear(root, "https://fixture.test/mcp");
  assert.equal(await provider.tokens(), undefined);
  assert.equal(await provider.codeVerifier().then(() => true, () => false), false);
  await provider.close();
});
