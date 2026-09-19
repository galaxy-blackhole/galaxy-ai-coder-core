/**
 * Shared citation extraction and URL canonicalization for research evidence.
 * The completion gate and the host research oracle must agree on which URLs
 * count as cited, so both call these helpers instead of maintaining separate
 * normalizations.
 */

/** Canonicalizes an http(s) URL for citation comparison: credentials rejected, fragment stripped, trailing slash preserved by the URL parser. */
export function canonicalResearchUrl(value: unknown): string | null {
  try {
    const url = new URL(value as string);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Extracts the set of cited URLs from a final report. Trailing prose
 * punctuation is stripped while balanced parentheses that belong to the URL
 * (for example /wiki/Retry_(pattern)) are retained.
 */
export function researchCitations(content: string): string[] {
  return [...new Set((content.match(/https?:\/\/[^\s<>"`[\]]+/g) ?? [])
    .map((match) => {
      let url = match;
      // Markdown emphasis and list punctuation ride outside the URL
      // ("**https://example.com/a**:"), so strip trailing decoration before
      // canonicalizing. Balanced parentheses stay protected below.
      for (;;) {
        const withoutPunctuation = url.replace(/[,.;:!?]+$/, "");
        const withoutEmphasis = withoutPunctuation.replace(/[*_`]+$/, "");
        if (withoutEmphasis === url) break;
        url = withoutEmphasis;
      }
      const open = (url.match(/\(/g) ?? []).length;
      let close = (url.match(/\)/g) ?? []).length;
      while (url.endsWith(")") && close > open) { url = url.slice(0, -1); close--; }
      return canonicalResearchUrl(url);
    })
    .filter((url): url is string => url !== null))];
}
