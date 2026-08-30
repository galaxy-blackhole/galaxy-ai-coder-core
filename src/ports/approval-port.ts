/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Correlated, cancellable host-side approval contract.
 */

import type { AiCoderToolDescriptor } from "../tools/tool-registry-types.js";
import type { AiCoderApprovalProfile } from "../tools/settings-types.js";
import type { ToolExecutionContext } from "./execution-context.js";
import type { PortResult } from "./port-result.js";

export type AiCoderApprovalScope = "once" | "run" | "workspace";

export type AiCoderApprovalRequest = Readonly<{
  approvalProfile: AiCoderApprovalProfile;
  argumentsValue: Readonly<Record<string, unknown>>;
  reason: string;
  requestId: string;
  suggestedScope: AiCoderApprovalScope;
  tool: AiCoderToolDescriptor;
}>;

export type AiCoderApprovalDecision = Readonly<{
  approved: boolean;
  decidedAt: string;
  reason?: string;
  scope: AiCoderApprovalScope;
}>;

/** Missing, failed, timed-out, or canceled callbacks must be treated as denial. */
export type ApprovalPort = (
  request: AiCoderApprovalRequest,
  context: ToolExecutionContext,
) => Promise<PortResult<AiCoderApprovalDecision>>;
