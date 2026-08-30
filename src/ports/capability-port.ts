/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Provider-neutral capability discovery and evidence contract.
 */

import type { RunExecutionContext } from "./execution-context.js";
import type { PortResult } from "./port-result.js";

export type CapabilityState = "supported" | "unsupported" | "unknown";
export type ThinkingCapability = "none" | "optional" | "required" | "unknown";

export type ModelIdentity = Readonly<{
  baseUrl: string;
  digest?: string;
  model: string;
  provider: string;
  runtimeVersion?: string;
  tag?: string;
}>;

export type CapabilityEvidence = Readonly<{
  observedAt: string;
  source: "provider_api" | "runtime_probe" | "catalog" | "static_fallback";
  verified: boolean;
}>;

export type ResolvedCapability<T> = Readonly<{
  declared: T;
  effective: T;
  reason: string;
  verified: T | "not_probed";
}>;

export type ModelCapabilities = Readonly<{
  contextWindow?: number;
  evidence: readonly CapabilityEvidence[];
  identity: ModelIdentity;
  input: Readonly<{
    audio: CapabilityState;
    image: CapabilityState;
    text: CapabilityState;
    video: CapabilityState;
  }>;
  maxImages?: number;
  maxOutputTokens?: number;
  output: Readonly<{
    image: CapabilityState;
    text: CapabilityState;
  }>;
  parallelToolCalling: CapabilityState;
  preserveThinking: CapabilityState;
  streaming: CapabilityState;
  structuredOutput: CapabilityState;
  supportedImageMimeTypes?: readonly string[];
  thinking: ThinkingCapability;
  tokenCounting: CapabilityState;
  toolCalling: CapabilityState;
}>;

export type CapabilityRequest = ModelIdentity &
  Readonly<{
    forceProbe?: boolean;
  }>;

export interface CapabilityPort {
  resolve(
    request: CapabilityRequest,
    context: RunExecutionContext,
  ): Promise<PortResult<ModelCapabilities>>;
}
