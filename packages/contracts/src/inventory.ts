import { z } from "zod";

import {
  foodConceptIdSchema,
  foodDateSchema,
  householdIdSchema,
  inventoryEventIdSchema,
  inventoryLotIdSchema,
  exactQuantityAmountSchema,
  positiveExactQuantityAmountSchema,
  persistableInitialQuantitySchema,
  quantityChangeSchema,
  quantitySchema,
  userIdSchema,
  utcDateTimeSchema,
  versionSchema,
} from "./primitives.js";
import { idempotencyKeySchema } from "./api.js";
import { ruleSuperRefine } from "./contract-rule-schema.js";

export const storageLocationSchema = z.enum([
  "pantry",
  "refrigerated",
  "frozen",
  "other",
]);
export type StorageLocation = z.infer<typeof storageLocationSchema>;

const addDuplicateDateKindIssues = (
  dates: readonly { kind: string }[],
  context: z.RefinementCtx,
) => {
  const seenKinds = new Set<string>();

  dates.forEach((date, index) => {
    if (seenKinds.has(date.kind)) {
      context.addIssue({
        code: "custom",
        path: [index, "kind"],
        message: `date kind ${date.kind} must be unique within a lot`,
      });
    }
    seenKinds.add(date.kind);
  });
};

export const inventoryLotSchema = ruleSuperRefine(
  z.strictObject({
    id: inventoryLotIdSchema,
    householdId: householdIdSchema,
    foodConceptId: foodConceptIdSchema.optional(),
    displayName: z.string().min(1).max(120),
    state: z.enum(["active", "depleted", "discarded"]),
    storageLocation: storageLocationSchema,
    currentQuantity: quantitySchema,
    dates: ruleSuperRefine(
      z.array(foodDateSchema).max(9),
      "inventory.lot.dates-unique.v1",
      "inventoryLotSchema.dates",
      addDuplicateDateKindIssues,
    ),
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
  }),
  "inventory.lot.state-quantity-safety.v1",
  "inventoryLotSchema",
  (lot, context) => {
    const isEmpty =
      (lot.currentQuantity.kind === "exact" &&
        lot.currentQuantity.amount === "0") ||
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

    if (
      lot.safetyAssessment.status === "blocked" &&
      lot.safetyAssessment.reasonCodes.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["safetyAssessment", "reasonCodes"],
        message: "blocked safety assessments require a reason code",
      });
    }
  },
);
export type InventoryLot = z.infer<typeof inventoryLotSchema>;

export const createInventoryLotDateInputSchema = ruleSuperRefine(
  z.strictObject({
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
  }),
  "inventory.create-date.provenance.v1",
  "createInventoryLotDateInputSchema",
  (date, context) => {
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
  },
);

export const createInventoryLotRequestSchema = z.strictObject({
  foodConceptId: foodConceptIdSchema.optional(),
  displayName: z.string().min(1).max(120),
  storageLocation: storageLocationSchema,
  initialQuantity: persistableInitialQuantitySchema,
  dates: ruleSuperRefine(
    z.array(createInventoryLotDateInputSchema).max(4),
    "inventory.create.dates-unique.v1",
    "createInventoryLotRequestSchema.dates",
    addDuplicateDateKindIssues,
  ),
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

export const inventoryEventSchema = ruleSuperRefine(
  z.strictObject({
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
  }),
  "inventory.event.consistency.v1",
  "inventoryEventSchema",
  (event, context) => {
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
      (event.quantityChange.precision === "exact"
        ? event.quantityChange.amount.startsWith("-")
        : event.quantityChange.amount <= 0)
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
      (event.quantityChange.precision === "exact"
        ? !event.quantityChange.amount.startsWith("-")
        : event.quantityChange.amount >= 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["quantityChange", "amount"],
        message: `${event.type} requires a negative quantity delta`,
      });
    }

    if (
      ["moved", "frozen", "thawed"].includes(event.type) &&
      (event.fromStorageLocation === undefined ||
        event.toStorageLocation === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["fromStorageLocation"],
        message: `${event.type} requires source and destination storage locations`,
      });
    }

    if (
      !["moved", "frozen", "thawed"].includes(event.type) &&
      (event.fromStorageLocation !== undefined ||
        event.toStorageLocation !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["fromStorageLocation"],
        message: `${event.type} cannot carry a storage transition`,
      });
    }

    if (
      event.type === "frozen" &&
      event.toStorageLocation !== undefined &&
      event.toStorageLocation !== "frozen"
    ) {
      context.addIssue({
        code: "custom",
        path: ["toStorageLocation"],
        message: "frozen events must move the lot to frozen storage",
      });
    }

    if (
      event.type === "thawed" &&
      ((event.fromStorageLocation !== undefined &&
        event.fromStorageLocation !== "frozen") ||
        event.toStorageLocation === "frozen")
    ) {
      context.addIssue({
        code: "custom",
        path: ["toStorageLocation"],
        message: "thawed events must move a frozen lot out of frozen storage",
      });
    }

    if (
      event.fromStorageLocation !== undefined &&
      event.fromStorageLocation === event.toStorageLocation
    ) {
      context.addIssue({
        code: "custom",
        path: ["toStorageLocation"],
        message: "storage transitions must change the location",
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

    if (
      event.type !== "corrected" &&
      event.correctionOfEventId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["correctionOfEventId"],
        message: "only corrected events may reference an original event",
      });
    }

    if (
      event.correctionOfEventId !== undefined &&
      event.correctionOfEventId === event.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["correctionOfEventId"],
        message: "an inventory event cannot correct itself",
      });
    }

    if (
      event.quantityChange?.kind === "qualitative" &&
      event.quantityChange.fromLevel === event.quantityChange.toLevel
    ) {
      context.addIssue({
        code: "custom",
        path: ["quantityChange", "toLevel"],
        message: "qualitative quantity changes must change the level",
      });
    }

    if (
      event.quantityChange?.kind === "qualitative" &&
      ["acquired", "produced"].includes(event.type) &&
      event.quantityChange.toLevel === "empty"
    ) {
      context.addIssue({
        code: "custom",
        path: ["quantityChange", "toLevel"],
        message: `${event.type} cannot result in an empty quantity`,
      });
    }

    if (event.quantityChange?.kind === "qualitative") {
      const quantityRank = {
        empty: 0,
        low: 1,
        some: 2,
        plenty: 3,
      } as const;
      const { fromLevel, toLevel } = event.quantityChange;

      if (
        fromLevel !== "unknown" &&
        toLevel !== "unknown" &&
        ["acquired", "produced"].includes(event.type) &&
        quantityRank[toLevel] <= quantityRank[fromLevel]
      ) {
        context.addIssue({
          code: "custom",
          path: ["quantityChange", "toLevel"],
          message: `${event.type} must increase a known qualitative quantity`,
        });
      }

      if (
        fromLevel !== "unknown" &&
        toLevel !== "unknown" &&
        ["consumed", "discarded"].includes(event.type) &&
        quantityRank[toLevel] >= quantityRank[fromLevel]
      ) {
        context.addIssue({
          code: "custom",
          path: ["quantityChange", "toLevel"],
          message: `${event.type} must decrease a known qualitative quantity`,
        });
      }
    }

    if (
      event.quantityChange?.kind === "qualitative" &&
      event.type === "discarded" &&
      event.quantityChange.toLevel !== "empty"
    ) {
      context.addIssue({
        code: "custom",
        path: ["quantityChange", "toLevel"],
        message: "discarded events must result in an empty quantity",
      });
    }

    if (event.resultingLotVersion !== event.expectedLotVersion + 1) {
      context.addIssue({
        code: "custom",
        path: ["resultingLotVersion"],
        message: "resulting lot version must increment by one",
      });
    }
  },
);
export type InventoryEvent = z.infer<typeof inventoryEventSchema>;

const addLotEventConsistencyIssues = (
  result: { lot: InventoryLot; event: InventoryEvent },
  context: z.RefinementCtx,
) => {
  if (result.lot.householdId !== result.event.householdId) {
    context.addIssue({
      code: "custom",
      path: ["event", "householdId"],
      message: "lot and event must belong to the same household",
    });
  }

  if (result.lot.id !== result.event.inventoryLotId) {
    context.addIssue({
      code: "custom",
      path: ["event", "inventoryLotId"],
      message: "event must belong to the returned inventory lot",
    });
  }

  if (result.lot.version !== result.event.resultingLotVersion) {
    context.addIssue({
      code: "custom",
      path: ["lot", "version"],
      message: "lot version must equal the event resulting version",
    });
  }
};

const addInitialQuantityRebuildIssues = (
  result: { lot: InventoryLot; event: InventoryEvent },
  context: z.RefinementCtx,
) => {
  const quantity = result.lot.currentQuantity;
  const change = result.event.quantityChange;
  let canRebuild = false;

  if (quantity.kind === "exact") {
    canRebuild =
      change?.kind === "numeric" &&
      change.precision === "exact" &&
      change.amount === quantity.amount &&
      change.unit === quantity.unit &&
      change.originalText === quantity.originalText;
  }

  if (quantity.kind === "approximate") {
    canRebuild =
      quantity.amount !== undefined &&
      quantity.unit !== undefined &&
      change?.kind === "numeric" &&
      change.precision === "estimated" &&
      change.confidence === quantity.confidence &&
      change.amount === quantity.amount &&
      change.unit === quantity.unit &&
      change.originalText === quantity.originalText;
  }

  if (quantity.kind === "qualitative") {
    canRebuild =
      change?.kind === "qualitative" &&
      change.fromLevel === "empty" &&
      change.toLevel === quantity.level &&
      change.originalText === quantity.originalText;
  }

  if (!canRebuild) {
    context.addIssue({
      code: "custom",
      path: ["event", "quantityChange"],
      message:
        "initial event quantity must canonically rebuild the returned lot quantity",
    });
  }
};

export const createInventoryLotResultSchema = ruleSuperRefine(
  z.strictObject({
    lot: inventoryLotSchema,
    event: inventoryEventSchema,
  }),
  "inventory.create-result.consistency.v1",
  "createInventoryLotResultSchema",
  (result, context) => {
    addLotEventConsistencyIssues(result, context);
    addInitialQuantityRebuildIssues(result, context);

    if (result.lot.origin !== "manual" || result.lot.state !== "active") {
      context.addIssue({
        code: "custom",
        path: ["lot"],
        message: "a manually created lot must start active with manual origin",
      });
    }

    if (
      result.event.type !== "acquired" ||
      result.event.source !== "manual_confirmation"
    ) {
      context.addIssue({
        code: "custom",
        path: ["event", "type"],
        message:
          "a manually created lot requires an acquired manual-confirmation event",
      });
    }

    if (
      result.event.expectedLotVersion !== 0 ||
      result.event.resultingLotVersion !== 1 ||
      result.lot.version !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["lot", "version"],
        message:
          "a new lot uses expected version 0 and atomically publishes event and projection version 1",
      });
    }

    if (result.lot.createdByUserId !== result.event.actorUserId) {
      context.addIssue({
        code: "custom",
        path: ["event", "actorUserId"],
        message: "initial event actor must be the lot creator",
      });
    }
  },
);
export type CreateInventoryLotResult = z.infer<
  typeof createInventoryLotResultSchema
>;

export const consumeInventoryLotRequestSchema = z.strictObject({
  consumedQuantity: z.strictObject({
    kind: z.literal("exact"),
    amount: positiveExactQuantityAmountSchema,
    unit: z.string().min(1).max(32),
    originalText: z.string().min(1).max(200).optional(),
  }),
  expectedVersion: versionSchema,
  note: z.string().max(500).optional(),
});
export type ConsumeInventoryLotRequest = z.infer<
  typeof consumeInventoryLotRequestSchema
>;

export const consumeInventoryLotResultSchema = ruleSuperRefine(
  z.strictObject({
    lot: inventoryLotSchema,
    event: inventoryEventSchema,
  }),
  "inventory.consume-result.consistency.v1",
  "consumeInventoryLotResultSchema",
  (result, context) => {
    addLotEventConsistencyIssues(result, context);

    if (
      result.event.type !== "consumed" ||
      result.event.quantityChange?.kind !== "numeric" ||
      result.event.quantityChange.precision !== "exact"
    ) {
      context.addIssue({
        code: "custom",
        path: ["event", "type"],
        message: "consume command requires an exact numeric consumed event",
      });
    }

    if (result.lot.currentQuantity.kind !== "exact") {
      context.addIssue({
        code: "custom",
        path: ["lot", "currentQuantity", "kind"],
        message: "consume command must return an exact lot quantity",
      });
    }

    if (
      result.lot.currentQuantity.kind === "exact" &&
      result.event.quantityChange?.kind === "numeric" &&
      result.event.quantityChange.unit !==
        result.lot.currentQuantity.unit
    ) {
      context.addIssue({
        code: "custom",
        path: ["event", "quantityChange", "unit"],
        message:
          "consumed event unit must match the returned exact lot quantity unit",
      });
    }

    if (result.event.source !== "manual_confirmation") {
      context.addIssue({
        code: "custom",
        path: ["event", "source"],
        message:
          "consume command requires a manual-confirmation event source",
      });
    }

    if (result.lot.state === "discarded") {
      context.addIssue({
        code: "custom",
        path: ["lot", "state"],
        message: "a consumed event cannot produce a discarded lot",
      });
    }
  },
);
export type ConsumeInventoryLotResult = z.infer<
  typeof consumeInventoryLotResultSchema
>;
