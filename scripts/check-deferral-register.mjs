#!/usr/bin/env node
/**
 * Stage 09P **递延项登记表门禁**——把「每一笔延期」钉成一张**必填六字段**的登记。
 *
 * 为什么有这一份：09P 设计门禁的停止谓词此前**无界**——「评审剩余发现数为零」这个量
 * 由过程自己不断再生，且修订协议只补被点名的那一处、不回读同一主张的兄弟句，于是每修
 * 一处就制造下一轮。M5 累积 17 份计划、12+ 轮；M1 599 份审计报告里留下 460 份。收敛的
 * 第一步，是把「暂时不做」从散落在计划/证据/开放问题里的**散文**，变成一份**可机读、
 * 缺字段即转红**的登记：任何一笔递延/未闭合，必须写明 **owner / closesAtModule /
 * evidenceNeeded / closeTrigger / expiry / admissionBasis**，否则门禁不许它静默存在。
 *
 * 本门禁执行的规则：
 *   1. 严格 JSON、`schemaVersion: 1`、闭合键集（顶层与每笔各自比对排序后的期望键）；
 *      并**单独检测重复成员**——`JSON.parse` 会把重复键静默折叠为最后一个值，故本门禁
 *      在解析前对原文做一次键扫描（`findDuplicateKeys`），且键按**解码后的值**比较
 *      （同一键的 unicode 转义写法与字面量写法属同一键），重复成员转红（DUPLICATE_KEY）；
 *   2. 每笔在主键 `id` 之外**六个字段必须存在且非空**；`expiry` 缺失 → 转红
 *      （EXPIRY_MISSING），格式非法 → 转红（EXPIRY_MALFORMED）；只有两种合法取值：
 *      带回时区偏移的 ISO 8601 时间戳，或带**非空理由**的哨兵 `unassigned:<理由>`
 *      （裸 `unassigned` 一律 MALFORMED）；`owner` 同样接受带非空理由的
 *      `unassigned:<理由>` 哨兵（裸/空理由转红 OWNER_UNASSIGNED_MALFORMED），未指派项
 *      被计数并逐条上报；`evidence-obligation` 条目的 `closeTrigger` 必须写明
 *      `admission blocker`（否则 EVIDENCE_BLOCKER_MISSING）；
 *   3. `closesAtModule` 必须落在**闭合模块集**内，唯一例外是显式外部哨兵 `external`；
 *   4. id 不得重复、不得为空、须匹配严格形状；
 *   5. `admissionBasis` 必须落在受控的**内容准入类别**闭集内（见 §3）；
 *   6. 顶层 `reviewByMilestone` 必须形如 `M<0-6>`，声明 unassigned 项的收口里程碑；
 *   7. `unassigned:<理由>` 哨兵**不被静默接受**：它被计数、逐条上报，并与顶层声明的
 *      `unassignedExpiryCount` 硬比对；删除/改名条目会被 `expectedEntryCount` 抓住。
 *
 * 与 `security/audit-exceptions.json` + `scripts/check-production-audit.mjs` 同形：
 * 登记的例外若给到期日，用 `acceptedAt` 式日期 + 带 `+08:00` 的全 ISO 到期，校验格式、
 * 逾期即 fail closed、**禁止静默续期**。`unassigned:<理由>` 是本登记表对「今天确实还没有
 * 到期日」的显式登记口径，它比留空更严格——留空转红，裸哨兵转红，带理由的显式哨兵被
 * 计数上报，且不得跨过 `reviewByMilestone` 收口。
 *
 * 输出纪律：PASS 打固定行到 stdout，失败逐条 `... FAIL <code> <pointer>` 到 stderr 并
 * `process.exitCode = 1`；诊断只含本文件的静态字面量、计数与**已通过形状校验**的 id，
 * 绝不回显登记表里任意自由文本。`--register=<path>` 仅供测试指向临时副本，其取值不回显。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 登记表的固定仓库相对路径。 */
export const DEFERRAL_REGISTER_PATH = "docs/governance/deferral-register.json";
/** 当前 schema 版本，第一键即此值；门禁断言而非信任。 */
export const SCHEMA_VERSION = 1;
/**
 * 显式「尚无到期日」哨兵**前缀**：必须是 `unassigned:<非空理由>`。
 * 裸 `unassigned`（无理由）不再被接受——它会让「有界等待」退化为无限期停放。
 */
export const UNASSIGNED_EXPIRY_PREFIX = "unassigned:";
/** 外部方哨兵：`closesAtModule` 落在此值即视为仓库外的闭合方，唯一豁免闭集校验者。 */
export const EXTERNAL_SENTINEL = "external";
/**
 * `owner` 的未指派哨兵**前缀**：`unassigned:<非空理由>`。裸 `unassigned`（无理由）
 * 与空理由均判 `OWNER_UNASSIGNED_MALFORMED`；带理由者被计数、逐条上报。
 */
export const OWNER_UNASSIGNED_PREFIX = "unassigned:";
/** `evidence-obligation` 条目 `closeTrigger` 必须写明的措辞（ADR-0009 §3）。 */
export const ADMISSION_BLOCKER_MARKER = "admission blocker";
/** 受控的**内容准入类别**闭集（ADR-0009 §3）。新增类别必须显式改这里。 */
export const ADMISSION_BASIS_VALUES = Object.freeze([
  "bookkeeping",
  "evidence-obligation",
  "open-design-question",
]);
/** 里程碑身份：M0—M6 顶层集合；子里程碑不构成新计数起点。 */
export const MILESTONE_PATTERN = /^M[0-6]$/;
/** 每笔必须**恰好**携带的键（排序后比对）：主键 `id` + 六个字段。 */
export const ENTRY_KEYS = Object.freeze([
  "admissionBasis",
  "closeTrigger",
  "closesAtModule",
  "evidenceNeeded",
  "expiry",
  "id",
  "owner",
]);
/** 顶层必须**恰好**携带的键（排序后比对）。 */
export const TOP_LEVEL_KEYS = Object.freeze([
  "asOf",
  "entries",
  "expectedEntryCount",
  "registerId",
  "reviewByMilestone",
  "schemaVersion",
  "unassignedExpiryCount",
]);
/** 闭合模块闭集。新增模块必须显式改这里，或改用 `external` 哨兵。 */
export const KNOWN_CLOSES_AT_MODULES = Object.freeze([
  "backend/G-BACKEND",
  "client/G-CLIENT",
  "governance/总控",
  "identity/G-ID",
  "m4a/client-meal-confirm",
  "m4a/entitlement",
  "m4a/guest-facts",
  "m4a/serving-substitution",
  "migration/DB",
  "security/ADR-0004",
  "source/G2",
  "wp-o4/maintainer",
]);

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const NAMED_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const deepFreeze = (value) => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
};
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const sameKeys = (actual, expected) =>
  JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
const isFiniteTimestamp = (value) =>
  typeof value === "string" && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
const isNamedDate = (value) =>
  typeof value === "string" &&
  NAMED_DATE.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`));
/** 带**非空理由**的 `unassigned:<理由>` 哨兵；裸 `unassigned` 不满足。 */
const isUnassignedExpiry = (value) =>
  typeof value === "string" &&
  value.startsWith(UNASSIGNED_EXPIRY_PREFIX) &&
  value.slice(UNASSIGNED_EXPIRY_PREFIX.length).trim() !== "";
/** `owner` 的**带非空理由**未指派哨兵；裸 `unassigned` 与空理由都不满足。 */
const isUnassignedOwner = (value) =>
  typeof value === "string" &&
  value.startsWith(OWNER_UNASSIGNED_PREFIX) &&
  value.slice(OWNER_UNASSIGNED_PREFIX.length).trim() !== "";
/** `owner` 的非法未指派写法：裸 `unassigned`，或 `unassigned:` 后无理由。 */
const isMalformedUnassignedOwner = (value) =>
  typeof value === "string" &&
  (value.trim() === "unassigned" ||
    (value.startsWith(OWNER_UNASSIGNED_PREFIX) &&
      value.slice(OWNER_UNASSIGNED_PREFIX.length).trim() === ""));

/**
 * 对 JSON **原文**做一次键扫描，找出同一对象内重复出现的键。
 * `JSON.parse` 会把重复键静默折叠为最后一个值，因此不能让解析结果来证明「无重复成员」。
 * 键按**解码后的值**比较：同一键的 unicode 转义写法与字面量写法在解析后是同一键，
 * 若只比原文键字面量，这类重复会逃过扫描而被静默折叠。
 * 返回 `{ duplicates, ok }`：`duplicates` 是重复键名（原样，含引号，忠实于原文）数组，
 * `ok` 表示扫描完整走到文档末尾。遇到无法解析的原文时抛异常，由调用方转成 MALFORMED 类失败。
 */
export function findDuplicateKeys(text) {
  const duplicates = [];
  let index = 0;
  const length = text.length;
  const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
  const skipWs = () => {
    while (index < length && isWs(text[index])) index += 1;
  };
  const readString = () => {
    let raw = '"';
    index += 1; // 开引号
    while (index < length) {
      const c = text[index];
      raw += c;
      if (c === "\\") {
        index += 1;
        if (index < length) raw += text[index];
        index += 1;
        continue;
      }
      if (c === '"') {
        index += 1;
        return raw;
      }
      index += 1;
    }
    throw new Error("unterminated-string");
  };
  const decodeKey = (raw) => {
    // `raw` 是含引号的字符串字面量原文；JSON.parse 给出其真实（解码）键值。
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("invalid-key-literal");
    }
  };
  const readLiteral = () => {
    while (
      index < length &&
      !isWs(text[index]) &&
      text[index] !== "," &&
      text[index] !== "}" &&
      text[index] !== "]"
    ) {
      index += 1;
    }
  };
  const readValue = () => {
    skipWs();
    const c = text[index];
    if (c === "{") {
      readObject();
      return;
    }
    if (c === "[") {
      readArray();
      return;
    }
    if (c === '"') {
      readString();
      return;
    }
    readLiteral();
  };
  const readObject = () => {
    index += 1; // {
    const keys = new Set();
    skipWs();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    for (;;) {
      skipWs();
      const key = readString();
      const decodedKey = decodeKey(key);
      if (keys.has(decodedKey)) duplicates.push(key);
      keys.add(decodedKey);
      skipWs();
      if (text[index] !== ":") throw new Error("expected-colon");
      index += 1;
      readValue();
      skipWs();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        return;
      }
      throw new Error("expected-comma-or-brace");
    }
  };
  const readArray = () => {
    index += 1; // [
    skipWs();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    for (;;) {
      readValue();
      skipWs();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        return;
      }
      throw new Error("expected-comma-or-bracket");
    }
  };
  readValue();
  skipWs();
  return { duplicates, ok: index === length };
}

const emptySummary = () => ({
  register: null,
  schemaVersion: null,
  ok: false,
  reviewByMilestone: null,
  entries: 0,
  withExpiry: 0,
  unassignedExpiry: 0,
  externalSentinelEntries: 0,
  unassignedOwners: 0,
  unassignedIds: [],
  unassignedOwnerIds: [],
  admissionBases: [],
  closesAtModules: [],
});
const finish = (failures, summary) =>
  deepFreeze({
    ok: failures.length === 0,
    failures: [...failures],
    summary: { ...summary, ok: failures.length === 0 },
  });

/**
 * 纯校验函数：吃一个已解析的登记表对象，吐一个冻结的判定。
 * 不读盘、不抛异常、不改输入——磁盘与 CLI 边界在 `main` 里。
 */
export function validateDeferralRegister(value) {
  const failures = [];
  const fail = (code, pointer) => failures.push(deepFreeze({ code, pointer }));
  const summary = emptySummary();

  if (!isRecord(value)) {
    fail("REGISTER_SHAPE", "/");
    return finish(failures, summary);
  }
  if (!sameKeys(Object.keys(value), TOP_LEVEL_KEYS)) fail("TOP_LEVEL_KEYS", "/");

  if (value.schemaVersion === SCHEMA_VERSION) {
    summary.schemaVersion = SCHEMA_VERSION;
  } else {
    fail("SCHEMA_VERSION", "/schemaVersion");
  }
  if (typeof value.registerId === "string" && ID_PATTERN.test(value.registerId)) {
    summary.register = value.registerId;
  } else {
    fail("REGISTER_ID", "/registerId");
  }
  if (!isNamedDate(value.asOf)) fail("AS_OF", "/asOf");
  if (typeof value.reviewByMilestone === "string" && MILESTONE_PATTERN.test(value.reviewByMilestone)) {
    summary.reviewByMilestone = value.reviewByMilestone;
  } else {
    fail("REVIEW_BY_MILESTONE", "/reviewByMilestone");
  }

  if (!Array.isArray(value.entries)) {
    fail("ENTRIES_SHAPE", "/entries");
    return finish(failures, summary);
  }
  const entries = value.entries;
  summary.entries = entries.length;
  if (value.expectedEntryCount !== entries.length) fail("ENTRY_COUNT", "/expectedEntryCount");

  const seenIds = new Set();
  const moduleSet = new Set();
  const admissionBasisSet = new Set();
  const unassignedIds = [];
  const unassignedOwnerIds = [];
  for (let index = 0; index < entries.length; index += 1) {
    const pointer = `/entries/${index}`;
    const entry = entries[index];
    if (!isRecord(entry)) {
      fail("ENTRY_SHAPE", pointer);
      continue;
    }
    if (!sameKeys(Object.keys(entry), ENTRY_KEYS)) fail("ENTRY_KEYS", pointer);

    let idOk = typeof entry.id === "string" && ID_PATTERN.test(entry.id);
    if (!idOk) {
      fail("ENTRY_ID", `${pointer}/id`);
    } else if (seenIds.has(entry.id)) {
      fail("ENTRY_ID_DUPLICATE", `${pointer}/id`);
      idOk = false;
    } else {
      seenIds.add(entry.id);
    }

    if (!isNonEmptyString(entry.owner)) {
      fail("OWNER_EMPTY", `${pointer}/owner`);
    } else if (isMalformedUnassignedOwner(entry.owner)) {
      fail("OWNER_UNASSIGNED_MALFORMED", `${pointer}/owner`);
    } else if (isUnassignedOwner(entry.owner)) {
      summary.unassignedOwners += 1;
      if (idOk) unassignedOwnerIds.push(entry.id);
    }

    if (!isNonEmptyString(entry.closesAtModule)) {
      fail("MODULE_MISSING", `${pointer}/closesAtModule`);
    } else if (
      entry.closesAtModule !== EXTERNAL_SENTINEL &&
      !KNOWN_CLOSES_AT_MODULES.includes(entry.closesAtModule)
    ) {
      fail("MODULE_UNKNOWN", `${pointer}/closesAtModule`);
    } else {
      moduleSet.add(entry.closesAtModule);
      if (entry.closesAtModule === EXTERNAL_SENTINEL) summary.externalSentinelEntries += 1;
    }

    if (!isNonEmptyString(entry.evidenceNeeded)) fail("EVIDENCE_EMPTY", `${pointer}/evidenceNeeded`);
    if (!isNonEmptyString(entry.closeTrigger)) fail("TRIGGER_EMPTY", `${pointer}/closeTrigger`);

    if (!isNonEmptyString(entry.admissionBasis)) {
      fail("ADMISSION_BASIS_MISSING", `${pointer}/admissionBasis`);
    } else if (!ADMISSION_BASIS_VALUES.includes(entry.admissionBasis)) {
      fail("ADMISSION_BASIS_UNKNOWN", `${pointer}/admissionBasis`);
    } else {
      admissionBasisSet.add(entry.admissionBasis);
      // evidence-obligation 的语义修复已落地、仅余证据，故其仍是 admission blocker：
      // closeTrigger 必须写明该措辞，否则该「义务」只是空话。
      if (
        entry.admissionBasis === "evidence-obligation" &&
        (typeof entry.closeTrigger !== "string" ||
          !entry.closeTrigger.includes(ADMISSION_BLOCKER_MARKER))
      ) {
        fail("EVIDENCE_BLOCKER_MISSING", `${pointer}/closeTrigger`);
      }
    }

    if (isUnassignedExpiry(entry.expiry)) {
      summary.unassignedExpiry += 1;
      if (idOk) unassignedIds.push(entry.id);
    } else if (isFiniteTimestamp(entry.expiry)) {
      summary.withExpiry += 1;
    } else if (entry.expiry === undefined || entry.expiry === null || entry.expiry === "") {
      fail("EXPIRY_MISSING", `${pointer}/expiry`);
    } else {
      fail("EXPIRY_MALFORMED", `${pointer}/expiry`);
    }
  }

  summary.unassignedIds = unassignedIds.sort();
  summary.unassignedOwnerIds = unassignedOwnerIds.sort();
  summary.admissionBases = [...admissionBasisSet].sort();
  summary.closesAtModules = [...moduleSet].sort();
  if (value.unassignedExpiryCount !== summary.unassignedExpiry) {
    fail("UNASSIGNED_COUNT", "/unassignedExpiryCount");
  }
  return finish(failures, summary);
}

const summaryLine = (summary) => `deferral-register summary ${JSON.stringify(summary)}\n`;

const readRegister = (root, relative) => {
  try {
    return { ok: true, text: readFileSync(resolve(root, relative), "utf8") };
  } catch {
    return { ok: false };
  }
};

const main = () => {
  const argument = process.argv.slice(2).find((value) => value.startsWith("--register="));
  const relative = argument ? argument.slice("--register=".length) : DEFERRAL_REGISTER_PATH;
  const root = resolve(import.meta.dirname, "..");

  const raw = readRegister(root, relative);
  if (!raw.ok) {
    process.stderr.write("deferral register FAIL REGISTER_UNREADABLE\n");
    process.stderr.write(summaryLine(emptySummary()));
    process.exitCode = 1;
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    process.stderr.write("deferral register FAIL REGISTER_UNPARSABLE\n");
    process.stderr.write(summaryLine(emptySummary()));
    process.exitCode = 1;
    return;
  }

  // `JSON.parse` 会把重复成员静默折叠为最后一个值，故必须在解析结果之外，
  // 单独对原文做一次键扫描，否则「重复成员一律 fail closed」只是空谈。
  let duplicateKeys = [];
  try {
    const scan = findDuplicateKeys(raw.text);
    if (!scan.ok) throw new Error("trailing-content");
    duplicateKeys = scan.duplicates;
  } catch {
    process.stderr.write("deferral register FAIL REGISTER_UNPARSABLE\n");
    process.stderr.write(summaryLine(emptySummary()));
    process.exitCode = 1;
    return;
  }

  const result = validateDeferralRegister(parsed);
  const failures = [...result.failures];
  if (duplicateKeys.length > 0) {
    failures.push(deepFreeze({ code: "DUPLICATE_KEY", pointer: "/" }));
  }
  const summary = { ...result.summary, ok: failures.length === 0 };
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`deferral register FAIL ${failure.code} ${failure.pointer}\n`);
    }
    process.stderr.write(summaryLine(summary));
    process.exitCode = 1;
    return;
  }
  process.stdout.write("deferral register check passed\n");
  for (const id of result.summary.unassignedIds) {
    process.stdout.write(`deferral register unassigned-expiry ${id}\n`);
  }
  for (const id of result.summary.unassignedOwnerIds) {
    process.stdout.write(`deferral register unassigned-owner ${id}\n`);
  }
  process.stdout.write(summaryLine(summary));
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
