/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Bounded external research whose content always remains untrusted data.
 */

import type { ToolExecutionContext } from "./execution-context.js";
import type { PaginationRequest, PaginationResult } from "./pagination.js";
import type { PortResult } from "./port-result.js";

export type ResearchSearchHit = Readonly<{
  provider?: string;
  snippet?: string;
  title: string;
  url: string;
}>;

export type ResearchExtractResult = Readonly<{
  content: string;
  contentSha256: string;
  pagination: PaginationResult;
  provider?: string;
  trust: "untrusted_data";
  url: string;
}>;

export interface ResearchPort {
  search(
    input: PaginationRequest & Readonly<{ query: string }>,
    context: ToolExecutionContext,
  ): Promise<
    PortResult<
      Readonly<{
        pagination: PaginationResult;
        results: readonly ResearchSearchHit[];
        trust: "untrusted_data";
      }>
    >
  >;
  extract(
    input: Readonly<{
      cursor?: string;
      extractDepth?: "basic" | "advanced";
      maxBytes?: number;
      url: string;
    }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<ResearchExtractResult>>;
}
