/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-21
 * @desc Versioned context profile configs (conservative/balanced/extended) and pressure classification. Budgets derive from ModelCapabilities and calibrated safety rate.
 */

import type { ModelCapabilities } from "../ports/capability-port.js";
import type { AiCoderTokenProfile } from "../tools/settings-types.js";

export const AI_CODER_CONTEXT_PROFILE_SCHEMA_VERSION = 1;
export const AI_CODER_CONTEXT_PROFILE_CONFIG_VERSION = "1.1.0";

export type AiCoderContextPressure = "normal" | "tighten" | "evict" | "compact" | "blocked";

export type AiCoderContextProfileConfig = Readonly<{
  compactionThreshold: number;
  configVersion: string;
  evictionThreshold: number;
  maxToolRoundsBeforeCheckpoint: number;
  name: AiCoderTokenProfile;
  outputReserveTokens: number;
  schemaVersion: number;
  softInputTokens: number;
  tightenThreshold: number;
  toolDefinitionBudget: number;
}>;

export type AiCoderResolvedContextBudget = Readonly<{
  compactionThreshold: number;
  contextWindow: number;
  evictionThreshold: number;
  fallbackContextWindow: boolean;
  hardInputTokens: number;
  outputReserveTokens: number;
  profile: AiCoderContextProfileConfig;
  safetyRate: number;
  safetyReserveTokens: number;
  softInputTokens: number;
  tightenThreshold: number;
}>;

const PROFILE_CONFIGS: Readonly<Record<AiCoderTokenProfile, AiCoderContextProfileConfig>> = Object.freeze({
  conservative: Object.freeze({
    compactionThreshold: 150_000,
    configVersion: AI_CODER_CONTEXT_PROFILE_CONFIG_VERSION,
    evictionThreshold: 120_000,
    maxToolRoundsBeforeCheckpoint: 16,
    name: "conservative",
    outputReserveTokens: 32_768,
    schemaVersion: AI_CODER_CONTEXT_PROFILE_SCHEMA_VERSION,
    softInputTokens: 120_000,
    tightenThreshold: 90_000,
    toolDefinitionBudget: 8_000,
  }),
  balanced: Object.freeze({
    compactionThreshold: 190_000,
    configVersion: AI_CODER_CONTEXT_PROFILE_CONFIG_VERSION,
    evictionThreshold: 160_000,
    maxToolRoundsBeforeCheckpoint: 24,
    name: "balanced",
    outputReserveTokens: 32_768,
    schemaVersion: AI_CODER_CONTEXT_PROFILE_SCHEMA_VERSION,
    softInputTokens: 160_000,
    tightenThreshold: 120_000,
    toolDefinitionBudget: 10_000,
  }),
  extended: Object.freeze({
    compactionThreshold: 210_000,
    configVersion: AI_CODER_CONTEXT_PROFILE_CONFIG_VERSION,
    evictionThreshold: 190_000,
    maxToolRoundsBeforeCheckpoint: 32,
    name: "extended",
    outputReserveTokens: 32_768,
    schemaVersion: AI_CODER_CONTEXT_PROFILE_SCHEMA_VERSION,
    softInputTokens: 190_000,
    tightenThreshold: 160_000,
    toolDefinitionBudget: 16_000,
  }),
});

export function aiCoderContextProfile(name: AiCoderTokenProfile): AiCoderContextProfileConfig {
  return PROFILE_CONFIGS[name];
}

export function resolveAiCoderContextBudget(
  name: AiCoderTokenProfile,
  capabilities: ModelCapabilities,
  hasCalibratedProviderUsage = false,
): AiCoderResolvedContextBudget {
  const profile = aiCoderContextProfile(name);
  const fallbackContextWindow = !capabilities.contextWindow;
  const contextWindow = capabilities.contextWindow ?? 65_536;
  const safetyRate = hasCalibratedProviderUsage ? 0.05 : 0.10;
  const safetyReserveTokens = Math.max(8_192, Math.ceil(contextWindow * safetyRate));
  const outputReserveTokens = Math.min(profile.outputReserveTokens, Math.floor(contextWindow * 0.5));
  const hardInputTokens = Math.max(1, contextWindow - outputReserveTokens - safetyReserveTokens);
  // Small-context deployments must retain room between their operating target and
  // hard ceiling. Clamping the configured 160K target directly to an 8K/24K hard
  // ceiling made compaction unreachable: the request was classified as blocked
  // before the compact state could ever be observed.
  const softInputTokens = Math.max(1, Math.min(
    profile.softInputTokens,
    Math.floor(hardInputTokens * 0.75),
  ));
  const compactionHeadroom = Math.min(4_096, Math.max(1, Math.floor(hardInputTokens * 0.1)));
  const compactionThreshold = Math.min(
    profile.compactionThreshold,
    Math.max(softInputTokens, hardInputTokens - compactionHeadroom),
  );
  const configuredCompaction = Math.max(1, profile.compactionThreshold);
  const tightenThreshold = Math.max(1, Math.min(
    profile.tightenThreshold,
    Math.floor(compactionThreshold * (profile.tightenThreshold / configuredCompaction)),
  ));
  const evictionThreshold = Math.max(tightenThreshold, Math.min(
    profile.evictionThreshold,
    Math.floor(compactionThreshold * (profile.evictionThreshold / configuredCompaction)),
  ));

  return Object.freeze({
    compactionThreshold,
    contextWindow,
    evictionThreshold,
    fallbackContextWindow,
    hardInputTokens,
    outputReserveTokens,
    profile,
    safetyRate,
    safetyReserveTokens,
    softInputTokens,
    tightenThreshold,
  });
}

export function classifyAiCoderContextPressure(
  currentInputTokens: number,
  projectedInputTokens: number,
  budget: AiCoderResolvedContextBudget,
): AiCoderContextPressure {
  const effectiveInputTokens = Math.max(currentInputTokens, projectedInputTokens);
  if (effectiveInputTokens >= budget.hardInputTokens) return "blocked";
  if (effectiveInputTokens >= budget.compactionThreshold) return "compact";
  if (effectiveInputTokens >= budget.evictionThreshold) return "evict";
  if (effectiveInputTokens >= budget.tightenThreshold) return "tighten";
  return "normal";
}

export function aiCoderToolOutputScale(pressure: AiCoderContextPressure) {
  if (pressure === "tighten") return 0.75;
  if (pressure === "evict" || pressure === "compact" || pressure === "blocked") return 0.5;
  return 1;
}
