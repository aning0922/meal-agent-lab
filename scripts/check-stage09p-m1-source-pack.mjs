import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const POSITIVE_KINDS = new Set([
  "explicit_ingredient",
  "explicit_contains",
  "explicit_may_contain",
  "explicit_shared_line",
  "explicit_shared_equipment",
]);
const UNKNOWN_KINDS = new Set([
  "warning_absent",
  "negative_free_from_claim",
  "compound_unexpanded",
  "extraction_uncertain",
  "outside_prepackaged_scope",
]);

const deepFreeze = (value) => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
};

export function classifySourceInventoryProjection(projectionKind) {
  if (!POSITIVE_KINDS.has(projectionKind) && !UNKNOWN_KINDS.has(projectionKind)) {
    return deepFreeze({
      ok: false,
      issue: { code: "UNKNOWN_PROJECTION_KIND", path: "/projectionKind" },
    });
  }
  return deepFreeze({
    schemaVersion: 1,
    projectionKind,
    factDisposition: POSITIVE_KINDS.has(projectionKind)
      ? "POSITIVE_BLOCK"
      : "UNKNOWN_BLOCK",
  });
}

const issueOrder = Object.freeze([
  "INVALID_SHAPE",
  "INVALID_CONTEXT",
  "INVALID_LIFECYCLE",
  "ACTIVATION_NOT_ZERO",
  "LICENSE_NOT_PENDING",
  "USAGE_NOT_PENDING",
  "INVALID_WINDOW",
  "INVALID_SOURCE_CLASS",
  "INVALID_PROVENANCE",
  "FULL_TEXT_FORBIDDEN",
  "REAL_USER_DATA_FORBIDDEN",
  "RELIGIOUS_NOT_DRAFT",
]);

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const sortedIssues = (issues) =>
  deepFreeze(
    [...new Map(issues.map((issue) => [issue.code + "\u0000" + issue.path, issue])).values()]
      .sort((left, right) => {
        const code =
          issueOrder.indexOf(left.code) - issueOrder.indexOf(right.code);
        return code !== 0 ? code : compareUtf8(left.path, right.path);
      }),
  );

const isRecord = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export function checkStage09pM1SourcePackContract(value, asOf) {
  const issues = [];
  const add = (code, path) => issues.push(deepFreeze({ code, path }));
  if (!isRecord(value)) {
    add("INVALID_SHAPE", "");
    return deepFreeze({ ok: false, issues: sortedIssues(issues) });
  }
  if (
    value.schemaVersion !== 2 ||
    value.packId !== "stage09p:m1:cn-household-safety" ||
    !Number.isSafeInteger(value.packRevision) ||
    value.packRevision < 1
  ) {
    add("INVALID_SHAPE", "/schemaVersion");
  }
  if (
    value.country !== "CN" ||
    value.foodRuleRegion !== "CN" ||
    value.ruleLanguage !== "zh-CN"
  ) {
    add("INVALID_CONTEXT", "/country");
  }
  if (value.lifecycleStatus !== "draft") add("INVALID_LIFECYCLE", "/lifecycleStatus");
  if (
    !Array.isArray(value.releaseBindings) ||
    !Array.isArray(value.sourceVersionWindows) ||
    !Array.isArray(value.mappingReviews) ||
    !isRecord(value.catalog) ||
    !Array.isArray(value.catalog.releases) ||
    !Array.isArray(value.catalog.hardMappings)
  ) {
    add("INVALID_SHAPE", "/catalog");
    return deepFreeze({ ok: false, issues: sortedIssues(issues) });
  }
  if (value.catalog.hardMappings.length !== 0 || value.mappingReviews.length !== 0) {
    add("ACTIVATION_NOT_ZERO", "/catalog/hardMappings");
  }
  let reviewedClearCount = 0;
  let religiousCount = 0;
  for (let releaseIndex = 0; releaseIndex < value.catalog.releases.length; releaseIndex += 1) {
    const release = value.catalog.releases[releaseIndex];
    if (!isRecord(release) || !Array.isArray(release.envelopes)) {
      add("INVALID_SHAPE", "/catalog/releases/" + releaseIndex);
      continue;
    }
    for (let envelopeIndex = 0; envelopeIndex < release.envelopes.length; envelopeIndex += 1) {
      const envelope = release.envelopes[envelopeIndex];
      const path = "/catalog/releases/" + releaseIndex + "/envelopes/" + envelopeIndex;
      if (!isRecord(envelope) || !isRecord(envelope.officialEvidence)) {
        add("INVALID_SOURCE_CLASS", path + "/officialEvidence");
        continue;
      }
      if (Object.hasOwn(envelope, "syntheticEvidence")) {
        add("INVALID_SOURCE_CLASS", path + "/syntheticEvidence");
      }
      if (envelope.lifecycleStatus !== "draft" && envelope.lifecycleStatus !== "under_review") {
        add("INVALID_LIFECYCLE", path + "/lifecycleStatus");
      }
      if (envelope.licenseStatus !== "pending") {
        add("LICENSE_NOT_PENDING", path + "/licenseStatus");
      }
      if (envelope.officialEvidence.usageStatus !== "pending") {
        add("USAGE_NOT_PENDING", path + "/officialEvidence/usageStatus");
      }
      if (envelope.officialEvidence.factDisposition === "REVIEWED_CLEAR") {
        reviewedClearCount += 1;
      }
      if (
        envelope.officialEvidence.classification !== "official_source_projection" ||
        envelope.officialEvidence.containsRealFoodFacts !== true ||
        envelope.officialEvidence.fullTextCopied !== false
      ) {
        add("INVALID_PROVENANCE", path + "/officialEvidence");
      }
      if (envelope.officialEvidence.containsRealUserData !== false) {
        add("REAL_USER_DATA_FORBIDDEN", path + "/officialEvidence/containsRealUserData");
      }
      if (envelope.officialEvidence.fullTextCopied !== false) {
        add("FULL_TEXT_FORBIDDEN", path + "/officialEvidence/fullTextCopied");
      }
      if (!Array.isArray(envelope.sourceReferences) || envelope.sourceReferences.length !== 1) {
        add("INVALID_PROVENANCE", path + "/sourceReferences");
      } else {
        const source = envelope.sourceReferences[0];
        if (
          !isRecord(source) ||
          typeof source.locator !== "string" ||
          !source.locator.startsWith("https://")
        ) {
          add("INVALID_PROVENANCE", path + "/sourceReferences/0/locator");
        }
      }
      if (envelope.datasetKind === "religious_ethical") {
        religiousCount += 1;
        if (
          envelope.lifecycleStatus !== "draft" ||
          envelope.officialEvidence.factDisposition !== "CANDIDATE_CLEAR" ||
          envelope.content?.activationStatus !== "not-active"
        ) {
          add("RELIGIOUS_NOT_DRAFT", path);
        }
      }
    }
  }
  if (reviewedClearCount !== 0) add("ACTIVATION_NOT_ZERO", "/catalog/releases");
  if (religiousCount !== 1) add("RELIGIOUS_NOT_DRAFT", "/catalog/releases");
  const bindingsByVersion = new Map(
    value.releaseBindings.map((binding) => [binding.sourceVersion, binding]),
  );
  for (const sourceVersion of ["2011", "2025"]) {
    const binding = bindingsByVersion.get(sourceVersion);
    if (!isRecord(binding)) {
      add("INVALID_WINDOW", "/releaseBindings");
      continue;
    }
    const windows = value.sourceVersionWindows.filter(
      (window) => window.bindingId === binding.bindingId,
    );
    if (windows.length !== 1) {
      add("INVALID_WINDOW", "/sourceVersionWindows");
      continue;
    }
    const window = windows[0];
    const valid =
      sourceVersion === "2011"
        ? window.jurisdictionTimeZone === "Asia/Shanghai" &&
          window.sourceCivilEffectiveDate === "2012-04-20" &&
          window.effectiveFrom === "2012-04-19T16:00:00.000Z" &&
          window.effectiveUntil === "2027-03-15T16:00:00.000Z" &&
          window.effectiveFrom <= asOf &&
          asOf < window.effectiveUntil
        : window.jurisdictionTimeZone === "Asia/Shanghai" &&
          window.sourceCivilEffectiveDate === "2027-03-16" &&
          window.effectiveFrom === "2027-03-15T16:00:00.000Z" &&
          window.effectiveUntil === null &&
          asOf < window.effectiveFrom;
    if (!valid) add("INVALID_WINDOW", "/sourceVersionWindows/" + value.sourceVersionWindows.indexOf(window));
  }
  const identity2011 = bindingsByVersion.get("2011")?.datasetId;
  const identity2025 = bindingsByVersion.get("2025")?.datasetId;
  if (
    typeof identity2011 !== "string" ||
    typeof identity2025 !== "string" ||
    identity2011 === identity2025
  ) {
    add("INVALID_PROVENANCE", "/releaseBindings");
  }
  const finalIssues = sortedIssues(issues);
  return finalIssues.length === 0
    ? deepFreeze({ ok: true, issues: [] })
    : deepFreeze({ ok: false, issues: finalIssues });
}

const main = () => {
  const asOfArgument = process.argv.slice(2).find((value) => value.startsWith("--as-of="));
  const asOf = asOfArgument?.slice("--as-of=".length);
  if (asOf !== "2026-08-29T00:00:00.000Z") {
    process.stderr.write("stage09p-m1 source-pack check requires exact --as-of\n");
    process.exitCode = 1;
    return;
  }
  const root = resolve(import.meta.dirname, "..");
  const sourcePack = JSON.parse(
    readFileSync(
      resolve(
        root,
        "data/reference/ingredients/stage09p-m1-household-safety-source-pack.json",
      ),
      "utf8",
    ),
  );
  const result = checkStage09pM1SourcePackContract(sourcePack, asOf);
  if (!result.ok) {
    process.stderr.write(JSON.stringify(result) + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("stage09p-m1 source-pack check passed\n");
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
