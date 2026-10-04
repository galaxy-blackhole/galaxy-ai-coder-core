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
  | "PERSISTENCE_ERROR"
  | "PROVIDER_ERROR"
  /** The provider rejected the credential (401/403): the host should point at its key setup. */
  | "PROVIDER_AUTHENTICATION"
  | "TOOL_EXECUTION"
  | "TOOL_TIMEOUT";

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
