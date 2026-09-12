import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  ADMISSION_BASIS_VALUES,
  DEFERRAL_REGISTER_PATH,
  EXTERNAL_SENTINEL,
  UNASSIGNED_EXPIRY_PREFIX,
  findDuplicateKeys,
  validateDeferralRegister,
} from "../check-deferral-register.mjs";

const root = resolve(import.meta.dirname, "../..");
const checkerPath = resolve(import.meta.dirname, "../check-deferral-register.mjs");
const registerPath = resolve(root, DEFERRAL_REGISTER_PATH);
const realText = readFileSync(registerPath, "utf8");
const realRegister = JSON.parse(realText);
const clone = (value) => structuredClone(value);
const codes = (result) => result.failures.map((failure) => failure.code);
const isUnassigned = (value) =>
  typeof value === "string" && value.startsWith(UNASSIGNED_EXPIRY_PREFIX);

test("真实的递延项登记表通过，且计数与声明一致", () => {
  const result = validateDeferralRegister(realRegister);
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.summary.entries, realRegister.entries.length);
  assert.equal(result.summary.entries, realRegister.expectedEntryCount);
  assert.equal(result.summary.withExpiry, 1);
  assert.equal(result.summary.unassignedExpiry, realRegister.entries.length - 1);
  assert.equal(result.summary.unassignedExpiry, realRegister.unassignedExpiryCount);
  assert.equal(result.summary.unassignedIds.length, realRegister.unassignedExpiryCount);
  assert.equal(result.summary.externalSentinelEntries, 0);
  assert.equal(result.summary.unassignedOwners, 0);
  assert.equal(result.summary.reviewByMilestone, "M2");
  assert.deepEqual(result.summary.admissionBases, [...ADMISSION_BASIS_VALUES].sort());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.failures), true);
  assert.equal(Object.isFrozen(result.summary), true);
});

test("确定性：同一输入两次判定逐字节相同，且不修改输入", () => {
  const before = JSON.stringify(realRegister);
  const first = validateDeferralRegister(realRegister);
  const second = validateDeferralRegister(realRegister);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(realRegister), before);
});

// 每一行：一个真实登记表上的定点变异，以及预期必须被抓住的失败码。
// `null` 表示该变异合法（哨兵豁免），应当仍然通过——用来证明闭集校验不是「一律转红」。
const mutations = [
  ["删掉 owner 字段", (r) => { delete r.entries[0].owner; }, "ENTRY_KEYS"],
  ["owner 置空串", (r) => { r.entries[0].owner = ""; }, "OWNER_EMPTY"],
  ["owner 裸 unassigned（无理由）", (r) => { r.entries[0].owner = "unassigned"; }, "OWNER_UNASSIGNED_MALFORMED"],
  ["owner 哨兵理由为空", (r) => { r.entries[0].owner = "unassigned:   "; }, "OWNER_UNASSIGNED_MALFORMED"],
  ["owner 写为带理由的 unassigned 哨兵（合法）", (r) => { r.entries[0].owner = "unassigned:待责任表落定"; }, null],
  ["evidence-obligation 的 closeTrigger 丢失 admission blocker 措辞", (r) => { r.entries.find((e) => e.admissionBasis === "evidence-obligation").closeTrigger = "续期批次"; }, "EVIDENCE_BLOCKER_MISSING"],
  ["删掉 expiry 字段", (r) => { delete r.entries[0].expiry; }, "EXPIRY_MISSING"],
  ["expiry 置空串", (r) => { r.entries[0].expiry = ""; }, "EXPIRY_MISSING"],
  ["expiry 只有日期无时刻/时区", (r) => { r.entries[0].expiry = "2026-11-08"; }, "EXPIRY_MALFORMED"],
  ["expiry 裸 unassigned（无理由）", (r) => { r.entries[0].expiry = "unassigned"; }, "EXPIRY_MALFORMED"],
  ["expiry 哨兵拼错（尾随空格）", (r) => { r.entries[0].expiry = "unassigned "; }, "EXPIRY_MALFORMED"],
  ["expiry 哨兵理由为空", (r) => { r.entries[0].expiry = "unassigned:   "; }, "EXPIRY_MALFORMED"],
  ["expiry 时区缺失", (r) => { r.entries[0].expiry = "2026-11-08T23:59:59"; }, "EXPIRY_MALFORMED"],
  ["id 重复", (r) => { r.entries[1].id = r.entries[0].id; }, "ENTRY_ID_DUPLICATE"],
  ["id 形状非法", (r) => { r.entries[0].id = "带 空格"; }, "ENTRY_ID"],
  ["closesAtModule 落在闭集外", (r) => { r.entries[0].closesAtModule = "nobody/nowhere"; }, "MODULE_UNKNOWN"],
  ["evidenceNeeded 置空", (r) => { r.entries[0].evidenceNeeded = "   "; }, "EVIDENCE_EMPTY"],
  ["closeTrigger 置空", (r) => { r.entries[0].closeTrigger = ""; }, "TRIGGER_EMPTY"],
  ["删掉 admissionBasis", (r) => { delete r.entries[0].admissionBasis; }, "ENTRY_KEYS"],
  ["admissionBasis 置空", (r) => { r.entries[0].admissionBasis = ""; }, "ADMISSION_BASIS_MISSING"],
  ["admissionBasis 落在闭集外", (r) => { r.entries[0].admissionBasis = "语义缺陷"; }, "ADMISSION_BASIS_UNKNOWN"],
  ["reviewByMilestone 非法", (r) => { r.reviewByMilestone = "M2a"; }, "REVIEW_BY_MILESTONE"],
  ["schemaVersion 漂移", (r) => { r.schemaVersion = 2; }, "SCHEMA_VERSION"],
  ["expectedEntryCount 漂移", (r) => { r.expectedEntryCount = 999; }, "ENTRY_COUNT"],
  ["多一个条目键", (r) => { r.entries[0].note = "x"; }, "ENTRY_KEYS"],
  ["少一个顶层键", (r) => { delete r.reviewByMilestone; }, "TOP_LEVEL_KEYS"],
  ["把某笔 unassigned 静默改成真实日期", (r) => { r.entries[0].expiry = "2027-01-01T00:00:00+08:00"; }, "UNASSIGNED_COUNT"],
  ["把某笔静默删掉", (r) => { r.entries.pop(); }, "ENTRY_COUNT"],
  ["external 哨兵放行", (r) => { r.entries[0].closesAtModule = EXTERNAL_SENTINEL; }, null],
];

test("定点变异逐条被抓住（不是靠断言，而是真跑校验器看它转红）", () => {
  for (const [label, mutate, expected] of mutations) {
    const mutant = clone(realRegister);
    mutate(mutant);
    const before = JSON.stringify(mutant);
    const result = validateDeferralRegister(mutant);
    if (expected === null) {
      assert.equal(result.ok, true, `${label} 本应放行: ${JSON.stringify(result.failures)}`);
    } else {
      assert.equal(result.ok, false, `${label} 本应被抓住`);
      assert.ok(codes(result).includes(expected), `${label} 应含 ${expected}，实得 ${codes(result)}`);
    }
    // 失败次数与具体码不确定，但输入必须原样不动、判定必须可复现。
    assert.equal(JSON.stringify(mutant), before, `${label} 不得修改输入`);
    assert.deepStrictEqual(validateDeferralRegister(mutant), result, `${label} 必须可复现`);
  }
});

test("findDuplicateKeys 抓到同一对象内的重复键，且放过合法原文", () => {
  assert.deepEqual(findDuplicateKeys(realText), { duplicates: [], ok: true });
  assert.deepEqual(findDuplicateKeys('{"a":1,"a":2}'), { duplicates: ['"a"'], ok: true });
  assert.deepEqual(findDuplicateKeys('{"a":{"b":1,"b":2}}').duplicates, ['"b"']);
  // 不同对象里的同名键不是重复。
  assert.deepEqual(findDuplicateKeys('{"a":1,"b":{"a":2}}').duplicates, []);
  // 字符串值里的括号/冒号/键样文本不得被误判。
  assert.deepEqual(findDuplicateKeys('{"a":"value:{fake}:\\"x\\"","b":2}').duplicates, []);
  assert.deepEqual(findDuplicateKeys('{"a":[],"b":[]}'), { duplicates: [], ok: true });
  assert.deepEqual(findDuplicateKeys('{"a":true,"a":false}').duplicates, ['"a"']);
  // 转义等价的键必须被当作同一键：unicode 转义写法与字面量写法解码后相等。
  const ESC = String.fromCharCode(92) + "u0061"; // 一个反斜杠 + u0061，即 JSON 的 a 转义写法
  assert.deepEqual(findDuplicateKeys(`{"a":1,"${ESC}":2}`).duplicates, [`"${ESC}"`]);
  assert.deepEqual(findDuplicateKeys(`{"${ESC}":1,"a":2}`).duplicates, ['"a"']);
  // 不同对象里的转义等价键仍不算重复。
  assert.deepEqual(findDuplicateKeys(`{"${ESC}":1,"b":{"a":2}}`).duplicates, []);
});

test("确权：真实登记表里唯一带真实到期日的是 audit-exceptions 那笔", () => {
  const expiring = realRegister.entries.filter((entry) => !isUnassigned(entry.expiry));
  assert.equal(expiring.length, 1);
  assert.equal(expiring[0].id, "AUDIT-EXCEPTION-2026-11-08");
  assert.equal(expiring[0].expiry, "2026-11-08T23:59:59+08:00");
});

test("确权：每笔 unassigned 都带非空理由，且身份/namespace 条目按证据义务登记", () => {
  for (const entry of realRegister.entries) {
    if (isUnassigned(entry.expiry)) {
      assert.ok(
        entry.expiry.slice(UNASSIGNED_EXPIRY_PREFIX.length).trim() !== "",
        `${entry.id} 的 unassigned 必须带理由`,
      );
      assert.ok(ADMISSION_BASIS_VALUES.includes(entry.admissionBasis));
    }
  }
  // R2-ADV-03 家族的残项不得被当作普通递延：以 evidence-obligation 登记且仍是 blocker。
  const o95 = realRegister.entries.find((entry) => entry.id === "O9-5");
  assert.equal(o95.admissionBasis, "evidence-obligation");
  assert.match(o95.closeTrigger, /admission blocker/);
});

test("确权：每条 evidence-obligation 的 closeTrigger 都写明 admission blocker", () => {
  const obligations = realRegister.entries.filter(
    (entry) => entry.admissionBasis === "evidence-obligation",
  );
  assert.ok(obligations.length > 0);
  for (const entry of obligations) {
    assert.match(
      entry.closeTrigger,
      /admission blocker/,
      `${entry.id} 的 closeTrigger 必须写明 admission blocker`,
    );
  }
  // ADR 自己点名的实例 G8 必须在其中。
  const g8 = realRegister.entries.find((entry) => entry.id === "G8");
  assert.equal(g8.admissionBasis, "evidence-obligation");
  assert.match(g8.closeTrigger, /admission blocker/);
});

test("owner 未指派哨兵被计数上报；裸 unassigned / 空理由转红", () => {
  const valid = clone(realRegister);
  valid.entries[0].owner = "unassigned:待责任表落定";
  const okResult = validateDeferralRegister(valid);
  assert.equal(okResult.ok, true, JSON.stringify(okResult.failures));
  assert.equal(okResult.summary.unassignedOwners, 1);
  assert.deepEqual(okResult.summary.unassignedOwnerIds, ["O9-5"]);

  for (const bad of ["unassigned", "unassigned:   "]) {
    const mutant = clone(realRegister);
    mutant.entries[0].owner = bad;
    assert.ok(
      codes(validateDeferralRegister(mutant)).includes("OWNER_UNASSIGNED_MALFORMED"),
      `owner=${JSON.stringify(bad)} 应含 OWNER_UNASSIGNED_MALFORMED`,
    );
  }
});

test("CLI 在真实登记表上通过，并打印机器可读摘要行", () => {
  const outcome = spawnSync(process.execPath, [checkerPath], { encoding: "utf8" });
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(outcome.stdout, /^deferral register check passed\n/);
  assert.match(
    outcome.stdout,
    new RegExp(`deferral-register summary \\{"register":"[^"]+","schemaVersion":1,"ok":true,"reviewByMilestone":"M2","entries":${realRegister.entries.length}`),
  );
  assert.match(outcome.stdout, new RegExp(`"unassignedExpiry":${realRegister.unassignedExpiryCount}`));
  assert.match(outcome.stdout, /deferral register unassigned-expiry O9-5\n/);
});

test("CLI 在缺失 expiry 的副本上以非零退出并逐条报失败码", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "deferral-register-"));
  const mutant = clone(realRegister);
  delete mutant.entries[0].expiry;
  const file = resolve(dir, "deferral-register.json");
  writeFileSync(file, `${JSON.stringify(mutant, null, 2)}\n`, "utf8");
  const outcome = spawnSync(process.execPath, [checkerPath, `--register=${file}`], {
    encoding: "utf8",
  });
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /deferral register FAIL EXPIRY_MISSING \/entries\/0\/expiry\n/);
  assert.match(outcome.stderr, /deferral register FAIL ENTRY_KEYS \/entries\/0\n/);
  assert.match(outcome.stderr, /deferral-register summary \{"register":[^}]*"ok":false/);
  assert.doesNotMatch(outcome.stdout, /check passed/);
});

test("CLI 在含重复成员的副本上 fail closed（JSON.parse 会折叠重复键，故须原文扫描）", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "deferral-register-"));
  // 在 O9-5 之后再塞一个 owner 键：JSON.parse 会折叠，原文扫描必须抓住。
  const dupText = realText.replace('"id": "O9-5",', '"id": "O9-5",\n      "owner": "dup",');
  const file = resolve(dir, "deferral-register.json");
  writeFileSync(file, dupText, "utf8");
  // 先证明这个副本确实被 JSON.parse 折叠（否则本测试前提不成立）。
  assert.equal(JSON.parse(dupText).entries[0].owner, realRegister.entries[0].owner);
  const outcome = spawnSync(process.execPath, [checkerPath, `--register=${file}`], {
    encoding: "utf8",
  });
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /deferral register FAIL DUPLICATE_KEY \/\n/);
  assert.doesNotMatch(outcome.stdout, /check passed/);
});

test("CLI 抓到转义等价的重复键（键按解码值比较，故不会被静默折叠）", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "deferral-register-"));
  const BS = String.fromCharCode(92);
  // 第二个 "id" 用 unicode 转义书写：JSON.parse 折叠为同一键，原文扫描须按解码值抓住。
  const dupText = realText.replace(
    '"id": "O9-5",',
    `"id": "O9-5",\n      "${BS}u0069d": "O9-5",`,
  );
  const file = resolve(dir, "deferral-register.json");
  writeFileSync(file, dupText, "utf8");
  // 先证明这个副本确实被 JSON.parse 折叠（否则本测试前提不成立）。
  assert.equal(JSON.parse(dupText).entries[0].id, "O9-5");
  const outcome = spawnSync(process.execPath, [checkerPath, `--register=${file}`], {
    encoding: "utf8",
  });
  assert.equal(outcome.status, 1, outcome.stdout);
  assert.match(outcome.stderr, /deferral register FAIL DUPLICATE_KEY \/\n/);
  assert.doesNotMatch(outcome.stdout, /check passed/);
});

test("CLI 在不可读登记表上 fail closed，不静默跳过", () => {
  const missing = resolve(tmpdir(), "deferral-register-does-not-exist.json");
  const outcome = spawnSync(process.execPath, [checkerPath, `--register=${missing}`], {
    encoding: "utf8",
  });
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /deferral register FAIL REGISTER_UNREADABLE\n/);
  assert.doesNotMatch(outcome.stdout, /check passed/);
});

test("CLI 失败路径不回显登记表里的自由文本", () => {
  const sentinel = "DEFERRAL-UNTRUSTED-SENTINEL";
  const dir = mkdtempSync(resolve(tmpdir(), "deferral-register-"));
  const mutant = clone(realRegister);
  mutant.entries[0].owner = sentinel;
  delete mutant.entries[0].closeTrigger;
  const file = resolve(dir, "deferral-register.json");
  writeFileSync(file, `${JSON.stringify(mutant, null, 2)}\n`, "utf8");
  const outcome = spawnSync(process.execPath, [checkerPath, `--register=${file}`], {
    encoding: "utf8",
  });
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /deferral register FAIL TRIGGER_EMPTY \/entries\/0\/closeTrigger\n/);
  assert.doesNotMatch(outcome.stderr, new RegExp(sentinel));
  assert.doesNotMatch(outcome.stdout, new RegExp(sentinel));
});
