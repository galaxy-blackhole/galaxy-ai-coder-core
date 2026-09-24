import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformation, OAuthClientInformationFull, OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/** File-backed OAuth session state for first-party MCP clients. */
interface OAuthStore {
  version: 1;
  clients: Record<string, OAuthClientInformationMixed>;
  tokens: Record<string, OAuthTokens>;
  verifiers: Record<string, string>;
  discovery: Record<string, OAuthDiscoveryState>;
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const EMPTY_STORE: Omit<OAuthStore, "version"> = { clients: {}, tokens: {}, verifiers: {}, discovery: {} };

function sanitizeKey(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96); }

async function readStore(path: string): Promise<OAuthStore> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as OAuthStore;
    if (parsed?.version !== 1) return { version: 1, ...EMPTY_STORE };
    return { version: 1, clients: parsed.clients ?? {}, tokens: parsed.tokens ?? {}, verifiers: parsed.verifiers ?? {}, discovery: parsed.discovery ?? {} };
  } catch { return { version: 1, ...EMPTY_STORE }; }
}

async function writeStore(path: string, store: OAuthStore): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const temp = join(tmpdir(), `galaxy-oauth-${randomUUID()}.json`);
  await writeFile(temp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => {});
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, { timeout: 5000 }, error => { if (error) process.stderr.write(`Galaxy MCP: mở URL này để đăng nhập:\n${url}\n`); });
}

function keyFor(serverUrl: string): string { return sanitizeKey(new URL(serverUrl).host); }

/**
 * OAuth client provider for remote MCP servers needing login: RFC 9728
 * discovery, dynamic client registration, PKCE authorization code and refresh
 * tokens. Credentials persist in one host-state JSON file with 0600
 * permissions, keyed by server host. The localhost callback server starts in
 * the constructor; every async provider method awaits that bind, and the SDK
 * only reads the synchronous redirect getters after such a call, so the
 * redirect URL is deterministic. Call close() to release the port.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private readonly path: string;
  private readonly key: string;
  private readonly pending: Deferred<string> = defer<string>();
  private listener: { server: ReturnType<typeof createServer>; url: URL } | undefined;
  private readonly ready: Promise<void>;
  constructor(serverUrl: string, stateDir?: string) {
    this.key = keyFor(serverUrl);
    const base = stateDir && isAbsolute(stateDir) ? stateDir : join(homedir(), ".galaxy", "agent");
    this.path = join(base, "mcp-auth.json");
    this.ready = new Promise<void>(resolve => {
      const server = createServer((request, response) => this.handleCallback(request, response));
      server.on("error", error => { this.pending.reject(new Error(`OAuth callback failed: ${error.message}`)); resolve(); });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") { this.pending.reject(new Error("OAuth callback port unavailable.")); resolve(); return; }
        this.listener = { server, url: new URL(`http://127.0.0.1:${address.port}/callback`) };
        resolve();
      });
    });
    this.ready.catch(() => {});
  }
  private handleCallback(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const finish = (status: number, body: string) => { response.writeHead(status, { "content-type": "text/plain" }); response.end(body); };
    const oauthError = url.searchParams.get("error");
    const oauthCode = url.searchParams.get("code");
    if (oauthError) { finish(400, `Authorization failed: ${oauthError}`); this.pending.reject(new Error(`OAuth: ${oauthError}`)); return; }
    if (!oauthCode) { finish(400, "Missing authorization code."); return; }
    finish(200, "Galaxy MCP authorization complete. You can close this tab.");
    this.pending.resolve(oauthCode);
  }
  /** Releases the localhost callback port once the session or login ends. */
  async close(): Promise<void> {
    await this.ready.catch(() => {});
    if (!this.listener) return;
    const { server } = this.listener; this.listener = undefined;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  get redirectUrl(): string { return this.listener?.url.toString() ?? ""; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Galaxy Code",
      client_uri: "https://github.com/galaxy-blackhole/galaxy-code",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      redirect_uris: [this.redirectUrl],
    };
  }
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> { await this.ready; return (await readStore(this.path)).clients[this.key]; }
  async saveClientInformation(clientInformation: OAuthClientInformationFull | OAuthClientInformation): Promise<void> {
    await this.ready; const store = await readStore(this.path); store.clients[this.key] = clientInformation; await writeStore(this.path, store);
  }
  async tokens(): Promise<OAuthTokens | undefined> { await this.ready; return (await readStore(this.path)).tokens[this.key]; }
  async saveTokens(tokens: OAuthTokens): Promise<void> { await this.ready; const store = await readStore(this.path); store.tokens[this.key] = tokens; await writeStore(this.path, store); }
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.ready;
    process.stderr.write(`Galaxy MCP: đang chờ đăng nhập trình duyệt cho ${authorizationUrl.host}…\n`);
    openBrowser(authorizationUrl.toString());
  }
  async saveCodeVerifier(codeVerifier: string): Promise<void> { await this.ready; const store = await readStore(this.path); store.verifiers[this.key] = codeVerifier; await writeStore(this.path, store); }
  async codeVerifier(): Promise<string> {
    await this.ready;
    const verifier = (await readStore(this.path)).verifiers[this.key];
    if (!verifier) throw new Error("OAuth code verifier missing; restart the login flow.");
    return verifier;
  }
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> { await this.ready; const store = await readStore(this.path); store.discovery[this.key] = state; await writeStore(this.path, store); }
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> { await this.ready; return (await readStore(this.path)).discovery[this.key]; }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    await this.ready;
    if (scope === "all") { await unlink(this.path).catch(() => {}); return; }
    const store = await readStore(this.path);
    if (scope === "client") delete store.clients[this.key];
    if (scope === "tokens") delete store.tokens[this.key];
    if (scope === "verifier") delete store.verifiers[this.key];
    if (scope === "discovery") delete store.discovery[this.key];
    await writeStore(this.path, store);
  }
  /** Authorization code captured by the localhost callback; rejects after auth errors. */
  waitForAuthorizationCode(): Promise<string> { return this.ready.then(() => this.pending.promise); }
  static tokenFile(stateDir?: string): string { return join(stateDir && isAbsolute(stateDir) ? stateDir : join(homedir(), ".galaxy", "agent"), "mcp-auth.json"); }
  static async clear(stateDir: string | undefined, serverUrl: string): Promise<void> {
    const path = join(stateDir && isAbsolute(stateDir) ? stateDir : join(homedir(), ".galaxy", "agent"), "mcp-auth.json");
    const key = keyFor(serverUrl);
    const store = await readStore(path);
    delete store.tokens[key]; delete store.clients[key]; delete store.verifiers[key]; delete store.discovery[key];
    await writeStore(path, store);
  }
}
