/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-21
 * @desc Token estimator + vision accounting + per-run ledger. Provider usage overrides estimator when available.
 */

import type { AiCoderAttachment } from "./attachment-types.js";
import type { AiCoderTokenProfile } from "../tools/settings-types.js";

export type AiCoderTokenContentKind = "code" | "english" | "json" | "vietnamese";

export type AiCoderTokenCategories = Readonly<{
  checkpoint: number;
  flexible: number;
  history: number;
  images: number;
  system: number;
  toolDefinitions: number;
  toolResults: number;
  user: number;
  workspace: number;
}>;

export type AiCoderVisionAccounting = Readonly<{
  actualPromptTokenDelta: number | null;
  estimatedVisionTokens: number;
  imageArtifactIds: readonly string[];
  imageCount: number;
  totalDecodedPixels: number;
  totalImageBytes: number;
  visionEstimatorVersion: string;
}>;

export type AiCoderVisionBucket = "large" | "medium" | "small" | "thumbnail";

export type AiCoderTokenLedgerEntry = Readonly<{
  actualInput: number | null;
  /** Prompt-cache hits reported by providers that expose them (0 when supported and all missed). */
  cachedInput: number | null;
  /** cachedInput / actualInput when both are known, else null. */
  cacheHitRate: number | null;
  /** Session-cumulative provider input tokens (sum over completed turns). */
  cumulativeActualInput: number;
  cumulativeCachedInput: number;
  /** cumulativeCachedInput / cumulativeActualInput, matching a session-level UI. */
  cumulativeCacheHitRate: number | null;
  categories: AiCoderTokenCategories;
  compactionCount: number;
  contextWindow: number;
  estimatedInput: number;
  estimationErrorRate: number | null;
  model: string;
  outputTokens: number;
  profile: AiCoderTokenProfile;
  providerOutputTokens: number | null;
  runId: string;
  thinkingTokens: number;
  timestamp: string;
  toolDefinitionTokens: number;
  toolResultTokens: number;
  turn: number;
  vision: AiCoderVisionAccounting;
}>;

export type AiCoderTokenLedgerSnapshot = Readonly<{
  entries: readonly AiCoderTokenLedgerEntry[];
  hasProviderUsage: boolean;
  runId: string;
  schemaVersion: 1;
}>;

const EMPTY_CATEGORIES: AiCoderTokenCategories = Object.freeze({
  checkpoint: 0,
  flexible: 0,
  history: 0,
  images: 0,
  system: 0,
  toolDefinitions: 0,
  toolResults: 0,
  user: 0,
  workspace: 0,
});

const VIETNAMESE_MARKS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const CODE_MARKERS = /(?:=>|\b(?:const|let|var|function|class|interface|return|import|export|def|fn|impl)\b|[{};])/;

function numericValue(record: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return null;
}

export function classifyAiCoderTokenContent(value: string): AiCoderTokenContentKind {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Continue with language/code heuristics for malformed or partial JSON.
    }
  }
  if (CODE_MARKERS.test(value)) return "code";
  if (VIETNAMESE_MARKS.test(value)) return "vietnamese";
  return "english";
}

export class AiCoderTokenEstimator {
  private readonly calibration = new Map<AiCoderTokenContentKind, number>();
  private readonly observedKinds = new Set<AiCoderTokenContentKind>();

  estimateText(value: string, kind = classifyAiCoderTokenContent(value)) {
    if (!value) return 0;
    this.observedKinds.add(kind);
    const charsPerToken = kind === "code" ? 3 : kind === "vietnamese" ? 2.5 : kind === "json" ? 2.8 : 4;
    const calibration = this.calibration.get(kind) ?? 1;
    return Math.ceil((value.length / charsPerToken) * 1.15 * calibration);
  }

  estimateSerializable(value: unknown, kind?: AiCoderTokenContentKind) {
    return this.estimateText(typeof value === "string" ? value : JSON.stringify(value), kind);
  }

  calibrate(kind: AiCoderTokenContentKind, estimated: number, actual: number) {
    if (estimated <= 0 || actual <= 0) return;
    const observed = actual / estimated;
    const previous = this.calibration.get(kind) ?? 1;
    this.calibration.set(kind, Math.min(2, Math.max(0.5, previous * 0.75 + observed * 0.25)));
  }

  calibrateObserved(estimated: number, actual: number) {
    for (const kind of this.observedKinds) this.calibrate(kind, estimated, actual);
    this.observedKinds.clear();
  }
}

function decodedDataUrlBytes(dataUrl?: string) {
  if (!dataUrl) return 0;
  const separator = dataUrl.indexOf(",");
  if (separator < 0) return 0;
  const metadata = dataUrl.slice(0, separator);
  const payload = dataUrl.slice(separator + 1);
  return metadata.includes(";base64")
    ? Math.max(0, Math.floor((payload.length * 3) / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0))
    : new TextEncoder().encode(payload).byteLength;
}

function visionBucket(attachment: AiCoderAttachment): AiCoderVisionBucket {
  const pixels = attachment.decodedPixels ?? ((attachment.width ?? 0) * (attachment.height ?? 0));
  const bytes = attachment.byteLength ?? decodedDataUrlBytes(attachment.dataUrl);
  if (pixels > 0) {
    if (pixels <= 256_000) return "thumbnail";
    if (pixels <= 1_000_000) return "small";
    if (pixels <= 4_000_000) return "medium";
    return "large";
  }
  if (bytes <= 100_000) return "thumbnail";
  if (bytes <= 500_000) return "small";
  if (bytes <= 2_000_000) return "medium";
  return "large";
}

const VISION_BUCKET_DEFAULTS: Readonly<Record<AiCoderVisionBucket, number>> = Object.freeze({
  thumbnail: 800,
  small: 1_800,
  medium: 3_200,
  large: 6_000,
});

export class AiCoderVisionTokenEstimator {
  private readonly factors = new Map<AiCoderVisionBucket, number>();
  private calibrationCount = 0;

  estimate(attachments: readonly AiCoderAttachment[], actualPromptTokenDelta: number | null = null): AiCoderVisionAccounting {
    const estimatedVisionTokens = attachments.reduce((sum, item) => {
      const bucket = visionBucket(item);
      return sum + Math.ceil(VISION_BUCKET_DEFAULTS[bucket] * (this.factors.get(bucket) ?? 1));
    }, 0);
    return Object.freeze({
      actualPromptTokenDelta,
      estimatedVisionTokens,
      imageArtifactIds: Object.freeze(attachments.map((item) => item.artifactId)),
      imageCount: attachments.length,
      totalDecodedPixels: attachments.reduce((sum, item) => sum + (item.decodedPixels ?? ((item.width ?? 0) * (item.height ?? 0))), 0),
      totalImageBytes: attachments.reduce((sum, item) => sum + (item.byteLength ?? decodedDataUrlBytes(item.dataUrl)), 0),
      visionEstimatorVersion: this.calibrationCount ? `calibrated-image-buckets/1.${this.calibrationCount}` : "fallback-image-buckets/1",
    });
  }

  calibrate(attachments: readonly AiCoderAttachment[], actualPromptTokenDelta: number) {
    const baseline = this.estimate(attachments).estimatedVisionTokens;
    if (!attachments.length || baseline <= 0 || actualPromptTokenDelta <= 0) return this.estimate(attachments);
    const ratio = Math.min(2, Math.max(0.5, actualPromptTokenDelta / baseline));
    const buckets = new Set(attachments.map(visionBucket));
    for (const bucket of buckets) {
      const previous = this.factors.get(bucket) ?? 1;
      this.factors.set(bucket, previous * 0.75 + ratio * 0.25);
    }
    this.calibrationCount += 1;
    return this.estimate(attachments, actualPromptTokenDelta);
  }
}

export function accountAiCoderVision(attachments: readonly AiCoderAttachment[]): AiCoderVisionAccounting {
  return new AiCoderVisionTokenEstimator().estimate(attachments);
}

export class AiCoderTokenLedger {
  private readonly entries: AiCoderTokenLedgerEntry[] = [];

  constructor(
    readonly runId: string,
    private readonly timestamp: () => string = () => new Date().toISOString(),
  ) {}

  get hasProviderUsage() {
    return this.entries.some((entry) => entry.actualInput !== null);
  }

  record(input: Readonly<{
    categories?: Partial<AiCoderTokenCategories>;
    compactionCount: number;
    contextWindow: number;
    estimatedInput: number;
    model: string;
    profile: AiCoderTokenProfile;
    turn: number;
    usage?: Readonly<Record<string, unknown>> | null;
    visibleOutput?: string;
    thinking?: string;
    vision?: AiCoderVisionAccounting;
  }>, estimator: AiCoderTokenEstimator): AiCoderTokenLedgerEntry {
    const usage = input.usage ?? {};
    const actualInput = numericValue(usage, ["prompt_eval_count", "input_tokens", "prompt_tokens", "inputTokens"]);
    const cachedInput = numericValue(usage, ["prompt_cache_hit_tokens", "cached_tokens", "cachedInputTokens", "cache_read_input_tokens"]);
    const providerOutputTokens = numericValue(usage, ["eval_count", "output_tokens", "completion_tokens", "outputTokens"]);
    const estimatedThinking = estimator.estimateText(input.thinking ?? "");
    const estimatedVisible = estimator.estimateText(input.visibleOutput ?? "");
    const thinkingTokens = providerOutputTokens === null
      ? estimatedThinking
      : Math.min(providerOutputTokens, estimatedThinking);
    const outputTokens = providerOutputTokens === null
      ? estimatedVisible
      : Math.max(0, providerOutputTokens - thinkingTokens);
    const categories = Object.freeze({ ...EMPTY_CATEGORIES, ...input.categories });
    const cumulativeActualInput = this.entries.reduce((sum, item) => sum + (item.actualInput ?? 0), 0) + (actualInput ?? 0);
    const cumulativeCachedInput = this.entries.reduce((sum, item) => sum + (item.cachedInput ?? 0), 0) + (cachedInput ?? 0);
    const entry = Object.freeze({
      actualInput,
      cachedInput,
      cacheHitRate: actualInput === null || actualInput === 0 || cachedInput === null ? null : cachedInput / actualInput,
      cumulativeActualInput,
      cumulativeCachedInput,
      cumulativeCacheHitRate: cumulativeActualInput === 0 ? null : cumulativeCachedInput / cumulativeActualInput,
      categories,
      compactionCount: input.compactionCount,
      contextWindow: input.contextWindow,
      estimatedInput: input.estimatedInput,
      estimationErrorRate: actualInput === null || actualInput === 0
        ? null
        : Math.abs(input.estimatedInput - actualInput) / actualInput,
      model: input.model,
      outputTokens,
      profile: input.profile,
      providerOutputTokens,
      runId: this.runId,
      thinkingTokens,
      timestamp: this.timestamp(),
      toolDefinitionTokens: categories.toolDefinitions,
      toolResultTokens: categories.toolResults,
      turn: input.turn,
      vision: input.vision ?? accountAiCoderVision([]),
    } satisfies AiCoderTokenLedgerEntry);
    this.entries.push(entry);
    if (actualInput !== null) estimator.calibrateObserved(input.estimatedInput, actualInput);
    return entry;
  }

  snapshot(): AiCoderTokenLedgerSnapshot {
    return Object.freeze({
      entries: Object.freeze([...this.entries]),
      hasProviderUsage: this.hasProviderUsage,
      runId: this.runId,
      schemaVersion: 1,
    });
  }
}
