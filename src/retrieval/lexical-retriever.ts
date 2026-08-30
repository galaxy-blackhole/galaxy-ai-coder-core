import {
  createAiCoderEvidence,
  deduplicateAiCoderEvidence,
  type AiCoderEvidence,
  type AiCoderEvidenceProvider,
} from "./evidence.js";
import { compareAiCoderText } from "../deterministic-order.js";
import type { AiCoderRetrievalPlan } from "./retrieval-policy.js";

export type AiCoderLexicalPathMatch = Readonly<{
  path: string;
  score?: number;
}>;

export type AiCoderLexicalTextMatch = Readonly<{
  contentHash?: string;
  line: number;
  path: string;
  preview: string;
  score?: number;
}>;

export type AiCoderLexicalReadResult = Readonly<{
  content: string;
  contentHash: string;
  endLine: number;
  path: string;
  startLine: number;
  truncated: boolean;
}>;

export interface AiCoderLexicalRetrievalAdapter {
  readRange(input: Readonly<{
    endLine: number;
    maxBytes: number;
    path: string;
    signal?: AbortSignal;
    startLine: number;
  }>): Promise<AiCoderLexicalReadResult>;
  searchPaths(input: Readonly<{
    limit: number;
    query: string;
    signal?: AbortSignal;
  }>): Promise<readonly AiCoderLexicalPathMatch[]>;
  searchText(input: Readonly<{
    limit: number;
    query: string;
    signal?: AbortSignal;
  }>): Promise<readonly AiCoderLexicalTextMatch[]>;
}

export type AiCoderRetrievalResult = Readonly<{
  bytesRead: number;
  evidence: readonly AiCoderEvidence[];
  exhaustedBudget: boolean;
  filesRead: number;
  queriesRun: number;
}>;

const PROVIDER: AiCoderEvidenceProvider = Object.freeze({
  id: "galaxy.lexical-baseline",
  kind: "lexical",
  version: "1.0.0",
});

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Retrieval canceled.", "AbortError");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function evidenceId(parts: readonly (number | string)[]): string {
  const value = parts.join(":");
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  return `lexical:${hash.toString(16).padStart(8, "0")}`;
}

/** Adapter-neutral lexical baseline. Hosts may add syntax, language-service,
 * semantic or graph providers without changing this policy or evidence shape. */
export async function retrieveAiCoderLexicalEvidence(input: Readonly<{
  adapter: AiCoderLexicalRetrievalAdapter;
  plan: AiCoderRetrievalPlan;
  reason: string;
  signal?: AbortSignal;
}>): Promise<AiCoderRetrievalResult> {
  const evidence: AiCoderEvidence[] = [];
  const textMatches: AiCoderLexicalTextMatch[] = [];
  let queriesRun = 0;
  let bytesRead = 0;
  let filesRead = 0;
  let exhaustedBudget = false;

  for (const stage of input.plan.stages) {
    throwIfAborted(input.signal);
    if (stage.kind === "path_search") {
      for (const query of stage.queries) {
        if (queriesRun >= input.plan.budget.maxQueries) break;
        const matches = await input.adapter.searchPaths({
          limit: stage.limit,
          query,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        queriesRun += 1;
        for (const match of matches.slice(0, stage.limit)) {
          evidence.push(createAiCoderEvidence({
            id: evidenceId(["path", query, match.path]),
            kind: "path_match",
            location: Object.freeze({ path: match.path }),
            provider: PROVIDER,
            reason: input.reason,
            relevance: match.score ?? 0.55,
            snippet: match.path,
          }));
        }
      }
    } else if (stage.kind === "text_search") {
      for (const query of stage.queries) {
        if (queriesRun >= input.plan.budget.maxQueries) break;
        const matches = await input.adapter.searchText({
          limit: stage.limit,
          query,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        queriesRun += 1;
        for (const match of matches.slice(0, stage.limit)) {
          textMatches.push(match);
          evidence.push(createAiCoderEvidence({
            ...(match.contentHash ? { contentHash: match.contentHash } : {}),
            id: evidenceId(["text", query, match.path, match.line]),
            kind: "text_match",
            location: Object.freeze({ endLine: match.line, path: match.path, startLine: match.line }),
            provider: PROVIDER,
            reason: input.reason,
            relevance: match.score ?? 0.7,
            snippet: match.preview,
          }));
        }
      }
    } else {
      const distinct = [...new Map(textMatches.map((match) => [match.path, match])).values()]
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0)
          || compareAiCoderText(left.path, right.path)
          || left.line - right.line)
        .slice(0, Math.min(stage.limit, input.plan.budget.maxFiles));
      for (const match of distinct) {
        throwIfAborted(input.signal);
        if (bytesRead >= input.plan.budget.maxBytes) {
          exhaustedBudget = true;
          break;
        }
        const startLine = Math.max(1, match.line - input.plan.budget.readContextLines);
        const endLine = match.line + input.plan.budget.readContextLines;
        const remainingBytes = Math.max(1, input.plan.budget.maxBytes - bytesRead);
        const read = await input.adapter.readRange({
          endLine,
          maxBytes: remainingBytes,
          path: match.path,
          ...(input.signal ? { signal: input.signal } : {}),
          startLine,
        });
        const usedBytes = byteLength(read.content);
        bytesRead += usedBytes;
        filesRead += 1;
        exhaustedBudget ||= read.truncated || bytesRead >= input.plan.budget.maxBytes;
        evidence.push(createAiCoderEvidence({
          contentHash: read.contentHash,
          id: evidenceId(["range", read.path, read.startLine, read.endLine, read.contentHash]),
          kind: "file_range",
          location: Object.freeze({ endLine: read.endLine, path: read.path, startLine: read.startLine }),
          provider: PROVIDER,
          reason: input.reason,
          relevance: Math.max(0.75, match.score ?? 0),
          snippet: read.content,
        }));
      }
    }
  }

  return Object.freeze({
    bytesRead,
    evidence: deduplicateAiCoderEvidence(evidence).slice(0, input.plan.budget.maxMatches),
    exhaustedBudget,
    filesRead,
    queriesRun,
  });
}
