import {
  apiErrorSchema,
  apiErrorStatus,
  type ApiError,
  type ApiErrorCode,
  type FieldError,
} from "@meal-agent/contracts/api";

export class AppError extends Error {
  public readonly code: ApiErrorCode;
  public readonly retryable: boolean;
  public readonly fieldErrors: readonly FieldError[] | undefined;

  public constructor(
    code: ApiErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly fieldErrors?: readonly FieldError[];
    } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.fieldErrors = options.fieldErrors;
  }

  public get status(): number {
    return apiErrorStatus[this.code];
  }
}

const titleByCode = {
  VALIDATION_FAILED: "Request validation failed",
  AUTHENTICATION_REQUIRED: "Authentication required",
  SESSION_EXPIRED: "Session expired",
  FORBIDDEN: "Forbidden",
  RESOURCE_NOT_FOUND: "Resource not found",
  CONFLICT: "Conflict",
  PRECONDITION_FAILED: "Precondition failed",
  IDEMPOTENCY_KEY_REUSED: "Idempotency key reused",
  INVENTORY_VERSION_CONFLICT: "Inventory version conflict",
  INVENTORY_INSUFFICIENT: "Insufficient inventory",
  SAFETY_BLOCKED: "Safety rule blocked the request",
  RATE_LIMITED: "Rate limited",
  EXTERNAL_DEPENDENCY_UNAVAILABLE: "External dependency unavailable",
  INTERNAL_ERROR: "Internal server error",
} as const satisfies Readonly<Record<ApiErrorCode, string>>;

export const problemFromError = (
  error: AppError,
  requestId: string,
  instance: string,
): ApiError =>
  apiErrorSchema.parse({
    ok: false,
    type: `https://meal-agent.invalid/problems/${error.code.toLowerCase()}`,
    title: titleByCode[error.code],
    status: error.status,
    code: error.code,
    detail: error.message,
    instance,
    requestId,
    retryable: error.retryable,
    ...(error.fieldErrors === undefined
      ? {}
      : { fieldErrors: error.fieldErrors }),
  });
