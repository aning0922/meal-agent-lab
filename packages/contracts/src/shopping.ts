import { z } from "zod";

import {
  foodConceptIdSchema,
  householdIdSchema,
  inventoryLotIdSchema,
  mealIdSchema,
  nonEmptyQuantitySchema,
  shoppingItemIdSchema,
  userIdSchema,
  utcDateTimeSchema,
  versionSchema,
} from "./primitives.js";

export const shoppingItemSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("manual"),
    addedByUserId: userIdSchema,
  }),
  z.strictObject({
    kind: z.literal("meal"),
    mealId: mealIdSchema,
  }),
]);
export type ShoppingItemSource = z.infer<typeof shoppingItemSourceSchema>;

export const shoppingItemSchema = z
  .strictObject({
    id: shoppingItemIdSchema,
    householdId: householdIdSchema,
    foodConceptId: foodConceptIdSchema.optional(),
    displayName: z.string().min(1).max(120),
    requestedQuantity: nonEmptyQuantitySchema,
    purchasedQuantity: nonEmptyQuantitySchema.optional(),
    status: z.enum([
      "to_buy",
      "purchased_pending_inventory",
      "inventoried",
      "cancelled",
    ]),
    sources: z.array(shoppingItemSourceSchema).min(1),
    inventoryLotIds: z.array(inventoryLotIdSchema),
    lastChangedByUserId: userIdSchema,
    purchasedAt: utcDateTimeSchema.optional(),
    createdAt: utcDateTimeSchema,
    updatedAt: utcDateTimeSchema,
    version: versionSchema,
  })
  .superRefine((item, context) => {
    if (
      item.status === "inventoried" &&
      item.inventoryLotIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["inventoryLotIds"],
        message: "inventoried shopping items must reference created lots",
      });
    }

    if (
      item.status === "purchased_pending_inventory" &&
      item.inventoryLotIds.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["inventoryLotIds"],
        message:
          "purchased items cannot reference lots before inventory confirmation",
      });
    }
  });
export type ShoppingItem = z.infer<typeof shoppingItemSchema>;
