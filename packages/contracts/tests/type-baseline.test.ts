import test from "node:test";

import {
  createApiResultSchema,
  createApiSuccessSchema,
  createPaginatedDataSchema,
  householdIdSchema,
  requestIdSchema,
  type ApiResult,
  type ApiSuccess,
  type HouseholdId,
  type PaginatedData,
  type User,
  type UserId,
  userSchema,
  userIdSchema,
} from "../src/index.js";

const userId = userIdSchema.parse(
  "018f0000-0000-7000-8000-000000000001",
);
const householdId = householdIdSchema.parse(
  "018f0000-0000-7000-8000-000000000002",
);

const checkedUserId: UserId = userId;
const checkedHouseholdId: HouseholdId = householdId;

// @ts-expect-error IDs are opaque and cannot be assigned across entity types.
const wrongUserId: UserId = householdId;

const parsedUser = userSchema.parse({
  id: userId,
  status: "active",
  locale: "zh-CN",
  createdAt: "2026-07-23T12:00:00Z",
  updatedAt: "2026-07-23T12:00:00Z",
  version: 0,
});
const paginatedUserSchema = createPaginatedDataSchema(userSchema);
const parsedPage = paginatedUserSchema.parse({
  items: [parsedUser],
  pageInfo: { nextCursor: null, hasMore: false },
});
const typedPage: PaginatedData<User> = parsedPage;
const parsedSuccess = createApiSuccessSchema(paginatedUserSchema).parse({
  ok: true,
  data: parsedPage,
  meta: { requestId: "123e4567-e89b-42d3-a456-426614174000" },
});
const typedSuccess: ApiSuccess<PaginatedData<User>> = parsedSuccess;
const parsedResult = createApiResultSchema(userSchema).parse({
  ok: true,
  data: parsedUser,
  meta: { requestId: "123e4567-e89b-42d3-a456-426614174000" },
});
const typedResult: ApiResult<User> = parsedResult;

test("entity IDs retain nominal types after schema parsing", () => {
  const uuidV4 = "123e4567-e89b-42d3-a456-426614174000";

  if (userIdSchema.safeParse(uuidV4).success) {
    throw new Error("entity IDs must enforce UUIDv7");
  }
  requestIdSchema.parse(uuidV4);

  void checkedUserId;
  void checkedHouseholdId;
  void wrongUserId;
  void typedPage;
  void typedSuccess;
  void typedResult;
});
