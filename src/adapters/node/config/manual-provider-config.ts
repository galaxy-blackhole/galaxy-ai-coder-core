import { DEFAULT_AI_CODER_CORE_SETTINGS } from "../../../index.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonObject = Readonly<Record<string, unknown>>;

export type CredentialSource = "environment" | "manual-config" | "none";

export interface ResolvedOllamaConnection {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly configPath: string;
  readonly credentialSource: CredentialSource;
  /** Optional embedding model + endpoint declared by the same manual entry. */
  readonly embeddingBaseUrl?: string;
  readonly embeddingModel?: string;
  readonly model: string;
}

export interface ResolveOllamaConnectionOptions {
  readonly baseUrl?: string;
  readonly configPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly model?: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function safeProviderBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Ollama base URL must be an absolute HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Ollama base URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Ollama base URL must not contain credentials, query parameters, or a fragment.");
  }
  return parsed.href.replace(/\/+$/, "");
}

async function readManualAgent(configPath: string): Promise<JsonObject | null> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw new Error(`Unable to read Galaxy manual config: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw new Error("Galaxy manual config exceeds 1 MiB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Galaxy manual config is not valid JSON.");
  }
  if (!isObject(parsed) || !Array.isArray(parsed.agent)) {
    throw new Error("Galaxy manual config must contain an agent array.");
  }
  const manual = parsed.agent.find((entry) => isObject(entry) && entry.type === "manual");
  if (manual === undefined) return null;
  if (!isObject(manual)) throw new Error("Galaxy manual provider entry is invalid.");
  return manual;
}

export async function resolveOllamaConnection(
  options: ResolveOllamaConnectionOptions = {},
): Promise<ResolvedOllamaConnection> {
  const configPath = options.configPath ?? join(homedir(), ".galaxy", "config.json");
  const manual = await readManualAgent(configPath);
  const manualApiKey = optionalNonEmpty(manual?.apiKey);
  const environmentApiKey = optionalNonEmpty((options.environment ?? process.env).OLLAMA_API_KEY);
  const apiKey = manualApiKey ?? environmentApiKey;
  const credentialSource: CredentialSource = manualApiKey !== undefined
    ? "manual-config"
    : environmentApiKey !== undefined
      ? "environment"
      : "none";
  const baseUrl = safeProviderBaseUrl(
    options.baseUrl
      ?? optionalNonEmpty(manual?.baseUrl)
      ?? DEFAULT_AI_CODER_CORE_SETTINGS.singleAgent.baseUrl,
  );
  const model = options.model
    ?? optionalNonEmpty(manual?.model)
    ?? DEFAULT_AI_CODER_CORE_SETTINGS.singleAgent.model;
  if (model.trim().length === 0) throw new Error("Ollama model must be non-empty.");
  const embeddingModel = optionalNonEmpty(manual?.embeddingModel);
  const embeddingBaseUrl = optionalNonEmpty(manual?.embeddingBaseUrl);
  return Object.freeze({
    ...(apiKey === undefined ? {} : { apiKey }),
    baseUrl,
    configPath,
    credentialSource,
    ...(embeddingModel === undefined ? {} : { embeddingModel }),
    ...(embeddingBaseUrl === undefined ? {} : { embeddingBaseUrl: safeProviderBaseUrl(embeddingBaseUrl) }),
    model: model.trim(),
  });
}

export function publicOllamaConnection(
  connection: ResolvedOllamaConnection,
): Omit<ResolvedOllamaConnection, "apiKey" | "configPath"> & Readonly<{ configPath: string }> {
  return Object.freeze({
    baseUrl: connection.baseUrl,
    configPath: connection.configPath.replace(homedir(), "~"),
    credentialSource: connection.credentialSource,
    model: connection.model,
  });
}
