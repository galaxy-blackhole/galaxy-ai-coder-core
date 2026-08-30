/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-21
 * @desc Tool descriptor shape used by the registry, router, and approval policy.
 */

import type { AiCoderTaskMode } from "../ports/execution-context.js";
import type { AiCoderJsonSchema } from "./json-schema.js";

export type AiCoderToolCategory =
  | "artifact"
  | "bootstrap"
  | "command"
  | "communication"
  | "git"
  | "perception"
  | "preview"
  | "project"
  | "research"
  | "workspace";

export type AiCoderToolModality = "text" | "image" | "video" | "audio" | "structured_data" | "artifact";
export type AiCoderToolRisk = "low" | "medium" | "high" | "critical";
export type AiCoderToolMutability = "read" | "write" | "execute" | "external_side_effect";
export type AiCoderToolTransport = "native" | "core" | "extension" | "mcp";
export type AiCoderToolIdempotency = "safe" | "with_key" | "unsafe";
export type AiCoderToolRunMode = AiCoderTaskMode;

export type AiCoderToolDescriptor = Readonly<{
  category: AiCoderToolCategory;
  description: string;
  enabledByDefault: boolean;
  id: string;
  idempotency: AiCoderToolIdempotency;
  inputSchema: AiCoderJsonSchema;
  maxOutputBytes: number;
  maxOutputTokens: number;
  modalities: Readonly<{
    accepts: readonly AiCoderToolModality[];
    produces: readonly AiCoderToolModality[];
    requiredModelCapabilities?: readonly string[];
  }>;
  modelName: string;
  mutability: AiCoderToolMutability;
  outputSchema: AiCoderJsonSchema;
  permissions: readonly string[];
  risk: AiCoderToolRisk;
  source: Readonly<{
    extensionId?: string;
    owner: "base" | "core" | "extension" | "mcp";
    serverId?: string;
  }>;
  supportsCancellation: boolean;
  supportsPagination: boolean;
  timeoutMs: number;
  title: string;
  transport: AiCoderToolTransport;
  version: string;
}>;

export type AiCoderToolDiagnostic = Readonly<{
  included: boolean;
  reason: string;
  toolId: string;
  viaFallback?: string;
}>;

export type AiCoderToolRegistrySnapshot = Readonly<{
  /** Hash of every descriptor visible after host capability, permission, and mode filtering. */
  catalogHash: string;
  descriptors: readonly AiCoderToolDescriptor[];
  diagnostics: readonly AiCoderToolDiagnostic[];
  /** @deprecated Use catalogHash. Kept for trace compatibility during the v2 migration. */
  hash: string;
  mode: AiCoderToolRunMode;
  schemaVersion: string;
}>;

export type AiCoderActiveToolSnapshot = Readonly<{
  /** Hash of the parent filtered catalog. */
  catalogHash: string;
  descriptors: readonly AiCoderToolDescriptor[];
  /** Hash of the exact, canonically ordered tool definitions sent in one model turn. */
  hash: string;
  schemaVersion: string;
}>;
