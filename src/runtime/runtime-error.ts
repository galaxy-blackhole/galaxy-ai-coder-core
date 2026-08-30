export type AiCoderRuntimeErrorCode =
  | "CANCELED"
  | "CAPABILITY_MISMATCH"
  | "CHECKPOINT_INCOMPATIBLE"
  | "CONTEXT_BUDGET"
  | "DEADLINE_EXCEEDED"
  | "INVALID_MODEL_STREAM"
  | "MAX_TOOL_CALLS"
  | "MAX_TURNS"
  | "NO_PROGRESS"
  | "PAUSED"
  | "PROVIDER_ERROR"
  | "TOOL_EXECUTION";

export class AiCoderRuntimeError extends Error {
  constructor(
    readonly code: AiCoderRuntimeErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AiCoderRuntimeError";
  }
}
