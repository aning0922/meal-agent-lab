// 阶段 09A 聚合链的唯一顺序事实源。聚合器与只读动态证据入口必须共同读取
// 这里的数据，避免审计任务书、报告解析器和真实执行链各维护一份 14 步名单。

export const stage09aSteps = Object.freeze([
  Object.freeze({
    id: 'stage08-check',
    title: 'stage08 全量门禁（workspace 语义不因容器化改变）',
    argv: Object.freeze(['pnpm', 'stage08:check']),
    timeoutMs: 2_400_000
  }),
  Object.freeze({
    id: 'compose-topology',
    title: 'Compose 解析后拓扑静态门禁',
    argv: Object.freeze(['node', 'infra/docker/check-compose-topology.mjs']),
    timeoutMs: 900_000
  }),
  Object.freeze({
    id: 'compose-topology-mutations',
    title: 'Compose 拓扑门禁的变异反例',
    argv: Object.freeze(['node', 'infra/docker/check-compose-topology-mutations.mjs']),
    timeoutMs: 900_000
  }),
  Object.freeze({
    id: 'api-runtime-image',
    title: 'API runtime image 构建 + 依赖/组件扫描',
    argv: Object.freeze(['node', 'infra/docker/check-api-runtime-image.mjs']),
    timeoutMs: 1_800_000,
    forwardsKeepFailure: true
  }),
  Object.freeze({
    id: 'api-runtime-image-mutations',
    title: '镜像扫描门禁的变异反例',
    argv: Object.freeze(['node', 'infra/docker/check-api-runtime-image-mutations.mjs']),
    timeoutMs: 2_700_000
  }),
  Object.freeze({
    id: 'local-test-negatives',
    title: 'Secret 生成/预检/模板扫描反例面',
    argv: Object.freeze(['node', 'infra/docker/check-local-test-negatives.mjs']),
    timeoutMs: 1_800_000
  }),
  Object.freeze({
    id: 'm3b-template-surface-sweep',
    title: 'tracked 模板绝对面普查',
    argv: Object.freeze(['node', 'infra/docker/check-m3b-template-surface-sweep.mjs']),
    timeoutMs: 900_000
  }),
  Object.freeze({
    id: 'm3b-round2-negatives',
    title: 'M3B targeted negative suite',
    argv: Object.freeze(['node', 'infra/docker/check-m3b-round2-negatives.mjs']),
    timeoutMs: 2_700_000
  }),
  Object.freeze({
    id: 'm3b-registry-integrity',
    title: '登记完整性（文档计数 ↔ 已提交数据）',
    argv: Object.freeze(['node', 'infra/docker/check-m3b-registry-integrity.mjs']),
    timeoutMs: 900_000
  }),
  Object.freeze({
    id: 'm3b-signal-windows',
    title: '进程组回归 + 真实信号窗口取证',
    argv: Object.freeze(['node', 'infra/docker/check-m3b-signal-windows.mjs']),
    timeoutMs: 1_800_000
  }),
  Object.freeze({
    id: 'local-test-smoke',
    title: '空 volume 完整链 smoke（含 containment 扫描与隔离）',
    argv: Object.freeze(['node', 'infra/docker/run-local-test-smoke.mjs']),
    timeoutMs: 2_700_000,
    forwardsKeepFailure: true
  }),
  Object.freeze({
    id: 'compose-secret-identity',
    title: 'Compose Secret 容器内 UID/mode 证据',
    argv: Object.freeze(['node', 'infra/docker/probe-compose-secret-identity.mjs']),
    timeoutMs: 1_800_000
  }),
  Object.freeze({
    id: 'lifecycle-drill',
    title: '生命周期演练（空库初始化、health/readiness、持久化重启）',
    argv: Object.freeze(['node', 'infra/docker/run-local-test-lifecycle.mjs']),
    timeoutMs: 2_700_000,
    forwardsKeepFailure: true
  }),
  Object.freeze({
    id: 'restore-drill',
    title: '备份/恢复演练(备份、篡改反例、单事务恢复、授权面一致)',
    argv: Object.freeze(['node', 'infra/docker/run-local-test-restore-drill.mjs']),
    timeoutMs: 2_700_000,
    forwardsKeepFailure: true
  })
])

export const stage09aStepIds = Object.freeze(stage09aSteps.map(({ id }) => id))
