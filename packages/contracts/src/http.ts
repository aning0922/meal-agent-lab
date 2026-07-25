import { z } from "zod";

import {
  apiErrorSchema,
  createApiSuccessSchema,
  createPaginatedDataSchema,
} from "./api.js";
import {
  authenticatedSessionSchema,
  createHouseholdResultSchema,
  householdSchema,
  userSchema,
} from "./identity.js";
import {
  consumeInventoryLotResultSchema,
  createInventoryLotResultSchema,
  inventoryLotSchema,
} from "./inventory.js";
import {
  confirmPersonProfileLinkResultSchema,
  createHouseholdInviteResultSchema,
  getPersonProfileResultSchema,
  householdInviteSchema,
  joinHouseholdResultSchema,
  listPersonProfilesResultSchema,
  listHouseholdMembersResultSchema,
  personProfileMutationReceiptSchema,
  personProfileLinkRequestListResultSchema,
  personProfileLinkRequestResultSchema,
  personProfileResultSchema,
  removeMembershipResultSchema,
  revokeHouseholdInviteResultSchema,
} from "./members.js";

export const serviceLivenessSchema = z.strictObject({
  status: z.literal("ok"),
});
export type ServiceLiveness = z.infer<typeof serviceLivenessSchema>;

export const serviceReadinessSchema = z.strictObject({
  status: z.literal("ready"),
  database: z.literal("ready"),
  migrations: z.literal("ready"),
});
export type ServiceReadiness = z.infer<typeof serviceReadinessSchema>;

export const sessionRevokedResultSchema = z.strictObject({
  revoked: z.literal(true),
});
export type SessionRevokedResult = z.infer<
  typeof sessionRevokedResultSchema
>;

export const meResultSchema = z.strictObject({
  user: userSchema,
  households: z.array(householdSchema),
});
export type MeResult = z.infer<typeof meResultSchema>;

export const householdPageSchema =
  createPaginatedDataSchema(householdSchema);
export type HouseholdPage = z.infer<typeof householdPageSchema>;

export const inventoryLotPageSchema =
  createPaginatedDataSchema(inventoryLotSchema);
export type InventoryLotPage = z.infer<typeof inventoryLotPageSchema>;

export const householdInvitePageSchema = createPaginatedDataSchema(
  householdInviteSchema,
);
export type HouseholdInvitePage = z.infer<
  typeof householdInvitePageSchema
>;

export const serviceLivenessSuccessSchema =
  createApiSuccessSchema(serviceLivenessSchema);
export const serviceReadinessSuccessSchema =
  createApiSuccessSchema(serviceReadinessSchema);
export const wechatLoginExchangeSuccessSchema =
  createApiSuccessSchema(authenticatedSessionSchema);
export const sessionRevokedSuccessSchema =
  createApiSuccessSchema(sessionRevokedResultSchema);
export const meSuccessSchema = createApiSuccessSchema(meResultSchema);
export const createHouseholdSuccessSchema =
  createApiSuccessSchema(createHouseholdResultSchema);
export const householdPageSuccessSchema =
  createApiSuccessSchema(householdPageSchema);
export const inventoryLotPageSuccessSchema =
  createApiSuccessSchema(inventoryLotPageSchema);
export const createInventoryLotSuccessSchema =
  createApiSuccessSchema(createInventoryLotResultSchema);
export const consumeInventoryLotSuccessSchema =
  createApiSuccessSchema(consumeInventoryLotResultSchema);

export const createHouseholdInviteSuccessSchema = createApiSuccessSchema(
  createHouseholdInviteResultSchema,
);
export const householdInvitePageSuccessSchema = createApiSuccessSchema(
  householdInvitePageSchema,
);
export const revokeHouseholdInviteSuccessSchema = createApiSuccessSchema(
  revokeHouseholdInviteResultSchema,
);
export const joinHouseholdSuccessSchema = createApiSuccessSchema(
  joinHouseholdResultSchema,
);
export const listHouseholdMembersSuccessSchema = createApiSuccessSchema(
  listHouseholdMembersResultSchema,
);
export const removeMembershipSuccessSchema = createApiSuccessSchema(
  removeMembershipResultSchema,
);
export const personProfileSuccessSchema = createApiSuccessSchema(
  personProfileResultSchema,
);
export const personProfileMutationSuccessSchema = createApiSuccessSchema(
  personProfileMutationReceiptSchema,
);
export const listPersonProfilesSuccessSchema = createApiSuccessSchema(
  listPersonProfilesResultSchema,
);
export const getPersonProfileSuccessSchema = createApiSuccessSchema(
  getPersonProfileResultSchema,
);
export const personProfileLinkRequestSuccessSchema = createApiSuccessSchema(
  personProfileLinkRequestResultSchema,
);
export const personProfileLinkRequestListSuccessSchema =
  createApiSuccessSchema(personProfileLinkRequestListResultSchema);
export const confirmPersonProfileLinkSuccessSchema = createApiSuccessSchema(
  confirmPersonProfileLinkResultSchema,
);

export const stage06ErrorResponseSchema = apiErrorSchema;
