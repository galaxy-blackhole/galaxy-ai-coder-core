/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Versioned runtime-only settings for the single coding agent.
 */

/** The core deliberately exposes no multi-agent execution mode. */
export type AiCoderExecutionMode = "single";
export type AiCoderTokenProfile = "balanced" | "conservative" | "extended";
export type AiCoderApprovalProfile =
  | "strict"
  | "balanced"
  | "trusted-workspace";
export type AiCoderProviderKind =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama"
  | "openai-compatible"
  | "host";
export type AiCoderCredentialSource = "manual-config" | "secret-handle";

export type AiCoderSingleAgentSettings = Readonly<{
  baseUrl: string;
  credentialSource: AiCoderCredentialSource;
  maxParallelToolCalls: number;
  maxRetries: number;
  maxToolCalls: number;
  maxToolRounds: number;
  maxTurns: number;
  model: string;
  preserveThinking: boolean;
  provider: AiCoderProviderKind;
  requestTimeoutMs: number;
  temperature: number;
  tokenProfile: AiCoderTokenProfile;
}>;

export type AiCoderSafetySettings = Readonly<{
  approvalProfile: AiCoderApprovalProfile;
}>;

export type AiCoderCoreSettings = Readonly<{
  executionMode: "single";
  safety: AiCoderSafetySettings;
  schemaVersion: 2;
  singleAgent: AiCoderSingleAgentSettings;
}>;

export const DEFAULT_AI_CODER_CORE_SETTINGS: AiCoderCoreSettings = Object.freeze({
  executionMode: "single",
  safety: Object.freeze({ approvalProfile: "balanced" }),
  schemaVersion: 2,
  singleAgent: Object.freeze({
    baseUrl: "https://ollama.com",
    credentialSource: "manual-config",
    maxParallelToolCalls: 1,
    maxRetries: 3,
    maxToolCalls: 48,
    maxToolRounds: 24,
    maxTurns: 24,
    model: "kimi-k2.7-code:cloud",
    preserveThinking: true,
    provider: "ollama",
    requestTimeoutMs: 180_000,
    temperature: 0,
    tokenProfile: "balanced",
  }),
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

/** Runtime guard used when loading untrusted JSON from host settings storage. */
export function isAiCoderCoreSettings(
  value: unknown,
): value is AiCoderCoreSettings {
  if (!isRecord(value) || value.schemaVersion !== 2) return false;
  if (value.executionMode !== "single") return false;
  if (!isRecord(value.safety) || !isRecord(value.singleAgent)) return false;

  const safety = value.safety;
  const singleAgent = value.singleAgent;
  const approvalProfiles: readonly unknown[] = [
    "strict",
    "balanced",
    "trusted-workspace",
  ];
  const credentialSources: readonly unknown[] = [
    "manual-config",
    "secret-handle",
  ];
  const providers: readonly unknown[] = [
    "anthropic",
    "openai",
    "gemini",
    "ollama",
    "openai-compatible",
    "host",
  ];
  const tokenProfiles: readonly unknown[] = [
    "balanced",
    "conservative",
    "extended",
  ];

  return (
    approvalProfiles.includes(safety.approvalProfile) &&
    typeof singleAgent.baseUrl === "string" &&
    singleAgent.baseUrl.length > 0 &&
    credentialSources.includes(singleAgent.credentialSource) &&
    isPositiveInteger(singleAgent.maxParallelToolCalls) &&
    Number.isInteger(singleAgent.maxRetries) &&
    typeof singleAgent.maxRetries === "number" &&
    singleAgent.maxRetries >= 0 &&
    isPositiveInteger(singleAgent.maxToolCalls) &&
    isPositiveInteger(singleAgent.maxToolRounds) &&
    isPositiveInteger(singleAgent.maxTurns) &&
    typeof singleAgent.model === "string" &&
    singleAgent.model.length > 0 &&
    typeof singleAgent.preserveThinking === "boolean" &&
    providers.includes(singleAgent.provider) &&
    isPositiveInteger(singleAgent.requestTimeoutMs) &&
    typeof singleAgent.temperature === "number" &&
    Number.isFinite(singleAgent.temperature) &&
    singleAgent.temperature >= 0 &&
    singleAgent.temperature <= 2 &&
    tokenProfiles.includes(singleAgent.tokenProfile)
  );
}
