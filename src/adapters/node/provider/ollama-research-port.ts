import { createHash } from "node:crypto";
import { isIP } from "node:net";

import {
  portFailure,
  portSuccess,
  type PortErrorCode,
  type ResearchPort,
  type ResearchSearchHit,
  type ToolExecutionContext,
} from "../../../ports/index.js";

export type OllamaResearchFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OllamaResearchPortOptions {
  readonly apiKey?: string;
  readonly fetch?: OllamaResearchFetch;
  readonly timeoutMs?: number;
}

export const OLLAMA_RESEARCH_LIMITS = Object.freeze({
  defaultFetchBytes: 12_000,
  defaultSearchResults: 3,
  maxFetchBytes: 65_536,
  maxQueryBytes: 2_048,
  maxResponseBytes: 1_048_576,
  maxSearchResults: 10,
  maxSnippetBytes: 2_048,
  maxTitleBytes: 512,
  maxUrlBytes: 4_096,
  timeoutMs: 30_000,
});

type JsonObject = Readonly<Record<string, unknown>>;

class ResearchFailure extends Error {
  constructor(
    readonly code: PortErrorCode,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function schemaDiagnostic(payload: unknown, fields: readonly string[]): string {
  let serialized: string;
  try { serialized = JSON.stringify(payload) ?? String(payload); } catch { serialized = "<unserializable>"; }
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
  const fieldTypes = fields.map((field) => (
    `${field}=${isObject(payload) && field in payload ? valueType(payload[field]) : "missing"}`
  ));
  return `payloadSha256=${digest}; root=${valueType(payload)}; ${fieldTypes.join("; ")}`;
}

function failure(error: unknown) {
  const known = error instanceof ResearchFailure ? error : null;
  return portFailure({
    code: known?.code ?? "PROVIDER_ERROR",
    message: known?.message ?? "Ollama research transport failed. Provider error details are withheld to protect credentials.",
    retryable: known?.retryable ?? true,
    ...(known?.status === undefined ? {} : { details: { status: known.status } }),
  });
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedText(value: string, maxBytes: number): Readonly<{ text: string; truncated: boolean }> {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  // A UTF-8 cut may land in a continuation byte. Exclude the whole final code point.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function isPublicIpv4(address: string): boolean {
  const [first = 0, second = 0, third = 0] = address.split(".").map(Number);
  return !(
    first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0 && (third === 0 || third === 2))
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
  );
}

function isPublicIpv6(address: string): boolean {
  // WHATWG URL canonicalizes embedded IPv4 to hexadecimal groups before this call.
  const sections = address.split("::");
  const head = (sections[0] ?? "").split(":").filter(Boolean).map((part) => Number.parseInt(part, 16));
  const tail = (sections[1] ?? "").split(":").filter(Boolean).map((part) => Number.parseInt(part, 16));
  const groups = sections.length === 1 ? head : [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  const bytes = groups.flatMap((group) => [group >> 8, group & 0xff]);
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIpv4(bytes.slice(12).join("."));
  }
  // Accept ordinary global unicast; exclude local, multicast, translation/tunnel,
  // unspecified and documentation/special-use ranges conservatively.
  if ((bytes[0]! & 0xe0) !== 0x20) return false;
  if (groups[0] === 0x2002) return false; // 6to4 can encode non-public IPv4.
  if (groups[0] === 0x2001 && (groups[1]! < 0x0200 || groups[1] === 0x0db8)) return false;
  if (groups[0] === 0x3fff && groups[1]! < 0x1000) return false;
  return true;
}

function publicUrl(value: string): URL | null {
  if (byteLength(value) > OLLAMA_RESEARCH_LIMITS.maxUrlBytes || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const version = isIP(hostname);
  if (version === 4) return isPublicIpv4(hostname) ? parsed : null;
  if (version === 6) return isPublicIpv6(hostname) ? parsed : null;
  if (!hostname.includes(".") || !hostname.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part))) return null;
  if (["localhost", "local", "internal", "home", "lan", "test", "invalid", "example", "arpa"]
    .some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) return null;
  return parsed;
}

function assertActive(context: ToolExecutionContext): void {
  if (context.signal.aborted) throw new ResearchFailure("CANCELED", "Ollama research request was canceled.");
  if (!Number.isFinite(context.deadline) || Date.now() >= context.deadline) {
    throw new ResearchFailure("DEADLINE_EXCEEDED", "Ollama research deadline elapsed.", true);
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      // The supplied promise may already be in flight; retain its rejection handler.
      void promise.catch(() => {});
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Cloud research only: no local URL is fetched, and external content never becomes trusted instructions. */
export class OllamaResearchPort implements ResearchPort {
  private readonly apiKey: string;
  private readonly fetchImpl: OllamaResearchFetch;
  private readonly timeoutMs: number;

  constructor(options: OllamaResearchPortOptions = {}) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? OLLAMA_RESEARCH_LIMITS.timeoutMs;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647) {
      throw new Error("Ollama research timeoutMs must be a positive 32-bit integer.");
    }
  }

  private hasCredential(value: string): boolean {
    return this.apiKey.length > 0 && (
      value.includes(this.apiKey)
      || value.toLowerCase().includes(encodeURIComponent(this.apiKey).toLowerCase())
      || (() => { try { return decodeURIComponent(value).includes(this.apiKey); } catch { return false; } })()
    );
  }

  private redact(value: string): string {
    let sanitized = value;
    if (this.apiKey) {
      sanitized = sanitized.replaceAll(this.apiKey, "[REDACTED]");
      const encodedKey = encodeURIComponent(this.apiKey).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      sanitized = sanitized.replace(new RegExp(encodedKey, "gi"), "[REDACTED]");
    }
    return sanitized.replace(/Bearer\s+[^\s"'<>]+/giu, "Bearer [REDACTED]");
  }

  private async request(route: "web_search" | "web_fetch", body: JsonObject, context: ToolExecutionContext): Promise<unknown> {
    assertActive(context);
    if (!this.apiKey) throw new ResearchFailure("PRECONDITION_FAILED", "Ollama web research requires an Ollama API key.");
    if (/[\u0000-\u0020\u007f]/u.test(this.apiKey)) throw new ResearchFailure("INVALID_INPUT", "Ollama research API key contains invalid characters.");
    const controller = new AbortController();
    const cancel = () => controller.abort(new ResearchFailure("CANCELED", "Ollama research request was canceled."));
    context.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new ResearchFailure("DEADLINE_EXCEEDED", "Ollama research request timed out.", true));
    }, Math.min(this.timeoutMs, context.deadline - Date.now()));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    try {
      const responsePromise = this.fetchImpl(`https://ollama.com/api/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: controller.signal,
      });
      // Also closes a late response from an injected transport that ignores abort.
      void responsePromise.then((late) => {
        if (controller.signal.aborted) void late.body?.cancel().catch(() => {});
      }, () => {});
      response = await abortable(responsePromise, controller.signal);
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new ResearchFailure("PERMISSION_DENIED", "Ollama research redirects are disabled to protect the API key.");
      }
      if (!response.ok) {
        const status = response.status;
        if (status === 401 || status === 403) throw new ResearchFailure("PERMISSION_DENIED", "Ollama web research authentication or account permission was rejected.", false, status);
        if (status === 408 || status === 504) throw new ResearchFailure("DEADLINE_EXCEEDED", "Ollama web research provider timed out.", true, status);
        if (status === 429) throw new ResearchFailure("UNAVAILABLE", "Ollama web research rate limit reached; retry later.", true, status);
        if (status >= 500) throw new ResearchFailure("UNAVAILABLE", "Ollama web research service is temporarily unavailable.", true, status);
        throw new ResearchFailure("PROVIDER_ERROR", "Ollama web research request was rejected by the provider.", false, status);
      }
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > OLLAMA_RESEARCH_LIMITS.maxResponseBytes) {
        throw new ResearchFailure("LIMIT_EXCEEDED", "Ollama web research response exceeds the byte limit.");
      }
      if (!response.body) throw new ResearchFailure("PROVIDER_ERROR", "Ollama web research returned an empty response body.");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const item = await abortable(reader.read(), controller.signal);
        if (item.done) break;
        size += item.value.byteLength;
        if (size > OLLAMA_RESEARCH_LIMITS.maxResponseBytes) {
          throw new ResearchFailure("LIMIT_EXCEEDED", "Ollama web research response exceeds the byte limit.");
        }
        chunks.push(item.value);
      }
      assertActive(context);
      if (controller.signal.aborted) throw controller.signal.reason;
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
      } catch {
        throw new ResearchFailure("PROVIDER_ERROR", "Ollama web research response is not valid UTF-8 JSON.");
      }
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", cancel);
      if (reader) {
        // Never await cancel: a malicious/stalled stream may never settle it.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      } else {
        void response?.body?.cancel().catch(() => {});
      }
    }
  }

  async search(input: Parameters<ResearchPort["search"]>[0], context: ToolExecutionContext): ReturnType<ResearchPort["search"]> {
    try {
      assertActive(context);
      if (input.cursor !== undefined) throw new ResearchFailure("UNSUPPORTED", "Ollama web search does not support cursors. Refine the query instead of retrying a page.");
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query || byteLength(query) > OLLAMA_RESEARCH_LIMITS.maxQueryBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(query)) {
        throw new ResearchFailure("INVALID_INPUT", "Search query must contain 1–2048 UTF-8 bytes of readable text.");
      }
      if (this.hasCredential(query)) throw new ResearchFailure("INVALID_INPUT", "Search query must not contain the research API key.");
      const limit = input.limit ?? OLLAMA_RESEARCH_LIMITS.defaultSearchResults;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > OLLAMA_RESEARCH_LIMITS.maxSearchResults) {
        throw new ResearchFailure("INVALID_INPUT", "Ollama web search limit must be an integer between 1 and 10.");
      }
      const payload = await this.request("web_search", { query, max_results: limit }, context);
      if (!isObject(payload) || !Array.isArray(payload.results)) {
        throw new ResearchFailure("PROVIDER_ERROR", `Ollama web search response is missing its results array (${schemaDiagnostic(payload, ["results"])}).`);
      }
      const results: ResearchSearchHit[] = [];
      let truncated = payload.results.length > limit;
      for (const candidate of payload.results) {
        if (!isObject(candidate) || typeof candidate.title !== "string" || typeof candidate.content !== "string" || typeof candidate.url !== "string") {
          throw new ResearchFailure("PROVIDER_ERROR", `Ollama web search returned an invalid result schema (${schemaDiagnostic(candidate, ["title", "content", "url"])}).`);
        }
        const parsed = publicUrl(candidate.url);
        if (!parsed || this.hasCredential(candidate.url) || this.hasCredential(parsed.href)) {
          truncated = true;
          continue;
        }
        if (results.length >= limit) continue;
        const title = boundedText(this.redact(candidate.title).trim() || parsed.hostname, OLLAMA_RESEARCH_LIMITS.maxTitleBytes);
        const snippet = boundedText(this.redact(candidate.content), OLLAMA_RESEARCH_LIMITS.maxSnippetBytes);
        truncated ||= title.truncated || snippet.truncated;
        results.push(Object.freeze({ provider: "ollama", title: title.text, url: parsed.href, snippet: snippet.text }));
      }
      return portSuccess(Object.freeze({
        pagination: Object.freeze({ hasMore: truncated }),
        results: Object.freeze(results),
        trust: "untrusted_data" as const,
      }));
    } catch (error) {
      return failure(error);
    }
  }

  async extract(input: Parameters<ResearchPort["extract"]>[0], context: ToolExecutionContext): ReturnType<ResearchPort["extract"]> {
    try {
      assertActive(context);
      if (input.cursor !== undefined) throw new ResearchFailure("UNSUPPORTED", "Ollama web fetch does not support cursors. Use a more specific source URL instead of retrying a page.");
      if (input.extractDepth !== undefined && !["basic", "advanced"].includes(input.extractDepth)) throw new ResearchFailure("INVALID_INPUT", "Unsupported research extraction depth.");
      const parsed = typeof input.url === "string" ? publicUrl(input.url) : null;
      if (!parsed || this.hasCredential(input.url) || this.hasCredential(parsed.href)) {
        throw new ResearchFailure("INVALID_INPUT", "Web fetch requires a public HTTP(S) URL without credentials or private/local addresses.");
      }
      const maxBytes = input.maxBytes ?? OLLAMA_RESEARCH_LIMITS.defaultFetchBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > OLLAMA_RESEARCH_LIMITS.maxFetchBytes) {
        throw new ResearchFailure("INVALID_INPUT", "Ollama web fetch maxBytes must be an integer between 1 and 65536.");
      }
      const payload = await this.request("web_fetch", { url: parsed.href }, context);
      if (!isObject(payload) || typeof payload.title !== "string" || typeof payload.content !== "string" || !Array.isArray(payload.links) || !payload.links.every((link) => typeof link === "string")) {
        throw new ResearchFailure("PROVIDER_ERROR", `Ollama web fetch returned an invalid page schema (${schemaDiagnostic(payload, ["title", "content", "links"])}).`);
      }
      if (!payload.content.trim()) throw new ResearchFailure("NOT_FOUND", "Ollama web fetch returned no readable page content.");
      const bounded = boundedText(this.redact(payload.content), maxBytes);
      return portSuccess(Object.freeze({
        content: bounded.text,
        contentSha256: createHash("sha256").update(bounded.text, "utf8").digest("hex"),
        pagination: Object.freeze({ hasMore: bounded.truncated }),
        provider: "ollama",
        trust: "untrusted_data" as const,
        url: parsed.href,
      }));
    } catch (error) {
      return failure(error);
    }
  }
}
