import type { AgentEmbeddingPort } from "../../../agent/index.js";

export type OllamaEmbeddingFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OllamaEmbeddingsOptions {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly fetch?: OllamaEmbeddingFetch;
  readonly maxBatch?: number;
  readonly model: string;
  readonly requestTimeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BATCH = 16;

function isLocalhost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch { return false; }
}
async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = ""; let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new Error("Ollama embedding response exceeded 4 MiB."); }
    text += decoder.decode(part.value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Ollama /api/embed adapter. Capability-gated: the host only mounts it when an
 * embedding model is configured. Credentials are sent to remote endpoints but
 * never to a localhost endpoint.
 */
export class OllamaEmbeddings implements AgentEmbeddingPort {
  readonly model: string;
  private readonly fetchImpl: OllamaEmbeddingFetch;
  private readonly maxBatch: number;
  private readonly requestTimeoutMs: number;
  constructor(private readonly options: OllamaEmbeddingsOptions) {
    if (!options.model.trim()) throw new Error("An Ollama embedding model id is required.");
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Ollama embedding base URL must use HTTP or HTTPS.");
    if (url.username || url.password) throw new Error("Ollama embedding base URL must not embed credentials.");
    this.model = options.model.trim();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxBatch = Math.max(1, Math.min(64, options.maxBatch ?? DEFAULT_MAX_BATCH));
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }
  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    const vectors: (readonly number[])[] = [];
    for (let start = 0; start < texts.length; start += this.maxBatch) {
      vectors.push(...await this.embedBatch(texts.slice(start, start + this.maxBatch)));
    }
    return vectors;
  }
  private async embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Ollama embedding request timed out.")), this.requestTimeoutMs);
    try {
      const endpoint = new URL("/api/embed", this.options.baseUrl).href;
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.options.apiKey && !isLocalhost(this.options.baseUrl) ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: [...texts] }),
        signal: controller.signal,
      });
      const raw = await boundedText(response);
      if (!response.ok) throw new Error(`Ollama embedding failed (${response.status}): ${raw.slice(0, 300) || "no body"}`);
      const parsed = JSON.parse(raw) as { embeddings?: unknown };
      if (!Array.isArray(parsed.embeddings) || parsed.embeddings.length !== texts.length) throw new Error("Ollama embedding response did not match the input batch.");
      return parsed.embeddings.map((vector) => {
        if (!Array.isArray(vector) || vector.length === 0 || vector.some(value => typeof value !== "number" || !Number.isFinite(value))) {
          throw new Error("Ollama embedding response contained an invalid vector.");
        }
        return vector as number[];
      });
    } finally { clearTimeout(timer); }
  }
}
