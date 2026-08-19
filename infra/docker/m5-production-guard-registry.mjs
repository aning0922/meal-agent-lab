/**
 * M5 critical production guards. Every entry is executed by the mutation
 * suite against current production source; names or textual presence alone do
 * not satisfy the registry.
 */
export const m5ProductionGuards = Object.freeze([
  Object.freeze({
    id: 'backup-pre-fork-declaration',
    source: 'infra/docker/m5-evidence-protocol.mjs',
    consumer: 'infra/docker/backup-local-test.mjs#performBackup'
  }),
  Object.freeze({
    id: 'publication-link-count',
    source: 'infra/docker/m5-evidence-protocol.mjs#writeExclusiveEvidenceFile'
  }),
  Object.freeze({
    id: 'cleanup-memoization',
    source: 'infra/docker/m3b-subprocess.mjs#createSignalSafeCleanup'
  }),
  Object.freeze({
    id: 'cleanup-signal-delivery-barrier',
    source: 'infra/docker/m3b-subprocess.mjs#terminationSignalAfterCleanupSettlement'
  }),
  Object.freeze({
    id: 'runtime-image-claim',
    source: 'infra/docker/m5-runtime-settlement.mjs#settleClaimedRuntimeImage'
  }),
  Object.freeze({
    id: 'scratch-capability',
    source: 'infra/docker/api-image-scan.mjs#scratchCapabilityExpectation'
  })
])
