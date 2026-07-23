import { createHash, randomBytes } from "node:crypto";

import {
  cursorSchema,
  type Cursor,
} from "@meal-agent/contracts/api";
import { v7 as uuidv7 } from "uuid";

const sortForCanonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortForCanonicalJson(item)]),
    );
  }
  return value;
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(sortForCanonicalJson(value));

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const requestHash = (value: unknown): string =>
  sha256(canonicalJson(value));

export const issueSessionToken = (): string =>
  randomBytes(32).toString("base64url");

export const digestSessionToken = (token: string): string => sha256(token);

export const newEntityId = (): string => uuidv7();

export const toIsoString = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export const encodeCursor = (id: string): Cursor =>
  cursorSchema.parse(Buffer.from(id, "utf8").toString("base64url"));

export const decodeCursor = (cursor: string): string => {
  try {
    return Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new Error("invalid cursor");
  }
};
