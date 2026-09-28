import {
  isAiCoderWorkspaceMutationEvidence,
  type AiCoderWorkspaceEntryKind,
} from "../context/checkpoint.js";
import { canonicalResearchUrl, researchCitations } from "./research-citations.js";

export type AiCoderCompletionWrite = Readonly<{
  afterHash: string | null;
  afterKind?: AiCoderWorkspaceEntryKind;
  beforeHash: string | null;
  beforeKind?: AiCoderWorkspaceEntryKind;
  path: string;
  sequence: number;
  toolCallId: string;
  workspaceFingerprint: string;
}>;

export type AiCoderCompletionValidation = Readonly<{
  detail: string;
  id: string;
  paths?: readonly string[];
  scope: "paths" | "workspace";
  sequence: number;
  status: "failed" | "not_run" | "passed";
  workspaceFingerprint: string;
}>;

export type AiCoderCompletionDiffReview = Readonly<{
  diffHash: string;
  sequence: number;
  workspaceFingerprint: string;
}>;

export type AiCoderAcceptanceCriterion = Readonly<{
  evidenceIds: readonly string[];
  id: string;
  required: boolean;
  status: "pending" | "satisfied" | "waived";
  text: string;
}>;

export type AiCoderCompletionSnapshot = Readonly<{
  acceptanceCriteria: readonly AiCoderAcceptanceCriterion[];
  finalDiffReview: AiCoderCompletionDiffReview | null;
  finalReport: string;
  finalReportStored: boolean;
  finalWorkspaceFingerprint: string | null;
  inspectedWorkspace: boolean;
  openProblems?: readonly string[];
  pendingApprovals: number;
  researchSources: readonly Readonly<{
    contentHash: string | null;
    kind: "fetch" | "search";
    toolCallId: string;
    url: string;
  }>[];
  runningToolCalls: number;
  tokenLedgerFinalized: boolean;
  traceFinalized: boolean;
  validations: readonly AiCoderCompletionValidation[];
  writes: readonly AiCoderCompletionWrite[];
}>;

export type AiCoderCompletionRequirements = Readonly<{
  requireFinalReportPersistence?: boolean;
  requireInspection?: boolean;
  requireTokenLedger?: boolean;
  requireTrace?: boolean;
  requireValidation?: boolean;
  research?: Readonly<{
    minFetchCalls?: number;
    minSearchCalls?: number;
    requireCitations?: boolean;
    requiredDomains?: readonly string[];
  }>;
}>;

export type AiCoderCompletionIssue = Readonly<{
  code:
    | "ACCEPTANCE_CRITERIA_OPEN"
    | "DIFF_NOT_REVIEWED"
    | "FINAL_REPORT_EMPTY"
    | "FINAL_REPORT_NOT_STORED"
    | "INSPECTION_MISSING"
    | "OPEN_PROBLEMS"
    | "PENDING_APPROVAL"
    | "RESEARCH_CITATION_MISSING"
    | "RESEARCH_CITATION_UNSUPPORTED"
    | "RESEARCH_EVIDENCE_MISSING"
    | "RUNNING_TOOL_CALL"
    | "TOKEN_LEDGER_NOT_FINALIZED"
    | "TRACE_NOT_FINALIZED"
    | "VALIDATION_FAILED"
    | "VALIDATION_MISSING"
    | "WORKSPACE_EVIDENCE_STALE"
    | "WRITE_EVIDENCE_INVALID"
    | "WRITE_NOT_VALIDATED";
  detail: string;
}>;

/**
 * Documentation cannot break a build, so a documentation write neither demands a
 * project validation nor invalidates one that already passed. Validating after a
 * README edit is pure cost: the gymflow E2E re-ran a frontend build/lint
 * validation only because the agent wrote README.md afterwards.
 */
const DOCUMENTATION_DIRECTORY = /(?:^|\/)(?:docs?|documentation)\//i;
export function isDocumentationPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (DOCUMENTATION_DIRECTORY.test(normalized)) return true;
  if (/\.(?:md|mdx|txt)$/i.test(normalized)) return true;
  return /(?:^|\/)(?:LICENSE|CHANGELOG|NOTICE|AUTHORS)(?:\.[A-Za-z]+)?$/.test(normalized);
}

function pathCoveredByScope(scopePath: string, writePath: string): boolean {
  const normalizedScope = scopePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const normalizedWrite = writePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalizedScope === "."
    || normalizedWrite === normalizedScope
    || normalizedWrite.startsWith(`${normalizedScope}/`);
}

function validationCovers(validation: AiCoderCompletionValidation, write: AiCoderCompletionWrite): boolean {
  return validation.scope === "workspace"
    || (validation.paths ?? []).some((scopePath) => pathCoveredByScope(scopePath, write.path));
}

function writeIsValidated(
  write: AiCoderCompletionWrite,
  validations: readonly AiCoderCompletionValidation[],
): boolean {
  return validations.some((validation) => validation.status === "passed"
    && validation.sequence > write.sequence
    && validationCovers(validation, write));
}

export function evaluateAiCoderCompletion(
  snapshot: AiCoderCompletionSnapshot,
  requirements: AiCoderCompletionRequirements = {},
): Readonly<{ issues: readonly AiCoderCompletionIssue[]; ok: boolean }> {
  const issues: AiCoderCompletionIssue[] = [];
  const add = (code: AiCoderCompletionIssue["code"], detail: string) => issues.push(Object.freeze({ code, detail }));
  if (!snapshot.finalReport.trim()) add("FINAL_REPORT_EMPTY", "The final user-facing report is empty.");
  if ((requirements.requireInspection ?? true) && !snapshot.inspectedWorkspace) {
    add("INSPECTION_MISSING", "Workspace inspection evidence is missing.");
  }
  if (snapshot.runningToolCalls) add("RUNNING_TOOL_CALL", `${snapshot.runningToolCalls} tool call(s) are still running.`);
  if (snapshot.pendingApprovals) add("PENDING_APPROVAL", `${snapshot.pendingApprovals} approval request(s) are still pending.`);
  const research = requirements.research;
  if (research !== undefined) {
    const searched = snapshot.researchSources.filter((source) => source.kind === "search");
    const fetched = snapshot.researchSources.filter((source) => source.kind === "fetch" && source.contentHash?.trim());
    const searchCalls = new Set(searched.map((source) => source.toolCallId)).size;
    const fetchCalls = new Set(fetched.map((source) => source.toolCallId)).size;
    const missing: string[] = [];
    if (searchCalls < (research.minSearchCalls ?? 0)) {
      missing.push(`search calls ${searchCalls}/${research.minSearchCalls}`);
    }
    if (fetchCalls < (research.minFetchCalls ?? 0)) {
      missing.push(`fetch calls ${fetchCalls}/${research.minFetchCalls}`);
    }
    for (const requiredDomain of research.requiredDomains ?? []) {
      const covered = fetched.some((source) => {
        try {
          const hostname = new URL(source.url).hostname.toLowerCase();
          return hostname === requiredDomain || hostname.endsWith(`.${requiredDomain}`);
        } catch {
          return false;
        }
      });
      if (!covered) missing.push(`fetched domain ${requiredDomain}`);
    }
    if (missing.length) add("RESEARCH_EVIDENCE_MISSING", `Missing research evidence: ${missing.join(", ")}.`);
    if (research.requireCitations
      && !fetched.some((source) => snapshot.finalReport.includes(source.url))) {
      add("RESEARCH_CITATION_MISSING", "The final report must cite at least one successfully fetched source URL.");
    }
    if (research.requireCitations && fetched.length) {
      // Every cited URL must carry successful fetch evidence. Citing a
      // plausible-but-unfetched URL presents an unverified source as
      // evidence; the rejection feedback lets the model rewrite the report
      // with fetched citations inside the completion-rejection budget.
      const fetchedUrls = new Set(fetched.map((source) => canonicalResearchUrl(source.url)));
      const cited = researchCitations(snapshot.finalReport).filter((url) => !fetchedUrls.has(url));
      if (cited.length) {
        add(
          "RESEARCH_CITATION_UNSUPPORTED",
          `The final report cites ${cited.length} URL(s) without successful fetch evidence: ${cited.slice(0, 8).join(", ")}. Cite only URLs returned by successful fetch calls.`,
        );
      }
    }
  }
  if (snapshot.openProblems?.length) {
    add("OPEN_PROBLEMS", `${snapshot.openProblems.length} unresolved problem(s) remain.`);
  }
  const openCriteria = snapshot.acceptanceCriteria.filter((criterion) => criterion.required && criterion.status !== "satisfied");
  if (openCriteria.length) {
    add("ACCEPTANCE_CRITERIA_OPEN", `Open criterion ids: ${openCriteria.map((item) => item.id).join(", ")}.`);
  }
  const latestById = new Map<string, AiCoderCompletionValidation>();
  for (const validation of snapshot.validations) {
    const previous = latestById.get(validation.id);
    if (!previous || previous.sequence <= validation.sequence) latestById.set(validation.id, validation);
  }
  const effectiveValidations = [...latestById.values()];
  // Scope-aware staleness. A validation is void when something it covers changed
  // after it ran: a tracked write inside its scope, or an out-of-band workspace
  // change that no tracked activity explains (fingerprint drift). The previous
  // rule compared the whole-workspace fingerprint, so a README edit or a write in
  // a sibling package voided a frontend build validation and every void cost a
  // full re-validation round; a workspace-scoped validation still covers
  // everything and therefore stays strict.
  const trackedFingerprints = [
    ...snapshot.writes.map((write) => ({ fingerprint: write.workspaceFingerprint, sequence: write.sequence })),
    ...effectiveValidations.map((validation) => ({ fingerprint: validation.workspaceFingerprint, sequence: validation.sequence })),
    ...(snapshot.finalDiffReview === null ? [] : [{ fingerprint: snapshot.finalDiffReview.workspaceFingerprint, sequence: snapshot.finalDiffReview.sequence }]),
  ];
  const latestTracked = trackedFingerprints.reduce<{ fingerprint: string; sequence: number } | null>(
    (latest, item) => (latest === null || item.sequence >= latest.sequence ? item : latest),
    null,
  );
  const workspaceDrifted = snapshot.finalWorkspaceFingerprint === null
    || (latestTracked !== null && latestTracked.fingerprint !== snapshot.finalWorkspaceFingerprint);
  const currentValidations = effectiveValidations.filter((validation) => !workspaceDrifted && !snapshot.writes.some((write) => (
    write.sequence > validation.sequence
    && !isDocumentationPath(write.path)
    && validationCovers(validation, write)
  )));
  const staleValidations = effectiveValidations.filter((validation) => !currentValidations.includes(validation));
  if (staleValidations.length) {
    add("WORKSPACE_EVIDENCE_STALE", `Stale validation ids: ${staleValidations.map((item) => item.id).join(", ")}.`);
  }
  const failedValidations = currentValidations.filter((validation) => validation.status === "failed");
  if (failedValidations.length) {
    add("VALIDATION_FAILED", `Failed validation ids: ${failedValidations.map((item) => item.id).join(", ")}.`);
  }
  if ((requirements.requireValidation ?? false) && !currentValidations.some((item) => item.status === "passed")) {
    add("VALIDATION_MISSING", "A successful validation result is required.");
  }
  for (const write of snapshot.writes) {
    if (!write.path.trim() || !write.workspaceFingerprint.trim()
      || !isAiCoderWorkspaceMutationEvidence(write)) {
      add("WRITE_EVIDENCE_INVALID", `${write.path || "<blank>"} does not contain valid mutation evidence.`);
    }
    if (!isDocumentationPath(write.path) && !writeIsValidated(write, currentValidations)) {
      add("WRITE_NOT_VALIDATED", `${write.path} has no later successful validation evidence.`);
    }
  }
  const lastWriteSequence = Math.max(0, ...snapshot.writes.map((item) => item.sequence));
  const finalDiffIsCurrent = snapshot.finalDiffReview !== null
    && snapshot.finalWorkspaceFingerprint !== null
    && snapshot.finalDiffReview.sequence > lastWriteSequence
    && snapshot.finalDiffReview.workspaceFingerprint === snapshot.finalWorkspaceFingerprint
    && snapshot.finalDiffReview.diffHash.trim().length > 0;
  if (snapshot.writes.length && !finalDiffIsCurrent) {
    add("DIFF_NOT_REVIEWED", "The final diff has not been reviewed after workspace mutation.");
  }
  if ((requirements.requireFinalReportPersistence ?? false) && !snapshot.finalReportStored) {
    add("FINAL_REPORT_NOT_STORED", "The final report has not been persisted.");
  }
  if ((requirements.requireTokenLedger ?? true) && !snapshot.tokenLedgerFinalized) {
    add("TOKEN_LEDGER_NOT_FINALIZED", "The token ledger has not been finalized.");
  }
  if ((requirements.requireTrace ?? false) && !snapshot.traceFinalized) {
    add("TRACE_NOT_FINALIZED", "The trace has not been finalized.");
  }
  return Object.freeze({ issues: Object.freeze(issues), ok: issues.length === 0 });
}
