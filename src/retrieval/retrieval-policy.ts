export type AiCoderRetrievalIntent =
  | "find_text"
  | "inspect_structure"
  | "locate_code"
  | "review_change"
  | "understand_code";

export type AiCoderRetrievalBudget = Readonly<{
  maxBytes: number;
  maxFiles: number;
  maxMatches: number;
  maxQueries: number;
  readContextLines: number;
}>;

export type AiCoderRetrievalStage = Readonly<{
  kind: "path_search" | "read_ranges" | "text_search";
  limit: number;
  queries: readonly string[];
}>;

export type AiCoderRetrievalPlan = Readonly<{
  budget: AiCoderRetrievalBudget;
  intent: AiCoderRetrievalIntent;
  stages: readonly AiCoderRetrievalStage[];
}>;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "be", "các", "cho", "code", "của", "do", "file", "for", "hãy", "in", "is", "là",
  "of", "on", "please", "project", "sửa", "the", "this", "to", "trong", "và", "workspace",
]);

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function terms(goal: string): string[] {
  const quoted = [...goal.matchAll(/["'`]([^"'`]{2,80})["'`]/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const identifiers = goal.match(/[A-Za-z_$][\w$.-]{2,}/g) ?? [];
  const words = goal.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
  return unique([...quoted, ...identifiers, ...words]
    .map((value) => value.trim())
    .filter((value) => value && !STOP_WORDS.has(value.toLocaleLowerCase())))
    .slice(0, 12);
}

export function inferAiCoderRetrievalIntent(goal: string): AiCoderRetrievalIntent {
  const normalized = goal.toLocaleLowerCase();
  if (/\b(review|audit|diff|regression)\b|rà soát|đánh giá/.test(normalized)) return "review_change";
  if (/\b(structure|architecture|directory|folder|tree)\b|cấu trúc|kiến trúc/.test(normalized)) return "inspect_structure";
  if (/\b(where|locate|symbol|definition|reference)\b|ở đâu|định nghĩa|tham chiếu/.test(normalized)) return "locate_code";
  if (/\b(find|search|grep|contains)\b|tìm kiếm|tìm chuỗi/.test(normalized)) return "find_text";
  return "understand_code";
}

export function createAiCoderLexicalRetrievalPlan(input: Readonly<{
  budget?: Partial<AiCoderRetrievalBudget>;
  goal: string;
  intent?: AiCoderRetrievalIntent;
}>): AiCoderRetrievalPlan {
  const budget = Object.freeze({
    maxBytes: Math.max(1, Math.floor(input.budget?.maxBytes ?? 64_000)),
    maxFiles: Math.max(1, Math.floor(input.budget?.maxFiles ?? 12)),
    maxMatches: Math.max(1, Math.floor(input.budget?.maxMatches ?? 40)),
    maxQueries: Math.max(1, Math.floor(input.budget?.maxQueries ?? 4)),
    readContextLines: Math.max(0, Math.floor(input.budget?.readContextLines ?? 12)),
  });
  const intent = input.intent ?? inferAiCoderRetrievalIntent(input.goal);
  const queryTerms = terms(input.goal);
  const pathQueries = queryTerms.filter((value) => /[./\\]|\.(?:ts|tsx|js|jsx|py|rs|go|java|json|md)$/i.test(value));
  const textQueries = queryTerms.filter((value) => !pathQueries.includes(value));
  const pathQuota = pathQueries.length
    ? Math.max(1, budget.maxQueries - (textQueries.length ? 1 : 0))
    : 0;
  const textQuota = Math.max(0, budget.maxQueries - pathQuota);
  const stages: AiCoderRetrievalStage[] = [];
  if (intent === "inspect_structure" || pathQueries.length) {
    stages.push(Object.freeze({
      kind: "path_search",
      limit: budget.maxMatches,
      queries: Object.freeze((pathQueries.length ? pathQueries : queryTerms).slice(0, pathQueries.length ? pathQuota : budget.maxQueries)),
    }));
  }
  if (textQueries.length || !stages.length) {
    stages.push(Object.freeze({
      kind: "text_search",
      limit: budget.maxMatches,
      queries: Object.freeze((textQueries.length ? textQueries : queryTerms).slice(0, pathQueries.length ? textQuota : budget.maxQueries)),
    }));
  }
  if (intent !== "inspect_structure") {
    stages.push(Object.freeze({
      kind: "read_ranges",
      limit: budget.maxFiles,
      queries: Object.freeze([]),
    }));
  }
  return Object.freeze({ budget, intent, stages: Object.freeze(stages) });
}
