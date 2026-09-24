import type {
  AiCoderApprovalDecision,
  AiCoderApprovalRequest,
  ApprovalPort,
  ToolExecutionContext,
} from "@galaxy-stack/ai-coder-core/ports";

export function createFixtureApprovalPort(
  decisions: Readonly<Record<string, "allow" | "deny">> = Object.freeze({}),
): ApprovalPort {
  return async (
    request: AiCoderApprovalRequest,
    context: ToolExecutionContext,
  ) => {
    if (context.signal.aborted || Date.now() >= context.deadline) {
      return {
        ok: false,
        error: Object.freeze({
          code: "CANCELED",
          message: "Approval was requested after cancellation or deadline.",
          retryable: false,
        }),
      };
    }
    const configured = decisions[request.tool.id] ?? decisions[request.tool.modelName] ?? "deny";
    const decision: AiCoderApprovalDecision = Object.freeze({
      approved: configured === "allow",
      decidedAt: "1970-01-01T00:00:00.000Z",
      scope: "once",
      reason: configured === "allow"
        ? `Fixture explicitly approved ${request.tool.id}.`
        : `Fixture denied ${request.tool.id}; missing decisions fail closed.`,
    });
    return { ok: true, data: decision };
  };
}
