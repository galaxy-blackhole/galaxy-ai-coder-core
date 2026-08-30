/** Locale-independent UTF-16 code-unit ordering for hashes and replay ties. */
export function compareAiCoderText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
