/**
 * Head/middle/tail pruning for tool output, the way a person skims a long log.
 *
 * Model-free and deterministic on purpose. The same text always prunes to the same text, so a replay rebuilds the
 * same context, and pruning costs nothing to run — which is the point: it is tried BEFORE a compaction, and it often
 * brings the pressure back under the threshold, so a whole summarisation call is never spent.
 *
 * The head carries what the call was asked and what it started with; the tail carries how it ended, which is where
 * the answer usually is. The middle is where a large output keeps its bulk.
 */
export interface PruneToolTextOptions {
  /** Characters kept from the start. */
  readonly headChars?: number;
  /** Characters kept from the end. */
  readonly tailChars?: number;
  /** Text at or below this length is left exactly as it is. */
  readonly thresholdChars?: number;
}

export interface PruneToolTextResult {
  /** True when something was removed, so a caller can count what it saved. */
  readonly pruned: boolean;
  readonly removedChars: number;
  readonly text: string;
}

export const DEFAULT_PRUNE_HEAD_CHARS = 1_200;
export const DEFAULT_PRUNE_TAIL_CHARS = 1_200;
export const DEFAULT_PRUNE_THRESHOLD_CHARS = 4_000;

export function pruneToolText(text: string, options: PruneToolTextOptions = {}): PruneToolTextResult {
  const headChars = options.headChars ?? DEFAULT_PRUNE_HEAD_CHARS;
  const tailChars = options.tailChars ?? DEFAULT_PRUNE_TAIL_CHARS;
  const threshold = options.thresholdChars ?? DEFAULT_PRUNE_THRESHOLD_CHARS;
  if (text.length <= threshold || text.length <= headChars + tailChars) {
    return Object.freeze({ pruned: false, removedChars: 0, text });
  }
  const removed = text.length - headChars - tailChars;
  const marker = "\n\n… [" + String(removed) + " ký tự ở giữa đã bỏ khi gọt context — cùng nội dung luôn gọt ra cùng kết quả] …\n\n";
  return Object.freeze({
    pruned: true,
    removedChars: removed,
    text: text.slice(0, headChars) + marker + text.slice(text.length - tailChars),
  });
}
