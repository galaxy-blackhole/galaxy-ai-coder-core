/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Optional local frontend preview controller.
 */

import type { ToolExecutionContext } from "./execution-context.js";
import type { PortResult } from "./port-result.js";

export interface PreviewPort {
  openLocalPreview(
    input: Readonly<{
      command: string;
      expectPort: number;
      screenshot?: boolean;
      waitMs?: number;
    }>,
    context: ToolExecutionContext,
  ): Promise<
    PortResult<
      Readonly<{
        screenshotArtifactId?: string;
        sessionId: string;
        url?: string;
      }>
    >
  >;
  cancelLocalPreview(
    input: Readonly<{ sessionId: string }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<Readonly<{ canceled: boolean }>>>;
}
