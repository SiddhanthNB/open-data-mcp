export const ERROR_MESSAGES = {
  INVALID_SOURCE: "The requested source is not supported.",
  SOURCE_DISABLED: "The requested source is disabled.",
  INVALID_REQUEST: "The request is invalid.",
  DATASET_NOT_FOUND: "The requested dataset could not be found.",
  RESOURCE_NOT_FOUND: "The requested resource could not be found.",
  UNSUPPORTED_OPERATION: "The requested operation is not supported by this source.",
  UNSUPPORTED_FORMAT: "The requested resource format is not supported.",
  RESOURCE_TOO_LARGE: "The requested resource exceeds the configured size limit.",
  UPSTREAM_ERROR: "The upstream provider returned an error.",
  UPSTREAM_TIMEOUT: "The upstream provider timed out.",
  RATE_LIMITED: "The upstream provider rate limit was exceeded.",
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: ErrorCode,
    message: string = ERROR_MESSAGES[code],
    details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details =
      details ??
      (code === "RATE_LIMITED" ? { retry_after_seconds: 60 } : undefined);
  }

  toJSON(): {
    error: ErrorCode;
    message: string;
    [key: string]: string | number | boolean;
  } {
    return { error: this.code, message: this.message, ...this.details };
  }
}
