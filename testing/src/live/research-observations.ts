import {
  canonicalResearchUrl,
  researchCitations,
  type AiCoderRuntimeEvent,
} from "@galaxy-stack/ai-coder-core";

import type { LiveHealthResearchExpected } from "../domain/live-health-scenario.js";

type Source = Readonly<{
  url: string;
  kind: "search" | "fetch";
  truncated: boolean;
  contentHash?: string;
  /** Bounded diagnostic data, never trusted instructions or a complete page. */
  excerpt: string;
  trust: "untrusted_external";
}>;

export interface ResearchObservations {
  readonly scope: "current_process" | "current_process_with_checkpoint_seed";
  readonly searchCalls: number;
  readonly fetchCalls: number;
  readonly sources: readonly Source[];
  readonly sourcesTruncated: boolean;
  readonly citedUrls: readonly string[];
  readonly unsupportedCitations: readonly string[];
  readonly failedCalls: readonly Readonly<{ tool: string; code: string; domain?: string; status?: number }>[];
  readonly researchBeforeFirstWrite: boolean;
  readonly failures: readonly string[];
}

function domainMatches(url: string, domain: string): boolean {
  const host = new URL(url).hostname;
  return host === domain || host.endsWith(`.${domain}`);
}

function callDomain(value: unknown): string | undefined {
  const url = canonicalResearchUrl(value);
  return url === null ? undefined : new URL(url).hostname;
}

function excerpt(value: unknown): string {
  return typeof value === "string" ? Array.from(value).slice(0, 512).join("") : "";
}

/**
 * Checks observable tool behavior, not the semantic truth of the model's prose.
 * `seededSources` carries research evidence persisted in a checkpoint from an
 * earlier process of the same run; seeded entries precede every observed event
 * so a resumed run keeps credit for research completed before the crash.
 */
export function observeResearch(
  events: readonly AiCoderRuntimeEvent[],
  finalResponse: string,
  expected?: LiveHealthResearchExpected,
  seededSources?: readonly Readonly<{ url: string; kind: "search" | "fetch"; contentHash?: string | null }>[],
): ResearchObservations {
  const searches: number[] = [];
  const fetches: number[] = [];
  const sources: Array<Source & { index: number }> = [];
  const failedCalls: Array<{ tool: string; code: string; domain?: string; status?: number }> = [];
  const starts = new Map<string, number>();
  let firstWrite = Infinity;
  for (const source of seededSources ?? []) {
    const url = canonicalResearchUrl(source.url);
    if (url === null) continue;
    sources.push({
      url,
      kind: source.kind,
      truncated: false,
      index: -1,
      excerpt: "persisted checkpoint research source",
      trust: "untrusted_external",
      ...(typeof source.contentHash === "string" && source.contentHash.trim() ? { contentHash: source.contentHash } : {}),
    });
    if (source.kind === "search") searches.push(-1);
    else fetches.push(-1);
  }
  for (const [index, event] of events.entries()) {
    if (event.type === "tool_start") starts.set(event.call.toolCallId, index);
    if (event.type !== "tool_result") continue;
    if (event.result.effectsAuthority === "host" && (event.result.effects?.writes?.length ?? 0) > 0) {
      firstWrite = Math.min(firstWrite, starts.get(event.call.toolCallId) ?? index);
    }
    const id = event.result.canonicalToolId;
    if (id !== "research.search" && id !== "research.fetch") continue;
    if (!event.result.ok) {
      const argumentsValue = (event.call as Readonly<{ arguments?: Readonly<Record<string, unknown>> }>).arguments;
      const domain = id === "research.fetch" ? callDomain(argumentsValue?.url) : undefined;
      const status = event.result.error?.status;
      failedCalls.push({
        tool: id,
        code: event.result.error?.code ?? "UNKNOWN",
        ...(domain === undefined ? {} : { domain }),
        ...(status === undefined ? {} : { status }),
      });
      continue;
    }
    let output: Record<string, unknown>;
    try { output = JSON.parse(event.result.content) as Record<string, unknown>; }
    catch { failedCalls.push({ tool: id, code: "UNREADABLE_TOOL_OUTPUT" }); continue; }
    if (!output || typeof output !== "object") continue;
    if (id === "research.search" && Array.isArray(output.results)) {
      searches.push(index);
      for (const hit of output.results) {
        const url = canonicalResearchUrl(hit?.url);
        if (url !== null) sources.push({ url, kind: "search", truncated: output.truncated === true, index,
          excerpt: excerpt(hit?.snippet), trust: "untrusted_external" });
      }
    } else if (id === "research.fetch" && typeof output.content === "string" && output.content.trim()) {
      const url = canonicalResearchUrl(output.url);
      if (url !== null) {
        fetches.push(index);
        sources.push({ url, kind: "fetch", truncated: output.truncated === true, index,
          excerpt: excerpt(output.content), trust: "untrusted_external",
          ...(typeof output.contentHash === "string" ? { contentHash: output.contentHash } : {}) });
      }
    }
  }
  const failures: string[] = [];
  const requirements = (boundary: number): string[] => {
    const problems: string[] = [];
    if (searches.filter((index) => index < boundary).length < (expected?.minSearchCalls ?? 0)) problems.push("Too few successful research.search calls.");
    if (fetches.filter((index) => index < boundary).length < (expected?.minFetchCalls ?? 0)) problems.push("Too few non-empty research.fetch calls.");
    for (const domain of expected?.requiredDomains ?? []) {
      if (!sources.some((source) => source.index < boundary && source.kind === "fetch" && domainMatches(source.url, domain))) {
        problems.push(`No successfully fetched source from required domain '${domain}'.`);
      }
    }
    return problems;
  };
  failures.push(...requirements(Infinity));
  const researchBeforeFirstWrite = firstWrite === Infinity
    || (searches.some((index) => index < firstWrite) && fetches.some((index) => index < firstWrite)
      && requirements(firstWrite).length === 0);
  if (expected?.beforeFirstWrite && !researchBeforeFirstWrite) {
    failures.push("Required research was not completed before the first workspace write.");
  }
  const citedUrls = researchCitations(finalResponse);
  const fetchedUrls = new Set(sources.filter((source) => source.kind === "fetch").map((source) => canonicalResearchUrl(source.url)));
  const unsupportedCitations = citedUrls.filter((url) => !fetchedUrls.has(url));
  if (expected?.requireCitations) {
    if (!citedUrls.some((url) => fetchedUrls.has(url))) failures.push("Final response lacks a citation to a successfully fetched source.");
    if (unsupportedCitations.length > 0) failures.push("Final response cites URLs without successful fetch evidence; inspect research.unsupportedCitations.");
  }
  const unique = [...new Map(sources.map(({ index: _index, ...source }) => [`${source.kind}:${source.url}`, source])).values()];
  // Prefer fetched evidence if numerous search discoveries exhaust the report budget.
  unique.sort((left, right) => Number(left.kind === "search") - Number(right.kind === "search"));
  return Object.freeze({
    scope: seededSources?.length ? "current_process_with_checkpoint_seed" : "current_process",
    searchCalls: searches.length,
    fetchCalls: fetches.length,
    sources: Object.freeze(unique.slice(0, 128)),
    sourcesTruncated: unique.length > 128,
    citedUrls: Object.freeze(citedUrls.slice(0, 128)),
    unsupportedCitations: Object.freeze(unsupportedCitations.slice(0, 128)),
    failedCalls: Object.freeze(failedCalls.slice(0, 128)),
    researchBeforeFirstWrite,
    failures: Object.freeze(failures),
  });
}
