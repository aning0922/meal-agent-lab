import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const POSITIVE_KINDS = new Set([
  "explicit_ingredient", "explicit_contains", "explicit_may_contain",
  "explicit_shared_line", "explicit_shared_equipment",
]);
const UNKNOWN_KINDS = new Set([
  "warning_absent", "negative_free_from_claim", "compound_unexpanded",
  "extraction_uncertain", "outside_prepackaged_scope",
]);
const ISSUE_ORDER = Object.freeze([
  "INVALID_SHAPE", "INVALID_CONTEXT", "INVALID_LIFECYCLE", "ACTIVATION_NOT_ZERO",
  "LICENSE_NOT_PENDING", "USAGE_NOT_PENDING", "INVALID_WINDOW", "INVALID_SOURCE_CLASS",
  "INVALID_PROVENANCE", "FULL_TEXT_FORBIDDEN", "REAL_USER_DATA_FORBIDDEN",
  "RELIGIOUS_NOT_DRAFT",
]);
const PRODUCERS = Object.freeze([
  {
    releaseId: "release:gb7718-2011:allergen", releaseRevision: 1,
    datasetId: "cn:gb7718-2011:allergen", datasetKind: "allergen",
    entityId: "label-allergen-disclosure-2011", entityRevision: 1,
    referenceId: "source:gb7718-2011:pdf", referenceRevision: "2011",
    locator: "https://www.nhc.gov.cn/zwgkzt/cybz/201106/a054a6affd0e489da150cf2b51a971a7/files/e84256474d1445919246b4a41a87f172.pdf",
    snapshotId: "snapshot:gb7718-2011:pdf:2026-08-29",
    snapshotDigest: "sha256:1518746449379575738703de14e0dae148372427d1322c3e70a20047a600e366",
    sourceVersion: "2011", bindingId: "binding:gb7718-2011:allergen",
  },
  {
    releaseId: "release:gb7718-2025:allergen", releaseRevision: 1,
    datasetId: "cn:gb7718-2025:allergen", datasetKind: "allergen",
    entityId: "label-allergen-disclosure-2025", entityRevision: 1,
    referenceId: "source:gb7718-2025:pdf", referenceRevision: "2025",
    locator: "https://sppt.cfsa.net.cn:8086/diskFilePath/swfupload1742974306979.pdf",
    snapshotId: "snapshot:gb7718-2025:pdf:2026-08-29",
    snapshotDigest: "sha256:54c5d42a02fc86e5bcc365d7a5b19bd0663f89388331f7e4d9e5e2b9ac92e59f",
    sourceVersion: "2025", bindingId: "binding:gb7718-2025:allergen",
  },
  {
    releaseId: "release:religious-candidate:blood", releaseRevision: 1,
    datasetId: "cn:religious-candidate:islamic-diet", datasetKind: "religious_ethical",
    entityId: "candidate:explicit-blood-exclusion", entityRevision: 1,
    referenceId: "source:chinaislam:blood-candidate", referenceRevision: "locator-2026-08-29",
    locator: "https://www.chinaislam.net.cn/web/jxsx/c/content_4778.shtml",
    snapshotId: "snapshot:chinaislam:blocked:2026-08-29",
    snapshotDigest: "sha256:cda86e07b859ab427d92f6b352dc642249b2dad75d6850e9349ac63d052de0b4",
  },
]);
const WINDOWS = Object.freeze([
  {
    bindingId: "binding:gb7718-2011:allergen", jurisdictionTimeZone: "Asia/Shanghai",
    sourceCivilEffectiveDate: "2012-04-20", effectiveFrom: "2012-04-19T16:00:00.000Z",
    effectiveUntil: "2027-03-15T16:00:00.000Z",
  },
  {
    bindingId: "binding:gb7718-2025:allergen", jurisdictionTimeZone: "Asia/Shanghai",
    sourceCivilEffectiveDate: "2027-03-16", effectiveFrom: "2027-03-15T16:00:00.000Z",
    effectiveUntil: null,
  },
]);

const deepFreeze = (value) => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
};
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort(compareUtf8)
    .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
};
const digest = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const releaseMaterial = (release) => {
  const material = {};
  if (Object.hasOwn(release, "$schema")) material.$schema = release.$schema;
  Object.assign(material, {
    schemaVersion: release.schemaVersion, releaseId: release.releaseId,
    releaseRevision: release.releaseRevision, envelopes: release.envelopes,
  });
  return material;
};
const releaseDigest = (release) => digest(Buffer.from(canonicalJson(releaseMaterial(release))));
const packMaterial = (pack) => ({
  schemaVersion: pack.schemaVersion, packId: pack.packId, packRevision: pack.packRevision,
  lifecycleStatus: pack.lifecycleStatus, country: pack.country,
  foodRuleRegion: pack.foodRuleRegion, ruleLanguage: pack.ruleLanguage,
  releaseBindings: [...pack.releaseBindings].sort((a, b) => compareUtf8(a.bindingId, b.bindingId)),
  sourceVersionWindows: [...pack.sourceVersionWindows].sort((a, b) => {
    for (const key of ["bindingId", "effectiveFrom", "effectiveUntil"]) {
      const order = compareUtf8(String(a[key]), String(b[key]));
      if (order !== 0) return order;
    }
    return compareUtf8(canonicalJson(a), canonicalJson(b));
  }),
  mappingReviews: [...pack.mappingReviews].sort((a, b) => {
    const id = compareUtf8(a.mappingId, b.mappingId);
    if (id !== 0) return id;
    const revision = a.reviewRevision - b.reviewRevision;
    return revision !== 0 ? revision : compareUtf8(canonicalJson(a), canonicalJson(b));
  }),
  catalog: pack.catalog,
});
const packDigest = (pack) => digest(Buffer.concat([
  Buffer.from("stage09p-m1-household-safety-official-pack-v2\0"),
  Buffer.from(canonicalJson(packMaterial(pack))),
]));
const sortedIssues = (issues) => deepFreeze(
  [...new Map(issues.map((issue) => [issue.code + "\0" + issue.path, issue])).values()]
    .sort((a, b) => {
      const rank = ISSUE_ORDER.indexOf(a.code) - ISSUE_ORDER.indexOf(b.code);
      return rank !== 0 ? rank : compareUtf8(a.path, b.path);
    }),
);

export function classifySourceInventoryProjection(projectionKind) {
  if (!POSITIVE_KINDS.has(projectionKind) && !UNKNOWN_KINDS.has(projectionKind)) {
    return deepFreeze({ ok: false, issue: { code: "UNKNOWN_PROJECTION_KIND", path: "/projectionKind" } });
  }
  return deepFreeze({
    schemaVersion: 1, projectionKind,
    factDisposition: POSITIVE_KINDS.has(projectionKind) ? "POSITIVE_BLOCK" : "UNKNOWN_BLOCK",
  });
}

export function checkStage09pM1SourcePackContract(value, asOf) {
  const issues = [];
  const add = (code, path) => issues.push(deepFreeze({ code, path }));
  const finish = () => {
    const ordered = sortedIssues(issues);
    return ordered.length === 0
      ? deepFreeze({ ok: true, issues: [] })
      : deepFreeze({ ok: false, issues: ordered });
  };
  if (!isRecord(value)) {
    add("INVALID_SHAPE", "");
    return finish();
  }
  if (value.schemaVersion !== 2 || value.packId !== "stage09p:m1:cn-household-safety" ||
      !Number.isSafeInteger(value.packRevision) || value.packRevision < 1) {
    add("INVALID_SHAPE", "/schemaVersion");
  }
  if (value.country !== "CN" || value.foodRuleRegion !== "CN" || value.ruleLanguage !== "zh-CN") {
    add("INVALID_CONTEXT", "/country");
  }
  if (value.lifecycleStatus !== "draft") add("INVALID_LIFECYCLE", "/lifecycleStatus");
  if (!Array.isArray(value.releaseBindings) || !Array.isArray(value.sourceVersionWindows) ||
      !Array.isArray(value.mappingReviews) || !isRecord(value.catalog) ||
      !Array.isArray(value.catalog.releases) || !Array.isArray(value.catalog.hardMappings)) {
    add("INVALID_SHAPE", "/catalog");
    return finish();
  }
  if (value.catalog.hardMappings.length !== 0 || value.mappingReviews.length !== 0) {
    add("ACTIVATION_NOT_ZERO", "/catalog/hardMappings");
  }

  let packDigestEligible = true;
  const releaseDigestEligibility = [];
  let reviewedClearCount = 0;
  let religiousCount = 0;
  if (value.catalog.releases.length !== PRODUCERS.length) {
    add("INVALID_PROVENANCE", "/catalog/releases");
  }
  for (let releaseIndex = 0; releaseIndex < value.catalog.releases.length; releaseIndex += 1) {
    const release = value.catalog.releases[releaseIndex];
    const releasePath = "/catalog/releases/" + releaseIndex;
    const producer = PRODUCERS[releaseIndex];
    if (!isRecord(release)) {
      add("INVALID_SHAPE", releasePath);
      releaseDigestEligibility[releaseIndex] = false;
      packDigestEligible = false;
      continue;
    }
    if (!Array.isArray(release.envelopes) || release.envelopes.length !== 1) {
      add("INVALID_SHAPE", releasePath + "/envelopes");
      releaseDigestEligibility[releaseIndex] = false;
      packDigestEligible = false;
      continue;
    }
    const envelope = release.envelopes[0];
    const envelopePath = releasePath + "/envelopes/0";
    if (!isRecord(envelope)) {
      add("INVALID_SHAPE", envelopePath);
      releaseDigestEligibility[releaseIndex] = false;
      packDigestEligible = false;
      continue;
    }
    let releaseDigestEligible = true;
    if (producer === undefined) {
      add("INVALID_PROVENANCE", releasePath);
    } else {
      for (const [key, expected] of Object.entries({
        releaseId: producer.releaseId, releaseRevision: producer.releaseRevision,
      })) if (release[key] !== expected) add("INVALID_PROVENANCE", releasePath + "/" + key);
      for (const [key, expected] of Object.entries({
        datasetId: producer.datasetId, datasetKind: producer.datasetKind,
        entityId: producer.entityId, entityRevision: producer.entityRevision,
      })) if (envelope[key] !== expected) add("INVALID_PROVENANCE", envelopePath + "/" + key);
    }

    if (!isRecord(envelope.officialEvidence)) {
      add("INVALID_SOURCE_CLASS", envelopePath + "/officialEvidence");
      releaseDigestEligible = false;
    } else {
      const evidence = envelope.officialEvidence;
      if (Object.hasOwn(envelope, "syntheticEvidence")) {
        add("INVALID_SOURCE_CLASS", envelopePath + "/syntheticEvidence");
      }
      if (envelope.lifecycleStatus !== "draft" && envelope.lifecycleStatus !== "under_review") {
        add("INVALID_LIFECYCLE", envelopePath + "/lifecycleStatus");
      }
      if (envelope.licenseStatus !== "pending") add("LICENSE_NOT_PENDING", envelopePath + "/licenseStatus");
      if (evidence.usageStatus !== "pending") add("USAGE_NOT_PENDING", envelopePath + "/officialEvidence/usageStatus");
      if (evidence.factDisposition === "REVIEWED_CLEAR") reviewedClearCount += 1;
      if (evidence.classification !== "official_source_projection" ||
          evidence.containsRealFoodFacts !== true || evidence.fullTextCopied !== false) {
        add("INVALID_PROVENANCE", envelopePath + "/officialEvidence");
      }
      if (evidence.containsRealUserData !== false) {
        add("REAL_USER_DATA_FORBIDDEN", envelopePath + "/officialEvidence/containsRealUserData");
      }
      if (evidence.fullTextCopied !== false) {
        add("FULL_TEXT_FORBIDDEN", envelopePath + "/officialEvidence/fullTextCopied");
      }
      if (envelope.datasetKind === "religious_ethical") {
        religiousCount += 1;
        if (envelope.lifecycleStatus !== "draft" || evidence.factDisposition !== "CANDIDATE_CLEAR" ||
            envelope.content?.activationStatus !== "not-active") add("RELIGIOUS_NOT_DRAFT", envelopePath);
      }
    }

    const inspectOwnedArray = (key) => {
      const arrayPath = envelopePath + "/" + key;
      const array = envelope[key];
      if (!Array.isArray(array)) {
        add("INVALID_SHAPE", arrayPath);
        releaseDigestEligible = false;
        return null;
      }
      if (array.length !== 1) {
        add("INVALID_PROVENANCE", arrayPath);
        releaseDigestEligible = false;
        return null;
      }
      if (!isRecord(array[0])) {
        add("INVALID_SHAPE", arrayPath + "/0");
        releaseDigestEligible = false;
        return null;
      }
      return array[0];
    };
    const reference = inspectOwnedArray("sourceReferences");
    const snapshot = inspectOwnedArray("sourceSnapshots");
    if (producer !== undefined && reference !== null) {
      for (const [key, expected] of Object.entries({
        referenceId: producer.referenceId, referenceRevision: producer.referenceRevision,
        locator: producer.locator,
      })) if (reference[key] !== expected) add("INVALID_PROVENANCE", envelopePath + "/sourceReferences/0/" + key);
    }
    if (producer !== undefined && snapshot !== null) {
      for (const [key, expected] of Object.entries({
        snapshotId: producer.snapshotId, referenceId: producer.referenceId,
        referenceRevision: producer.referenceRevision, locator: producer.locator,
        contentDigest: producer.snapshotDigest, retrievedAt: "2026-08-29T00:00:00.000Z",
      })) if (snapshot[key] !== expected) add("INVALID_PROVENANCE", envelopePath + "/sourceSnapshots/0/" + key);
    }
    if (releaseDigestEligible) {
      if (release.contentDigest !== releaseDigest(release)) {
        add("INVALID_PROVENANCE", releasePath + "/contentDigest");
      }
    } else {
      packDigestEligible = false;
    }
    releaseDigestEligibility[releaseIndex] = releaseDigestEligible;
  }
  if (reviewedClearCount !== 0) add("ACTIVATION_NOT_ZERO", "/catalog/releases");
  if (religiousCount !== 1) add("RELIGIOUS_NOT_DRAFT", "/catalog/releases");

  let bindingTopology = true;
  const bindings = value.releaseBindings;
  if (bindings.length !== 2) {
    add("INVALID_PROVENANCE", "/releaseBindings");
    bindingTopology = false;
  } else if (!isRecord(bindings[0]) || !isRecord(bindings[1])) {
    for (const [index, binding] of bindings.entries()) {
      if (!isRecord(binding)) add("INVALID_SHAPE", "/releaseBindings/" + index);
    }
    packDigestEligible = false;
    bindingTopology = false;
  } else if (canonicalJson(bindings[0]) === canonicalJson(bindings[1])) {
    add("INVALID_PROVENANCE", "/releaseBindings/1");
    bindingTopology = false;
  } else if (bindings[0].bindingId === bindings[1].bindingId) {
    add("INVALID_PROVENANCE", "/releaseBindings/1/bindingId");
    bindingTopology = false;
  } else if (bindings[0].sourceVersion === bindings[1].sourceVersion) {
    add("INVALID_PROVENANCE", "/releaseBindings/1/sourceVersion");
    bindingTopology = false;
  }
  if (bindings.length === 2 && bindings.every(isRecord) && bindingTopology) {
    for (const [index, binding] of bindings.entries()) {
      const expected = PRODUCERS[index];
      const path = "/releaseBindings/" + index;
      for (const [key, expectedValue] of Object.entries({
        bindingId: expected.bindingId, datasetId: expected.datasetId, datasetKind: expected.datasetKind,
        releaseId: expected.releaseId, releaseRevision: expected.releaseRevision,
        sourceReferenceId: expected.referenceId, sourceReferenceRevision: expected.referenceRevision,
        sourceVersion: expected.sourceVersion,
      })) if (binding[key] !== expectedValue) add("INVALID_PROVENANCE", path + "/" + key);
      const release = value.catalog.releases[index];
      if (releaseDigestEligibility[index] && isRecord(release) &&
          binding.releaseDigest !== releaseDigest(release)) add("INVALID_PROVENANCE", path + "/releaseDigest");
    }
  }

  const windows = value.sourceVersionWindows;
  if (bindingTopology) {
    if (windows.length !== 2) {
      add("INVALID_WINDOW", "/sourceVersionWindows");
    } else if (!isRecord(windows[0]) || !isRecord(windows[1])) {
      for (const [index, window] of windows.entries()) {
        if (!isRecord(window)) add("INVALID_SHAPE", "/sourceVersionWindows/" + index);
      }
      packDigestEligible = false;
    } else if (canonicalJson(windows[0]) === canonicalJson(windows[1])) {
      add("INVALID_WINDOW", "/sourceVersionWindows/1");
    } else {
      for (const [index, window] of windows.entries()) {
        const path = "/sourceVersionWindows/" + index;
        if (window.bindingId !== bindings[index].bindingId) {
          add("INVALID_WINDOW", path + "/bindingId");
          continue;
        }
        const expected = WINDOWS[index];
        if (Object.keys(expected).some((key) => window[key] !== expected[key])) {
          add("INVALID_WINDOW", path);
          continue;
        }
        const current = index === 0
          ? window.effectiveFrom <= asOf && asOf < window.effectiveUntil
          : asOf < window.effectiveFrom;
        if (!current) add("INVALID_WINDOW", path);
      }
    }
  }
  if (packDigestEligible && value.contentDigest !== packDigest(value)) {
    add("INVALID_PROVENANCE", "/contentDigest");
  }
  return finish();
}

const main = () => {
  const argument = process.argv.slice(2).find((value) => value.startsWith("--as-of="));
  const asOf = argument?.slice("--as-of=".length);
  if (asOf !== "2026-08-29T00:00:00.000Z") {
    process.stderr.write("stage09p-m1 source-pack check requires exact --as-of\n");
    process.exitCode = 1;
    return;
  }
  const root = resolve(import.meta.dirname, "..");
  const sourcePack = JSON.parse(readFileSync(resolve(root,
    "data/reference/ingredients/stage09p-m1-household-safety-source-pack.json"), "utf8"));
  const result = checkStage09pM1SourcePackContract(sourcePack, asOf);
  if (!result.ok) {
    process.stderr.write(JSON.stringify(result) + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("stage09p-m1 source-pack check passed\n");
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
