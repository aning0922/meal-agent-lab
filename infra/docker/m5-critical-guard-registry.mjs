// M5 关键 guard 的生产调用点索引。
//
// 这份表只负责发现调用点/文档的机械漂移，**不是**安全属性或 mutation 判别力的
// 证明。每项语义必须由同一门禁中的动态反例、纯函数反例或专用 mutation suite
// 独立看守；只让 needle 数量保持不变不代表实现正确。新增 guard 必须新增稳定 ID，
// 而不是复用或重命名历史 ID。
export const m5CriticalGuardRegistry = Object.freeze([
  {
    id: 'compose.root.closed-v1',
    file: 'infra/docker/compose-topology-evidence.mjs',
    needle: "!sameKeys(value, [\n      'name',\n      'services',",
    occurrences: 1
  },
  {
    id: 'compose.all-profiles-v1',
    file: 'infra/docker/check-compose-topology.mjs',
    needle: "runCompose(['--profile', '*', 'config', '--format', 'json'])",
    occurrences: 1
  },
  {
    id: 'compose.project-per-secret-probe-v1',
    file: 'infra/docker/check-compose-topology.mjs',
    needle: '...Object.values(probe.secrets ?? {}).map((secret) => secret.name)',
    occurrences: 1
  },
  {
    id: 'compose.security-opt-exact-v1',
    file: 'infra/docker/check-compose-topology.mjs',
    needle: "!same(securityOpt, ['no-new-privileges:true'])",
    occurrences: 1
  },
  {
    id: 'runtime.positive-build-claim-v1',
    file: 'infra/docker/check-api-runtime-image.mjs',
    needle: 'expectedClaimToken: cleanupState.imageClaimToken',
    occurrences: 2
  },
  {
    id: 'runtime.mutation-build-claim-v1',
    file: 'infra/docker/check-api-runtime-image-mutations.mjs',
    needle: 'expectedClaimToken: claimToken',
    occurrences: 1
  },
  {
    id: 'runtime.content-addressed-rootfs-v1',
    file: 'infra/docker/api-image-scan.mjs',
    needle: '{ materializeRoot: extractedRoot, runStrict }',
    occurrences: 1
  },
  {
    id: 'm4.oneoff-retain-nonzero-id-v1',
    file: 'infra/docker/m4-lifecycle.mjs',
    needle: 'entry.id = inspected.id',
    occurrences: 1
  },
  {
    id: 'm4.stack-one-shot-fresh-v1',
    file: 'infra/docker/m4-lifecycle.mjs',
    needle: 'current.State?.StartedAt === baseline.State?.StartedAt',
    occurrences: 2
  },
  {
    id: 'm4.graceful-start-binding-v1',
    file: 'infra/docker/run-local-test-lifecycle.mjs',
    needle: "const startedApi = stack.getServiceEvidence('api')",
    occurrences: 1
  },
  {
    id: 'backup.list-structure-v1',
    file: 'infra/docker/backup-local-test.mjs',
    needle: 'parsePgRestoreListEvidence(listed.stdout)',
    occurrences: 1
  },
  {
    id: 'backup.source-digest-after-list-v1',
    file: 'infra/docker/backup-local-test.mjs',
    needle: 'source.identity.sha256 !== digestMatch[1]',
    occurrences: 1
  },
  {
    id: 'backup.final-byte-binding-v1',
    file: 'infra/docker/backup-local-test.mjs',
    needle: 'verifyPublishedFileEvidence(publishedIdentity, publishedDumpBytes)',
    occurrences: 2
  },
  {
    id: 'restore.list-before-database-v1',
    file: 'infra/docker/restore-local-test.mjs',
    needle: "listed = await run(['pg_restore', '--create', '--list']",
    occurrences: 1
  },
  {
    id: 'process-group.unknown-probe-failure-v1',
    file: 'infra/docker/m3b-subprocess.mjs',
    needle: 'export const probeProcessGroup = (pgid, kill = process.kill)',
    occurrences: 1
  }
])
