import { z } from "zod";

import { ruleSuperRefine } from "./contract-rule-schema.js";
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

export const shoppingItemSchema = ruleSuperRefine(
  z.strictObject({
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
  }),
  "shopping.item.lifecycle.v1",
  "shoppingItemSchema",
  (item, context) => {
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

    if (
      item.status !== "inventoried" &&
      item.status !== "purchased_pending_inventory" &&
      item.inventoryLotIds.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["inventoryLotIds"],
        message: "only inventoried shopping items may reference inventory lots",
      });
    }

    if (
      ["purchased_pending_inventory", "inventoried"].includes(item.status) &&
      item.purchasedAt === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["purchasedAt"],
        message: `${item.status} requires purchasedAt`,
      });
    }

    if (
      ["to_buy", "cancelled"].includes(item.status) &&
      (item.purchasedAt !== undefined ||
        item.purchasedQuantity !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["purchasedAt"],
        message: `${item.status} cannot contain purchase confirmation`,
      });
    }
  },
);
export type ShoppingItem = z.infer<typeof shoppingItemSchema>;
