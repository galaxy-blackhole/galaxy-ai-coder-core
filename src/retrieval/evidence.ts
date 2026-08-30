import { compareAiCoderText } from "../deterministic-order.js";

export type AiCoderEvidenceTrust = "external" | "trusted" | "workspace";

export type AiCoderEvidenceProvider = Readonly<{
  id: string;
  kind: "graph" | "host" | "language_service" | "lexical" | "semantic" | "syntax";
  version: string;
}>;

export type AiCoderEvidenceLocation = Readonly<{
  endColumn?: number;
  endLine?: number;
  path: string;
  startColumn?: number;
  startLine?: number;
  symbol?: string;
}>;

export type AiCoderEvidence = Readonly<{
  contentHash: string | null;
  id: string;
  kind: "file_range" | "instruction" | "path_match" | "symbol" | "text_match";
  location: AiCoderEvidenceLocation;
  provider: AiCoderEvidenceProvider;
  reason: string;
  relevance: number;
  snippet: string;
  stale: boolean;
  trust: AiCoderEvidenceTrust;
}>;

function normalizedPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  return normalized || ".";
}

export function createAiCoderEvidence(input: Readonly<{
  contentHash?: string | null;
  id: string;
  kind: AiCoderEvidence["kind"];
  location: AiCoderEvidenceLocation;
  provider: AiCoderEvidenceProvider;
  reason: string;
  relevance: number;
  snippet?: string;
  stale?: boolean;
  trust?: AiCoderEvidenceTrust;
}>): AiCoderEvidence {
  if (!input.id.trim()) throw new TypeError("Evidence id must be non-empty.");
  if (!input.location.path.trim()) throw new TypeError("Evidence path must be non-empty.");
  if (!input.reason.trim()) throw new TypeError("Evidence reason must be non-empty.");
  return Object.freeze({
    contentHash: input.contentHash ?? null,
    id: input.id,
    kind: input.kind,
    location: Object.freeze({ ...input.location, path: normalizedPath(input.location.path) }),
    provider: Object.freeze({ ...input.provider }),
    reason: input.reason,
    relevance: Math.min(1, Math.max(0, input.relevance)),
    snippet: input.snippet ?? "",
    stale: input.stale ?? false,
    trust: input.trust ?? "workspace",
  });
}

export function sortAiCoderEvidence(values: readonly AiCoderEvidence[]): readonly AiCoderEvidence[] {
  return Object.freeze([...values].sort((left, right) => right.relevance - left.relevance
    || compareAiCoderText(left.location.path, right.location.path)
    || (left.location.startLine ?? 0) - (right.location.startLine ?? 0)
    || compareAiCoderText(left.id, right.id)));
}

export function deduplicateAiCoderEvidence(values: readonly AiCoderEvidence[]): readonly AiCoderEvidence[] {
  const seen = new Set<string>();
  return sortAiCoderEvidence(values.filter((item) => {
    const key = [
      item.kind,
      normalizedPath(item.location.path),
      item.location.startLine ?? "",
      item.location.endLine ?? "",
      item.contentHash ?? item.snippet,
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}
