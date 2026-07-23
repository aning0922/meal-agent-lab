import test from "node:test";

import {
  householdIdSchema,
  requestIdSchema,
  type HouseholdId,
  type UserId,
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

test("entity IDs retain nominal types after schema parsing", () => {
  const uuidV4 = "123e4567-e89b-42d3-a456-426614174000";

  if (userIdSchema.safeParse(uuidV4).success) {
    throw new Error("entity IDs must enforce UUIDv7");
  }
  requestIdSchema.parse(uuidV4);

  void checkedUserId;
  void checkedHouseholdId;
  void wrongUserId;
});
