import { createHash, randomBytes } from "node:crypto";

import {
  cursorSchema,
  type Cursor,
} from "@meal-agent/contracts/api";
import {
  exactQuantityAmountSchema,
  quantityDecimalScale,
} from "@meal-agent/contracts";
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

export const toDatabaseQuantityDecimal = (value: string): string => {
  const parsed = exactQuantityAmountSchema.parse(value);
  const [whole, fraction = ""] = parsed.toString().split(".");
  if (
    whole === undefined ||
    fraction.length > quantityDecimalScale ||
    whole.includes("e")
  ) {
    throw new Error("validated quantity could not be formatted exactly");
  }
  return `${whole}.${fraction.padEnd(quantityDecimalScale, "0")}`;
};

export const toDatabaseApproximateQuantityDecimal = (
  value: number,
): string => {
  const [whole, fraction = ""] = String(value).split(".");
  if (
    whole === undefined ||
    fraction.length > quantityDecimalScale ||
    whole.includes("e")
  ) {
    throw new Error("approximate quantity could not be formatted");
  }
  return `${whole}.${fraction.padEnd(quantityDecimalScale, "0")}`;
};

export const issueSessionToken = (): string =>
  randomBytes(32).toString("base64url");

export const digestSessionToken = (token: string): string => sha256(token);

/**
 * 邀请码：24 随机字节 = 192 bit 熵，base64url 编码为 32 字符，远超
 * ≥128 bit 与契约 22–128 字符要求；只存 sha256 digest，明文仅返回一次。
 */
export const issueInviteCode = (): string =>
  randomBytes(24).toString("base64url");

export const digestInviteCode = (code: string): string => sha256(code);

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
