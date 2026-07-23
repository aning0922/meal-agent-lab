import { z } from "zod";

import {
  foodConceptIdSchema,
  foodDateSchema,
  householdIdSchema,
  inventoryEventIdSchema,
  inventoryLotIdSchema,
  nonEmptyQuantitySchema,
  quantityChangeSchema,
  quantitySchema,
  userIdSchema,
  utcDateTimeSchema,
  versionSchema,
} from "./primitives.js";
import { idempotencyKeySchema } from "./api.js";

export const storageLocationSchema = z.enum([
  "pantry",
  "refrigerated",
  "frozen",
  "other",
]);
export type StorageLocation = z.infer<typeof storageLocationSchema>;

export const inventoryLotSchema = z
  .strictObject({
    id: inventoryLotIdSchema,
    householdId: householdIdSchema,
    foodConceptId: foodConceptIdSchema.optional(),
    displayName: z.string().min(1).max(120),
    state: z.enum(["active", "depleted", "discarded"]),
    storageLocation: storageLocationSchema,
    currentQuantity: quantitySchema,
    dates: z.array(foodDateSchema),
    safetyAssessment: z.strictObject({
      status: z.enum(["eligible", "blocked", "unknown"]),
      reasonCodes: z.array(z.string().min(1).max(80)),
      policyVersion: z.string().min(1).max(100),
      evaluatedAt: utcDateTimeSchema,
    }),
    origin: z.enum([
      "manual",
      "shopping_confirmation",
      "leftover",
      "confirmed_import",
    ]),
    createdByUserId: userIdSchema,
    createdAt: utcDateTimeSchema,
    updatedAt: utcDateTimeSchema,
    version: versionSchema,
  })
  .superRefine((lot, context) => {
    const isEmpty =
      (lot.currentQuantity.kind === "exact" &&
        lot.currentQuantity.amount === 0) ||
      (lot.currentQuantity.kind === "qualitative" &&
        lot.currentQuantity.level === "empty");

    if (lot.state === "active" && isEmpty) {
      context.addIssue({
        code: "custom",
        path: ["currentQuantity"],
        message: "active lots cannot have an empty quantity",
      });
    }

    if (lot.state !== "active" && !isEmpty) {
      context.addIssue({
        code: "custom",
        path: ["currentQuantity"],
        message: "depleted or discarded lots require an empty quantity",
      });
    }
  });
export type InventoryLot = z.infer<typeof inventoryLotSchema>;

const createInventoryLotDateInputSchema = z
  .strictObject({
    kind: z.enum([
      "purchase_date",
      "production_date",
      "best_before_date",
      "use_by_date",
    ]),
    value: z.iso.date(),
    source: z.strictObject({
      kind: z.enum([
        "package_label",
        "user_input",
        "confirmed_recognition",
      ]),
      confidence: z.enum(["high", "medium", "low"]),
      reference: z.string().min(1).max(500).optional(),
    }),
  })
  .superRefine((date, context) => {
    if (
      date.kind === "purchase_date" &&
      date.source.kind === "package_label"
    ) {
      context.addIssue({
        code: "custom",
        path: ["source", "kind"],
        message: "a package label cannot establish a purchase date",
      });
    }
  });

export const createInventoryLotRequestSchema = z.strictObject({
  foodConceptId: foodConceptIdSchema.optional(),
  displayName: z.string().min(1).max(120),
  storageLocation: storageLocationSchema,
  initialQuantity: nonEmptyQuantitySchema,
  dates: z.array(createInventoryLotDateInputSchema),
});
export type CreateInventoryLotRequest = z.infer<
  typeof createInventoryLotRequestSchema
>;

export const inventoryEventTypeSchema = z.enum([
  "acquired",
  "produced",
  "opened",
  "consumed",
  "discarded",
  "moved",
  "frozen",
  "thawed",
  "adjusted",
  "corrected",
]);
export type InventoryEventType = z.infer<typeof inventoryEventTypeSchema>;

export const inventoryEventSchema = z
  .strictObject({
    id: inventoryEventIdSchema,
    householdId: householdIdSchema,
    inventoryLotId: inventoryLotIdSchema,
    type: inventoryEventTypeSchema,
    quantityChange: quantityChangeSchema.optional(),
    fromStorageLocation: storageLocationSchema.optional(),
    toStorageLocation: storageLocationSchema.optional(),
    correctionOfEventId: inventoryEventIdSchema.optional(),
    actorUserId: userIdSchema,
    source: z.enum([
      "manual_confirmation",
      "shopping_confirmation",
      "meal_completion_confirmation",
      "confirmed_recognition",
      "administrative_recovery",
    ]),
    occurredAt: utcDateTimeSchema,
    recordedAt: utcDateTimeSchema,
    idempotencyKey: idempotencyKeySchema,
    expectedLotVersion: versionSchema,
    resultingLotVersion: z.int().positive(),
    note: z.string().max(500).optional(),
  })
  .superRefine((event, context) => {
    const positiveEvents = new Set(["acquired", "produced"]);
    const negativeEvents = new Set(["consumed", "discarded"]);
    const quantityEvents = new Set([
      ...positiveEvents,
      ...negativeEvents,
      "adjusted",
      "corrected",
    ]);

    if (
      quantityEvents.has(event.type) &&
      event.quantityChange === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["quantityChange"],
        message: `${event.type} requires a quantity change`,
      });
    }

    if (
      !quantityEvents.has(event.type) &&
      event.quantityChange !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["quantityChange"],
        message: `${event.type} cannot carry a quantity change`,
      });
    }

    if (
      event.quantityChange?.kind === "numeric" &&
      positiveEvents.has(event.type) &&
      event.quantityChange.amount <= 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["quantityChange", "amount"],
        message: `${event.type} requires a positive quantity delta`,
      });
    }

    if (
      event.quantityChange?.kind === "numeric" &&
      negativeEvents.has(event.type) &&
      event.quantityChange.amount >= 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["quantityChange", "amount"],
        message: `${event.type} requires a negative quantity delta`,
      });
    }

    if (
      ["moved", "frozen", "thawed"].includes(event.type) &&
      event.toStorageLocation === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["toStorageLocation"],
        message: `${event.type} requires a destination storage location`,
      });
    }

    if (
      event.type === "corrected" &&
      event.correctionOfEventId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["correctionOfEventId"],
        message: "corrected events must reference the original event",
      });
    }

    if (event.resultingLotVersion !== event.expectedLotVersion + 1) {
      context.addIssue({
        code: "custom",
        path: ["resultingLotVersion"],
        message: "resulting lot version must increment by one",
      });
    }
  });
export type InventoryEvent = z.infer<typeof inventoryEventSchema>;

export const createInventoryLotResultSchema = z.strictObject({
  lot: inventoryLotSchema,
  event: inventoryEventSchema,
});
export type CreateInventoryLotResult = z.infer<
  typeof createInventoryLotResultSchema
>;
