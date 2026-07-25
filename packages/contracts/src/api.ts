import { z } from "zod";

import { ruleSuperRefine } from "./contract-rule-schema.js";
import {
  requestIdSchema,
  utcDateTimeSchema,
} from "./primitives.js";

export const apiErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "URI_TOO_LONG",
  "AUTHENTICATION_REQUIRED",
  "SESSION_EXPIRED",
  "FORBIDDEN",
  "RESOURCE_NOT_FOUND",
  "CONFLICT",
  "PERSON_PROFILE_ARCHIVED",
  "PRECONDITION_FAILED",
  "IDEMPOTENCY_KEY_REUSED",
  "INVENTORY_VERSION_CONFLICT",
  "INVENTORY_INSUFFICIENT",
  "SAFETY_BLOCKED",
  "RATE_LIMITED",
  "EXTERNAL_DEPENDENCY_UNAVAILABLE",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorStatus = {
  VALIDATION_FAILED: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  URI_TOO_LONG: 414,
  AUTHENTICATION_REQUIRED: 401,
  SESSION_EXPIRED: 401,
  FORBIDDEN: 403,
  RESOURCE_NOT_FOUND: 404,
  CONFLICT: 409,
  PERSON_PROFILE_ARCHIVED: 409,
  PRECONDITION_FAILED: 412,
  IDEMPOTENCY_KEY_REUSED: 409,
  INVENTORY_VERSION_CONFLICT: 409,
  INVENTORY_INSUFFICIENT: 409,
  SAFETY_BLOCKED: 422,
  RATE_LIMITED: 429,
  EXTERNAL_DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const satisfies Readonly<Record<ApiErrorCode, number>>;

export const fieldErrorSchema = z.strictObject({
  path: z.array(z.union([z.string(), z.int().nonnegative()])),
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(500),
});
export type FieldError = z.infer<typeof fieldErrorSchema>;

export const apiErrorSchema = ruleSuperRefine(
  z.strictObject({
    ok: z.literal(false),
    type: z.url(),
    title: z.string().min(1).max(200),
    status: z.int().min(400).max(599),
    code: apiErrorCodeSchema,
    detail: z.string().min(1).max(1000).optional(),
    instance: z.string().min(1).max(500).optional(),
    requestId: requestIdSchema,
    retryable: z.boolean(),
    fieldErrors: z.array(fieldErrorSchema).optional(),
  }),
  "api.problem.status-code-consistency.v1",
  "apiErrorSchema",
  (error, context) => {
    if (apiErrorStatus[error.code] !== error.status) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `status must match the stable mapping for ${error.code}`,
      });
    }
  },
);
export type ApiError = z.infer<typeof apiErrorSchema>;

export const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .brand<"IdempotencyKey">();
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

export const idempotencyHeaderName = "Idempotency-Key" as const;

export const idempotencyScopeSchema = z.enum(["user", "household"]);
export type IdempotencyScope = z.infer<typeof idempotencyScopeSchema>;

export const idempotencyMetadataSchema = z.strictObject({
  key: idempotencyKeySchema,
  scope: idempotencyScopeSchema,
  replayed: z.boolean(),
  firstProcessedAt: utcDateTimeSchema,
  originalRequestId: requestIdSchema,
});
export type IdempotencyMetadata = z.infer<
  typeof idempotencyMetadataSchema
>;

export const apiMetaSchema = z.strictObject({
  requestId: requestIdSchema,
  idempotency: idempotencyMetadataSchema.optional(),
});
export type ApiMeta = z.infer<typeof apiMetaSchema>;

export const createApiSuccessSchema = <T extends z.ZodType>(
  dataSchema: T,
) =>
  z.strictObject({
    ok: z.literal(true),
    data: dataSchema,
    meta: apiMetaSchema,
  });

export const createApiResultSchema = <T extends z.ZodType>(
  dataSchema: T,
) => z.union([createApiSuccessSchema(dataSchema), apiErrorSchema]);

export type ApiSuccess<T> = z.output<
  ReturnType<typeof createApiSuccessSchema<z.ZodType<T>>>
>;

export type ApiResult<T> = z.output<
  ReturnType<typeof createApiResultSchema<z.ZodType<T>>>
>;

export const cursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<"Cursor">();
export type Cursor = z.infer<typeof cursorSchema>;

export const pageInfoSchema = z.discriminatedUnion("hasMore", [
  z.strictObject({
    nextCursor: cursorSchema,
    hasMore: z.literal(true),
  }),
  z.strictObject({
    nextCursor: z.null(),
    hasMore: z.literal(false),
  }),
]);
export type PageInfo = z.infer<typeof pageInfoSchema>;

export const createPaginatedDataSchema = <T extends z.ZodType>(
  itemSchema: T,
) =>
  z.strictObject({
    items: z.array(itemSchema),
    pageInfo: pageInfoSchema,
  });

export type PaginatedData<T> = z.output<
  ReturnType<typeof createPaginatedDataSchema<z.ZodType<T>>>
>;

export const expectedVersionSchema = z.strictObject({
  expectedVersion: z.int().nonnegative(),
});
export type ExpectedVersion = z.infer<typeof expectedVersionSchema>;
