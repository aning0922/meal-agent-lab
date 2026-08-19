/**
 * M5 critical production guards. Every entry is executed by the mutation
 * suite against current production source; names or textual presence alone do
 * not satisfy the registry.
 */
export const m5ProductionGuards = Object.freeze([
  Object.freeze({
    id: 'backup-pre-fork-declaration',
    source: 'infra/docker/backup-local-test.mjs#runBackupCopyWithDeclaredOutput',
    consumers: Object.freeze([
      Object.freeze({
        path: 'infra/docker/backup-local-test.mjs',
        anchor: 'copied = await runBackupCopyWithDeclaredOutput(',
        count: 1
      })
    ])
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
    source: 'infra/docker/m3b-subprocess.mjs#settleCliExitCode',
    consumers: Object.freeze([
      ...[
        'infra/docker/backup-local-test.mjs',
        'infra/docker/restore-local-test.mjs',
        'infra/docker/m4-lifecycle.mjs',
        'infra/docker/run-local-test-smoke.mjs'
      ].map((path) => Object.freeze({ path, anchor: 'await settleCliExitCode(', count: 1 }))
    ])
  }),
  Object.freeze({
    id: 'aggregate-final-signal-delivery',
    source: 'scripts/run-stage09a-check.mjs#settleAggregateProcess',
    consumers: Object.freeze([
      Object.freeze({
        path: 'scripts/run-stage09a-check.mjs',
        anchor: 'const finalExitCode = await settleAggregateProcess(ordinaryExitCode)',
        count: 1
      })
    ])
  }),
  Object.freeze({
    id: 'runtime-image-claim',
    source: 'infra/docker/m5-runtime-settlement.mjs#settleClaimedRuntimeImage'
  }),
  Object.freeze({
    id: 'scratch-capability',
    source: 'infra/docker/api-image-scan.mjs#scratchCapabilityExpectation',
    consumers: Object.freeze([
      Object.freeze({
        path: 'infra/docker/api-image-scan.mjs',
        anchor: 'await settleTrackedRuntimeProbe({',
        count: 2
      })
    ])
  }),
  Object.freeze({
    id: 'runtime-scratch-final-settlement',
    source: 'infra/docker/api-image-scan.mjs#settleTrackedRuntimeProbe',
    consumers: Object.freeze([
      Object.freeze({
        path: 'infra/docker/api-image-scan.mjs',
        anchor: 'await settleTrackedRuntimeProbe({',
        count: 2
      })
    ])
  })
])
