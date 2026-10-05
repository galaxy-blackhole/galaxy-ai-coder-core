import type { AiCoderPlanSnapshot, AiCoderPlanStep } from "./runtime-types.js";

/**
 * Plan steps are the rich form of the run plan hosts render as a checklist.
 *
 * The model writes them as compact strings — `"doing: viết test"`, `"done: đọc mã"` — so the
 * tool schema stays a bounded string array and the model never has to mint ids. Ids are
 * derived from the titles, which keeps them stable across updates of the same plan.
 */
const STATUS_ALIASES: Readonly<Record<string, AiCoderPlanStep["status"]>> = Object.freeze({
  completed: "completed",
  done: "completed",
  doing: "in_progress",
  in_progress: "in_progress",
  pending: "pending",
  skipped: "skipped",
  skip: "skipped",
  todo: "pending",
  xong: "completed",
});

/** Parse the compact `"<status>: <title>"` form; a bare title is a pending step. */
export function parsePlanStep(input: string): AiCoderPlanStep | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf(":");
  const rawStatus = separator === -1 ? "" : trimmed.slice(0, separator).trim().toLowerCase();
  const title = (separator === -1 ? trimmed : trimmed.slice(separator + 1)).trim();
  if (!title) return null;
  return Object.freeze({
    id: planStepId(title),
    status: STATUS_ALIASES[rawStatus] ?? "pending",
    title,
  });
}

/** Stable, filesystem-safe id for a step title. */
export function planStepId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "step";
}

/** Parse a list of compact strings, dropping blanks and de-duplicating identical ids. */
export function parsePlanSteps(inputs: readonly string[]): readonly AiCoderPlanStep[] {
  const seen = new Set<string>();
  const steps: AiCoderPlanStep[] = [];
  for (const input of inputs) {
    const step = parsePlanStep(input);
    if (step === null) continue;
    let id = step.id;
    let suffix = 2;
    while (seen.has(id)) id = `${step.id}-${suffix++}`;
    seen.add(id);
    steps.push(id === step.id ? step : Object.freeze({ ...step, id }));
  }
  return Object.freeze(steps);
}

/** The three legacy buckets, derived from rich steps so old hosts keep working. */
export function legacyBucketsFromSteps(steps: readonly AiCoderPlanStep[]): Readonly<{
  completed: readonly string[];
  inProgress: string | null;
  pending: readonly string[];
}> {
  return Object.freeze({
    completed: Object.freeze(steps.filter((step) => step.status === "completed").map((step) => step.title)),
    inProgress: steps.find((step) => step.status === "in_progress")?.title ?? null,
    pending: Object.freeze(steps.filter((step) => step.status === "pending").map((step) => step.title)),
  });
}

/** Rich steps derived from the legacy buckets, so a one-line plan still renders as a list. */
export function stepsFromLegacyBuckets(plan: Readonly<{ completed: readonly string[]; inProgress: string | null; pending: readonly string[] }>): readonly AiCoderPlanStep[] {
  const steps: AiCoderPlanStep[] = [];
  for (const title of plan.completed) steps.push(Object.freeze({ id: planStepId(title), status: "completed" as const, title }));
  if (plan.inProgress !== null && plan.inProgress.trim()) steps.push(Object.freeze({ id: planStepId(plan.inProgress), status: "in_progress" as const, title: plan.inProgress }));
  for (const title of plan.pending) steps.push(Object.freeze({ id: planStepId(title), status: "pending" as const, title }));
  return parsePlanSteps(steps.map((step) => `${step.status}: ${step.title}`));
}

/** Fold a plan update into a full snapshot; missing steps fall back to the legacy buckets. */
export function mergePlanSnapshot(
  previous: AiCoderPlanSnapshot | undefined,
  update: Readonly<{ completed: readonly string[]; inProgress: string | null; pending: readonly string[]; steps?: readonly AiCoderPlanStep[] }>,
): AiCoderPlanSnapshot {
  const steps = update.steps?.length ? update.steps : stepsFromLegacyBuckets(update);
  const buckets = legacyBucketsFromSteps(steps);
  return Object.freeze({
    completed: update.completed.length ? update.completed : buckets.completed,
    inProgress: update.inProgress ?? buckets.inProgress,
    pending: update.pending.length ? update.pending : buckets.pending,
    steps: steps.length ? steps : (previous?.steps ?? Object.freeze([])),
  });
}
