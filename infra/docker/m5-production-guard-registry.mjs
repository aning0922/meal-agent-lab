/**
 * M5 critical production guards. Every entry is executed by the mutation
 * suite against current production source; names or textual presence alone do
 * not satisfy the registry.
 */
export const m5ProductionGuards = Object.freeze([
  Object.freeze({
    id: 'backup-pre-fork-runtime',
    source: 'infra/docker/m5-evidence-protocol.mjs#runWithDeclaredOwnedTreeOutputs',
    consumers: Object.freeze([
      Object.freeze({
        path: 'infra/docker/backup-local-test.mjs',
        callee: Object.freeze({
          path: 'infra/docker/m5-evidence-protocol.mjs',
          name: 'runWithDeclaredOwnedTreeOutputs'
        }),
        placement: Object.freeze({
          kind: 'function-path-direct',
          path: Object.freeze(['beforeRemove', 'performBackup'])
        }),
        count: 1
      }),
      Object.freeze({
        path: 'infra/docker/check-api-runtime-image.mjs',
        callee: Object.freeze({
          path: 'infra/docker/m5-evidence-protocol.mjs',
          name: 'runWithDeclaredOwnedTreeOutputs'
        }),
        placement: Object.freeze({
          kind: 'function-path-direct',
          path: Object.freeze(['main'])
        }),
        count: 1
      }),
      Object.freeze({
        path: 'infra/docker/check-api-runtime-image-mutations.mjs',
        callee: Object.freeze({
          path: 'infra/docker/m5-evidence-protocol.mjs',
          name: 'runWithDeclaredOwnedTreeOutputs'
        }),
        placement: Object.freeze({
          kind: 'function-path-direct',
          path: Object.freeze(['buildAndScan'])
        }),
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
    source: 'infra/docker/m3b-subprocess.mjs#runSignalSettledCli',
    consumers: Object.freeze([
      ...[
        'infra/docker/backup-local-test.mjs',
        'infra/docker/restore-local-test.mjs',
        'infra/docker/run-local-test-smoke.mjs',
        'infra/docker/run-local-test-lifecycle.mjs',
        'infra/docker/run-local-test-restore-drill.mjs'
      ].map((path) => Object.freeze({
        path,
        callee: Object.freeze({
          path: 'infra/docker/m3b-subprocess.mjs',
          name: 'runSignalSettledCli'
        }),
        placement: Object.freeze({ kind: 'main-guard-direct' }),
        count: 1
      }))
    ])
  }),
  Object.freeze({
    id: 'structured-stage09a-core',
    source: 'scripts/run-stage09a-check.mjs#runStage09aCheck',
    consumers: Object.freeze([
      Object.freeze({
        path: 'scripts/run-stage09a-check.mjs',
        callee: Object.freeze({
          path: 'scripts/run-stage09a-check.mjs',
          name: 'runStage09aCheck'
        }),
        placement: Object.freeze({
          kind: 'function-path-direct',
          path: Object.freeze(['runStage09aCheckForAudit'])
        }),
        count: 1
      }),
      Object.freeze({
        path: 'scripts/run-stage09a-check.mjs',
        callee: Object.freeze({
          path: 'scripts/run-stage09a-check.mjs',
          name: 'runStage09aCheck'
        }),
        placement: Object.freeze({ kind: 'main-guard-binding', binding: 'outcome' }),
        count: 1
      })
    ])
  }),
  Object.freeze({
    id: 'structured-stage09a-audit-receipt',
    source: 'scripts/run-stage09a-check.mjs#runStage09aCheckForAudit',
    consumers: Object.freeze([
      Object.freeze({
        path: 'scripts/run-stage09a-audit-b.mjs',
        callee: Object.freeze({
          path: 'scripts/run-stage09a-check.mjs',
          name: 'runStage09aCheckForAudit'
        }),
        placement: Object.freeze({
          kind: 'function-path-awaited',
          path: Object.freeze(['runStage09aAuditB'])
        }),
        count: 1
      })
    ])
  }),
  Object.freeze({
    id: 'structured-stage09a-report-receipt',
    source: 'scripts/stage09a-audit-b.mjs#createStage09aAuditBReportFromReceipt',
    consumers: Object.freeze([
      Object.freeze({
        path: 'scripts/run-stage09a-audit-b.mjs',
        callee: Object.freeze({
          path: 'scripts/stage09a-audit-b.mjs',
          name: 'createStage09aAuditBReportFromReceipt'
        }),
        placement: Object.freeze({
          kind: 'function-path-direct',
          path: Object.freeze(['runStage09aAuditB'])
        }),
        count: 1
      })
    ])
  }),
  Object.freeze({
    id: 'structured-stage09a-receipt-projector',
    source: 'scripts/run-stage09a-check.mjs#readStage09aAuditRunReceipt',
    consumers: Object.freeze([
      Object.freeze({
        path: 'scripts/stage09a-audit-b.mjs',
        callee: Object.freeze({
          path: 'scripts/run-stage09a-check.mjs',
          name: 'readStage09aAuditRunReceipt'
        }),
        placement: Object.freeze({
          kind: 'function-path-direct',
          path: Object.freeze(['createStage09aAuditBReportFromReceipt'])
        }),
        count: 1
      })
    ])
  }),
  Object.freeze({
    id: 'structured-stage09a-report-builder',
    source: 'scripts/stage09a-audit-b.mjs#createStage09aAuditBReport',
    consumers: Object.freeze([
      Object.freeze({
        path: 'scripts/stage09a-audit-b.mjs',
        callee: Object.freeze({
          path: 'scripts/stage09a-audit-b.mjs',
          name: 'createStage09aAuditBReport'
        }),
        placement: Object.freeze({
          kind: 'function-path-direct',
          path: Object.freeze(['createStage09aAuditBReportFromReceipt'])
        }),
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
        callee: Object.freeze({
          path: 'infra/docker/api-image-scan.mjs',
          name: 'scratchCapabilityExpectation'
        }),
        placement: Object.freeze({
          kind: 'function-path-direct',
          path: Object.freeze(['scanImage'])
        }),
        count: 4
      })
    ])
  }),
  Object.freeze({
    id: 'runtime-scratch-final-settlement',
    source: 'infra/docker/api-image-scan.mjs#settleTrackedRuntimeProbe',
    consumers: Object.freeze([
      Object.freeze({
        path: 'infra/docker/api-image-scan.mjs',
        callee: Object.freeze({
          path: 'infra/docker/api-image-scan.mjs',
          name: 'settleTrackedRuntimeProbe'
        }),
        placement: Object.freeze({
          kind: 'function-path-direct',
          path: Object.freeze(['scanImage'])
        }),
        count: 2
      })
    ])
  })
])

// 这些生产 CLI 必须保留自然 exitCode / 同名 signal settlement；任何一处重新
// 获得 `process.exit` 能力都会绕过 cleanup-before-settlement。名单本身是提交数据；
// mutation suite 另从目标声明的生产引用与 `stage09a:*` package scripts 反向发现入口，
// 再与本表核对，防止“新入口和测试期望同时忘记登记”。
export const m5CliEntrypoints = Object.freeze([
  ...[
    'infra/docker/backup-local-test.mjs',
    'infra/docker/restore-local-test.mjs',
    'infra/docker/run-local-test-smoke.mjs',
    'infra/docker/run-local-test-lifecycle.mjs',
    'infra/docker/run-local-test-restore-drill.mjs'
  ].map((path) => Object.freeze({ path, settlement: 'signal-settled-cli' })),
  Object.freeze({
    path: 'scripts/run-stage09a-check.mjs',
    settlement: 'structured-stage09a-core'
  }),
  Object.freeze({
    path: 'scripts/run-stage09a-audit-b.mjs',
    settlement: 'structured-stage09a-audit'
  })
])

export const m5ProtectedEntrypoints = Object.freeze(
  m5CliEntrypoints.map(({ path }) => path)
)

// 共享库不是 CLI entrypoint，但同样不得取得能绕过调用方 settlement 的退出能力。
export const m5ProtectedModules = Object.freeze([
  'infra/docker/m4-lifecycle.mjs'
])
