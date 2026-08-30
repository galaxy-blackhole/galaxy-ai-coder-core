/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-21
 * @desc Discriminated result envelope used by every host port response.
 */

export type PortErrorCode =
  | "ALREADY_EXISTS"
  | "APPROVAL_DENIED"
  | "APPROVAL_UNAVAILABLE"
  | "CANCELED"
  | "CAPABILITY_MISMATCH"
  | "CONFLICT"
  | "DEADLINE_EXCEEDED"
  | "INTERNAL"
  | "INVALID_INPUT"
  | "IO_ERROR"
  | "LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "PRECONDITION_FAILED"
  | "PROVIDER_ERROR"
  | "UNAVAILABLE"
  | "UNSUPPORTED";

export type PortError<TDetails = unknown> = Readonly<{
  code: PortErrorCode;
  details?: TDetails;
  message: string;
  retryable: boolean;
  suggestedAction?: string;
}>;

export type PortSuccess<T> = Readonly<{
  data: T;
  ok: true;
}>;

export type PortFailure<TDetails = unknown> = Readonly<{
  error: PortError<TDetails>;
  ok: false;
}>;

export type PortResult<T, TDetails = unknown> =
  | PortSuccess<T>
  | PortFailure<TDetails>;

export function portSuccess<T>(data: T): PortSuccess<T> {
  return Object.freeze({ ok: true, data });
}

export function portFailure<TDetails = unknown>(
  error: PortError<TDetails>,
): PortFailure<TDetails> {
  return Object.freeze({ ok: false, error: Object.freeze({ ...error }) });
}

export function isPortSuccess<T, TDetails>(
  result: PortResult<T, TDetails>,
): result is PortSuccess<T> {
  return result.ok;
}

export function isPortFailure<T, TDetails>(
  result: PortResult<T, TDetails>,
): result is PortFailure<TDetails> {
  return !result.ok;
}
