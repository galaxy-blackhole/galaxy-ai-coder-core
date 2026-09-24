/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Fail-closed approval, permission, transport, and task-mode policy.
 */

import type {
  ApprovalPort,
  AiCoderApprovalRequest,
  AiCoderApprovalScope,
} from "../ports/approval-port.js";
import type { ToolExecutionContext } from "../ports/execution-context.js";
import type { AiCoderApprovalProfile } from "../tools/settings-types.js";
import {
  isAiCoderToolAllowedInMode,
} from "../tools/tool-registry.js";
import type {
  AiCoderToolDescriptor,
  AiCoderToolRisk,
  AiCoderToolTransport,
} from "../tools/tool-registry-types.js";

export type { AiCoderApprovalRequest } from "../ports/approval-port.js";
export type { ApprovalPort as AiCoderApprovalCallback } from "../ports/approval-port.js";

export type AiCoderApprovalPolicyDecision = Readonly<{
  allowed: boolean;
  approvalScope?: AiCoderApprovalScope;
  decision:
    | "approved_by_host"
    | "auto_approve"
    | "deny_approval_error"
    | "deny_approval_timeout"
    | "deny_approval_unavailable"
    | "deny_canceled"
    | "deny_missing_permission"
    | "deny_run_mode"
    | "deny_transport"
    | "denied_by_host";
  reason: string;
  requestId?: string;
}>;

const RISK_ORDER: Readonly<Record<AiCoderToolRisk, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
});

const APPROVAL_THRESHOLDS: Readonly<Record<AiCoderApprovalProfile, AiCoderToolRisk>> = Object.freeze({
  "trusted-workspace": "critical",
  balanced: "high",
  strict: "medium",
});

const DEFAULT_ALLOWED_TRANSPORTS: ReadonlySet<AiCoderToolTransport> = new Set(["native", "core"]);
const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

export function resolveAiCoderManifestPermissions(manifest: unknown): ReadonlySet<string> {
  if (!manifest || typeof manifest !== "object") return new Set();
  const permissions = (manifest as { permissions?: unknown }).permissions;
  if (!Array.isArray(permissions)) return new Set();
  return new Set(
    permissions
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function requiresAiCoderApproval(
  approvalProfile: AiCoderApprovalProfile,
  tool: AiCoderToolDescriptor,
): boolean {
  if (tool.mutability === "external_side_effect") return true;
  return RISK_ORDER[tool.risk] >= RISK_ORDER[APPROVAL_THRESHOLDS[approvalProfile]];
}

function approvalReason(tool: AiCoderToolDescriptor, approvalProfile: AiCoderApprovalProfile) {
  const detail = tool.mutability === "external_side_effect" ? "external side effect" : `${tool.risk} risk`;
  return `Approval profile ${approvalProfile} yêu cầu xác nhận ${tool.id} (${detail}).`;
}

type ApprovalOutcome =
  | Readonly<{ kind: "canceled" }>
  | Readonly<{ kind: "error"; code: string }>
  | Readonly<{ kind: "result"; result: Awaited<ReturnType<ApprovalPort>> }>
  | Readonly<{ kind: "timeout" }>;

function waitForApproval(
  callback: ApprovalPort,
  request: AiCoderApprovalRequest,
  context: ToolExecutionContext,
  timeoutMs: number,
): Promise<ApprovalOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const requestController = new AbortController();
    const finish = (outcome: ApprovalOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      // Close the host prompt when this request expires, without canceling the run.
      requestController.abort();
      resolve(outcome);
    };
    const onAbort = () => finish({ kind: "canceled" });
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) {
      onAbort();
      return;
    }
    void Promise.resolve().then(async () => {
      if (settled) return;
      try {
        const result = await callback(request, { ...context, signal: requestController.signal });
        finish({ kind: "result", result });
      } catch {
        finish({ kind: "error", code: "APPROVAL_CALLBACK_THROWN" });
      }
    });
  });
}

export function createAiCoderApprovalPolicy(options: Readonly<{
  allowedTransports?: ReadonlySet<AiCoderToolTransport>;
  approvalCallback?: ApprovalPort;
  approvalProfile: AiCoderApprovalProfile;
  approvalTimeoutMs?: number;
  grantedPermissions?: ReadonlySet<string>;
  now?: () => number;
}>) {
  const allowedTransports = options.allowedTransports ?? DEFAULT_ALLOWED_TRANSPORTS;
  const grantedPermissions = options.grantedPermissions ?? new Set<string>();
  const now = options.now ?? Date.now;
  const configuredTimeout = Math.max(1, options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);

  return async (
    tool: AiCoderToolDescriptor,
    argumentsValue: Readonly<Record<string, unknown>>,
    context: ToolExecutionContext,
  ): Promise<AiCoderApprovalPolicyDecision> => {
    if (context.signal.aborted || now() >= context.deadline) {
      return Object.freeze({
        allowed: false,
        decision: "deny_canceled",
        reason: `Run ${context.runId} đã bị hủy hoặc hết deadline trước khi thực thi ${tool.id}.`,
      });
    }
    if (!isAiCoderToolAllowedInMode(tool, context.mode)) {
      return Object.freeze({
        allowed: false,
        decision: "deny_run_mode",
        reason: `Task mode ${context.mode} không cho phép ${tool.mutability} tool ${tool.id}.`,
      });
    }
    const missingPermissions = tool.permissions.filter((permission) => !grantedPermissions.has(permission));
    if (missingPermissions.length > 0) {
      return Object.freeze({
        allowed: false,
        decision: "deny_missing_permission",
        reason: `Tool ${tool.id} thiếu permission ${missingPermissions.join(", ")} trong manifest AI Coder.`,
      });
    }
    if (!allowedTransports.has(tool.transport)) {
      return Object.freeze({
        allowed: false,
        decision: "deny_transport",
        reason: `Transport ${tool.transport} của ${tool.id} chưa có policy adapter được host tin cậy.`,
      });
    }
    if (!requiresAiCoderApproval(options.approvalProfile, tool)) {
      return Object.freeze({
        allowed: true,
        decision: "auto_approve",
        reason: `Profile ${options.approvalProfile} cho phép ${tool.id} (${tool.risk}, ${tool.mutability}).`,
      });
    }

    const reason = approvalReason(tool, options.approvalProfile);
    const requestId = `${context.runId}:${context.toolCallId}`;
    if (!options.approvalCallback) {
      return Object.freeze({
        allowed: false,
        decision: "deny_approval_unavailable",
        reason: `${reason} Host không cung cấp approval callback nên yêu cầu bị từ chối.`,
        requestId,
      });
    }

    const remainingMs = context.deadline - now();
    if (remainingMs <= 0) {
      return Object.freeze({
        allowed: false,
        decision: "deny_canceled",
        reason: `${reason} Run đã hết deadline.`,
        requestId,
      });
    }
    const request: AiCoderApprovalRequest = Object.freeze({
      approvalProfile: options.approvalProfile,
      argumentsValue,
      reason,
      requestId,
      suggestedScope: "once",
      tool,
    });
    const outcome = await waitForApproval(
      options.approvalCallback,
      request,
      context,
      Math.min(configuredTimeout, remainingMs),
    );
    if (outcome.kind === "canceled") {
      return Object.freeze({ allowed: false, decision: "deny_canceled", reason: `${reason} Approval bị hủy.`, requestId });
    }
    if (outcome.kind === "timeout") {
      return Object.freeze({ allowed: false, decision: "deny_approval_timeout", reason: `${reason} Approval đã timeout.`, requestId });
    }
    if (outcome.kind === "error") {
      return Object.freeze({ allowed: false, decision: "deny_approval_error", reason: `${reason} Host approval callback lỗi (${outcome.code}).`, requestId });
    }
    if (!outcome.result.ok) {
      return Object.freeze({
        allowed: false,
        decision: "deny_approval_error",
        reason: `${reason} Host trả lỗi ${outcome.result.error.code}: ${outcome.result.error.message}`,
        requestId,
      });
    }
    const decision = outcome.result.data;
    if (!decision.approved) {
      return Object.freeze({
        allowed: false,
        approvalScope: decision.scope,
        decision: "denied_by_host",
        reason: decision.reason || `Host từ chối approval cho ${tool.id}.`,
        requestId,
      });
    }
    return Object.freeze({
      allowed: true,
      approvalScope: decision.scope,
      decision: "approved_by_host",
      reason: decision.reason || reason,
      requestId,
    });
  };
}
