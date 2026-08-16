// M5 关键 guard 的不可同步缩水登记表。
//
// 每个 needle 都是生产调用点本身，不是测试夹具里的同名说明。scripts 测试按文件
// 和精确出现次数核对；删除/绕过关键调用不能靠同时改一个总数继续绿。新增 guard
// 必须新增稳定 ID，而不是复用或重命名历史 ID。
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
    needle: 'evidence.name !== composeProjectName',
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
    occurrences: 3
  },
  {
    id: 'runtime.mutation-build-claim-v1',
    file: 'infra/docker/check-api-runtime-image-mutations.mjs',
    needle: 'expectedClaimToken: claimToken',
    occurrences: 3
  },
  {
    id: 'runtime.scratch-cleanup-by-id-v1',
    file: 'infra/docker/check-api-runtime-image.mjs',
    needle: 'const target = claim.id ?? claim.name',
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
    occurrences: 1
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
    needle: "listed = await run(['pg_restore', '--list']",
    occurrences: 1
  },
  {
    id: 'process-group.unknown-probe-failure-v1',
    file: 'infra/docker/m3b-subprocess.mjs',
    needle: "if (error?.code === 'EPERM') return true",
    occurrences: 1
  }
])
