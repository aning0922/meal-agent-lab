#!/usr/bin/env node
//
// 阶段 09A / M2B：local-test Compose 拓扑的静态门禁。
//
//   node infra/docker/check-compose-topology.mjs
//
// 断言对象是 `docker compose config` **解析后**的配置，而不是 YAML 源文本：
// anchor、profile、变量插值和默认值都已经展开，因此这里检查的就是 Compose 真正
// 会交给 Docker 的东西。
//
// Docker CLI 或 git 缺失、或它们非零退出时，本脚本一律以「缺少前置工具 / 无法
// 判定」失败退出，不降级成纯文本检查后宣称通过（阶段 09A 验收门禁 #11）。
//
// 覆盖范围是 M2B 拓扑与 M3B/M4 受控扩展：十四个服务的 entrypoint/command
// 逐项固定、镜像固定、
// 端口发布、网络隔离、容器权限、挂载、一次性任务的显式调用与顺序、凭据的最小
// 权限与 secret↔环境变量精确映射，以及数据库 identity 不可被环境变量改写。
// 运行期动态门禁（非 loopback 访问、镜像/日志 Secret 扫描）属于 M3 与 M5。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ambientGitRepositoryViewOverrides,
  assertCanonicalGitRepositoryView,
  canonicalGitArguments
} from './local-test-secrets-contract.mjs'
import {
  isResolvedServiceRecord,
  parseResolvedComposeDocument,
  resolvedDependencyProjection,
  resolvedHealthcheckProjection
} from './compose-topology-evidence.mjs'
import { createSecretScrubber } from './m3b-safe-output.mjs'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const repositoryRoot = resolve(composeDirectory, '..', '..')
const diagnosticScrubber = createSecretScrubber()

const safeDiagnostic = (message) => {
  try {
    writeSync(2, Buffer.from(message, 'utf8'))
    return true
  } catch {
    return false
  }
}

// 生产调用**零参数**，检查的永远是 tracked 的 compose.local-test.yaml。
// `--compose-file <path>` 是 M3B 反例专用的受限 seam：它让变异反例改写**临时
// 副本**而不是 tracked 文件（tracked 文件因此没有任何改写窗口）。副本必须是
// 系统 tmpdir 下本套件独占目录里的固定文件名；Compose 另显式固定
// `--project-directory` 为 infra/docker，所以相对资产仍按生产位置解析。
const parseComposeFileArgument = (argv) => {
  if (argv.length === 0) {
    return resolve(composeDirectory, 'compose.local-test.yaml')
  }
  if (argv.length !== 2 || argv[0] !== '--compose-file') {
    safeDiagnostic('usage: check-compose-topology.mjs [--compose-file <owned temporary path>]\n')
    process.exit(2)
  }
  const candidate = resolve(argv[1])
  const candidateDirectory = dirname(candidate)
  if (
    dirname(candidateDirectory) !== resolve(tmpdir()) ||
    !basename(candidateDirectory).startsWith('meal-agent-compose-topology-') ||
    basename(candidate) !== 'compose.local-test.yaml'
  ) {
    safeDiagnostic(
      '--compose-file must name the fixed file inside an owned system-temporary directory\n'
    )
    process.exit(2)
  }
  return candidate
}
const composeFile = parseComposeFileArgument(process.argv.slice(2))

// 与 compose.local-test.yaml 逐字相同的固定镜像。digest 由
// `docker buildx imagetools inspect` 解析真实仓库获得，不是猜测值。
const pinnedPostgresImage =
  'docker.io/library/postgres:18.4-bookworm@' +
  'sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
const apiImage = 'meal-agent-api:stage09a-local-test'
const apiDockerfile = 'services/api/Dockerfile'
const apiContainerPort = 3000
const apiHostIp = '127.0.0.1'
const apiUser = '10001:10001'
const postgresUser = '999:999'
const bootstrapProfile = 'bootstrap'
const composeProjectName = 'meal-agent-local-test'
// M2B 固定数据库 identity。可配置能力归 M3B：届时由统一配置 schema 先校验
// ^meal_agent(_[a-z0-9_]+)?$ 与 63 字节上限，再同时生成 URL 与 Compose 参数。
const databaseName = 'meal_agent'

// M3A 固定的部署身份。它们在 config.ts 里**没有默认值**，因此 Compose 必须显式
// 声明；三者同时成立才允许 fake adapter，任何一项被删除或改成 staging /
// production / private-network / public 都必须让本门禁失败。
const pinnedDeployment = {
  NODE_ENV: 'development',
  DEPLOYMENT_STAGE: 'local-test',
  DEPLOYMENT_EXPOSURE: 'loopback',
  WECHAT_ADAPTER: 'fake'
}
// 这套拓扑使用合成身份，因此任何服务都不得携带真实微信凭据。
const forbiddenWechatCredentialKeys = ['WECHAT_APP_ID', 'WECHAT_APP_SECRET']

const bootstrapEntrypoint = ['/opt/meal-agent/bootstrap/bootstrap.sh']
const bootstrapMount = {
  type: 'bind',
  source: resolve(composeDirectory, 'postgres'),
  target: '/opt/meal-agent/bootstrap',
  read_only: true
}
// bootstrap.sh handoff 固定按 `${script_directory}/../../../services/api/
// migrations/0000_stage_06.sql` 解析冻结 0000 的磁盘 sha256；script_directory 是
// /opt/meal-agent/bootstrap，因此容器内绝对路径恰好是下面这一个**文件**。
const handoffStage06Mount = {
  type: 'bind',
  source: resolve(repositoryRoot, 'services/api/migrations/0000_stage_06.sql'),
  target: '/services/api/migrations/0000_stage_06.sql',
  read_only: true
}
// 数据库数据卷必须是**可写**的 named volume：把它设成只读会让 PostgreSQL 起不来，
// 因此这里按显式的 read_only: false 比较，而不是「没写 read_only 就算过」。
const postgresDataMount = {
  type: 'volume',
  source: 'postgres-data',
  target: '/var/lib/postgresql',
  read_only: false
}

// 只读根文件系统下的可写临时目录。逐服务固定：删、增、改任一项都必须失败。
const defaultTmpfs = ['/tmp:mode=1777,size=16m']
const postgresTmpfs = [
  '/tmp:mode=1777,size=64m',
  // PostgreSQL 的 unix socket 目录，必须归 postgres(999) 且不对外开放。
  '/var/run/postgresql:mode=0700,uid=999,gid=999,size=16m'
]

// 顶层 secret 的 backing file 身份：secret name → 期望文件名。
// 八项里七项与 secret 同名，只有 pgpass 因为 libpq 的惯用扩展名而不同。
const expectedSecretFiles = {
  postgres_superuser_password: 'postgres_superuser_password',
  postgres_admin_pgpass: 'postgres_admin.pgpass',
  meal_agent_migration_password: 'meal_agent_migration_password',
  meal_agent_runtime_password: 'meal_agent_runtime_password',
  meal_agent_backup_password: 'meal_agent_backup_password',
  meal_agent_admin_database_url: 'meal_agent_admin_database_url',
  meal_agent_migration_database_url: 'meal_agent_migration_database_url',
  meal_agent_runtime_database_url: 'meal_agent_runtime_database_url'
}
const expectedNetworkKeys = ['edge', 'internal']
const secretVolumes = {
  postgres_superuser_password: 'postgres-superuser-secret',
  postgres_admin_pgpass: 'postgres-admin-pgpass-secret',
  meal_agent_migration_password: 'migration-password-secret',
  meal_agent_runtime_password: 'runtime-password-secret',
  meal_agent_backup_password: 'backup-password-secret',
  meal_agent_admin_database_url: 'admin-url-secret',
  meal_agent_migration_database_url: 'migration-url-secret',
  meal_agent_runtime_database_url: 'runtime-url-secret'
}
const expectedVolumeKeys = [
  'admin-url-secret',
  'backup-password-secret',
  'backup-transfer',
  'migration-password-secret',
  'migration-url-secret',
  'postgres-admin-pgpass-secret',
  'postgres-data',
  'postgres-superuser-secret',
  'runtime-password-secret',
  'runtime-url-secret'
]
// Compose 把相对的 secret 目录按 compose 文件所在目录解析。
// `${VAR:-./secrets}` 对**未设置与空字符串一视同仁**，都回落到 ./secrets——
// 空字符串绝不能被当成「目录就是 compose 目录本身」。
const secretsDirectoryFor = (override) =>
  resolve(
    composeDirectory,
    override === undefined || override === '' ? './secrets' : override
  )

const secretPath = (name) => `/run/secrets/${name}/value`
const secretVolumeMount = (name, { target, readOnly = true } = {}) => ({
  type: 'volume',
  source: secretVolumes[name],
  target: target ?? `/run/secrets/${name}`,
  read_only: readOnly
})
const volumeMount = (source, target, readOnly = false) => ({
  type: 'volume',
  source,
  target,
  read_only: readOnly
})
const pgpassMount = secretVolumeMount('postgres_admin_pgpass')
const pgClusterEnvironment = {
  PGHOST: 'postgres',
  PGPORT: '5432',
  PGUSER: 'postgres',
  PGDATABASE: 'postgres',
  PGCONNECT_TIMEOUT: '10',
  PGPASSFILE: secretPath('postgres_admin_pgpass')
}
const psqlSecretEnvironment = { PGPASSFILE: secretPath('postgres_admin_pgpass') }

const materializerCommand = `umask 077
chmod 0700 /transfer
chown 999:999 /transfer
materialize() {
  source="/run/source-secrets/$$1"
  target="/materialized/$$1/value"
  owner="$$2"
  temporary="$\${target}.new.$$"
  install -m 0600 "$$source" "$$temporary"
  chown "$$owner:$$owner" "$$temporary"
  mv -f "$$temporary" "$$target"
  test "$$(stat -c '%u:%g:%a:%F:%h' "$$target")" = "$$owner:$$owner:600:regular file:1"
}
materialize postgres_superuser_password 999
materialize postgres_admin_pgpass 999
materialize meal_agent_migration_password 999
materialize meal_agent_runtime_password 999
materialize meal_agent_backup_password 999
materialize meal_agent_admin_database_url 10001
materialize meal_agent_migration_database_url 10001
materialize meal_agent_runtime_database_url 10001
`
const materializerMounts = Object.entries(secretVolumes).map(([name, source]) =>
  volumeMount(source, `/materialized/${name}`)
)
materializerMounts.push(volumeMount('backup-transfer', '/transfer'))
const materializerSecrets = Object.keys(expectedSecretFiles).map((name) => ({
  source: name,
  target: `/run/source-secrets/${name}`
}))

// 每个服务的**逐项**预期。`secretEnv` 把实际消费文件与
// 独立 materialized volume 绑在一起；只有 materializer 本身可见原始
// file-backed Compose secrets。
const expectations = {
  'secret-materializer': {
    image: pinnedPostgresImage,
    user: '0:0',
    profiles: [],
    entrypoint: ['bash', '-euc'],
    command: [materializerCommand],
    networkMode: 'none',
    networks: [],
    capAdd: ['CHOWN', 'DAC_READ_SEARCH'],
    allowRoot: true,
    mounts: materializerMounts,
    secrets: materializerSecrets,
    tmpfs: [],
    publishes: false,
    secretEnv: {},
    environment: {},
    dependsOn: {}
  },
  postgres: {
    image: pinnedPostgresImage,
    user: postgresUser,
    profiles: [],
    entrypoint: null,
    command: null,
    networks: ['internal'],
    mounts: [postgresDataMount, secretVolumeMount('postgres_superuser_password')],
    secrets: [],
    tmpfs: postgresTmpfs,
    publishes: false,
    secretEnv: {
      POSTGRES_PASSWORD_FILE: secretPath('postgres_superuser_password')
    },
    environment: {
      POSTGRES_PASSWORD_FILE: secretPath('postgres_superuser_password'),
      POSTGRES_HOST_AUTH_METHOD: 'scram-sha-256',
      POSTGRES_INITDB_ARGS: '--auth-host=scram-sha-256 --auth-local=scram-sha-256'
    },
    dependsOn: { 'secret-materializer': 'service_completed_successfully' }
  },
  'bootstrap-cluster': {
    image: pinnedPostgresImage,
    user: postgresUser,
    profiles: [bootstrapProfile],
    entrypoint: bootstrapEntrypoint,
    command: ['cluster', '--maintenance-db', 'postgres'],
    networks: ['internal'],
    mounts: [bootstrapMount, pgpassMount],
    secrets: [],
    tmpfs: defaultTmpfs,
    publishes: false,
    secretEnv: psqlSecretEnvironment,
    environment: pgClusterEnvironment,
    dependsOn: { postgres: 'service_healthy' }
  },
  'bootstrap-logins': {
    image: pinnedPostgresImage,
    user: postgresUser,
    profiles: [bootstrapProfile],
    entrypoint: bootstrapEntrypoint,
    command: ['logins', '--maintenance-db', 'postgres'],
    networks: ['internal'],
    mounts: [
      bootstrapMount,
      pgpassMount,
      secretVolumeMount('meal_agent_migration_password'),
      secretVolumeMount('meal_agent_runtime_password'),
      secretVolumeMount('meal_agent_backup_password')
    ],
    secrets: [],
    tmpfs: defaultTmpfs,
    publishes: false,
    secretEnv: {
      ...psqlSecretEnvironment,
      MEAL_AGENT_MIGRATION_PASSWORD_FILE: secretPath('meal_agent_migration_password'),
      MEAL_AGENT_RUNTIME_PASSWORD_FILE: secretPath('meal_agent_runtime_password'),
      MEAL_AGENT_BACKUP_PASSWORD_FILE: secretPath('meal_agent_backup_password')
    },
    environment: {
      ...pgClusterEnvironment,
      MEAL_AGENT_MIGRATION_PASSWORD_FILE: secretPath('meal_agent_migration_password'),
      MEAL_AGENT_RUNTIME_PASSWORD_FILE: secretPath('meal_agent_runtime_password'),
      MEAL_AGENT_BACKUP_PASSWORD_FILE: secretPath('meal_agent_backup_password')
    },
    dependsOn: { 'bootstrap-cluster': 'service_completed_successfully' }
  },
  'bootstrap-createdb': {
    image: pinnedPostgresImage,
    user: postgresUser,
    profiles: [bootstrapProfile],
    entrypoint: ['createdb'],
    // `--` 结束选项解析：数据库名之后的一切都不可能被当成连接选项。
    command: ['--no-password', '--', databaseName],
    networks: ['internal'],
    mounts: [bootstrapMount, pgpassMount],
    secrets: [],
    tmpfs: defaultTmpfs,
    publishes: false,
    secretEnv: psqlSecretEnvironment,
    environment: pgClusterEnvironment,
    dependsOn: { 'bootstrap-logins': 'service_completed_successfully' }
  },
  'bootstrap-schema': {
    image: apiImage,
    user: apiUser,
    profiles: [bootstrapProfile],
    entrypoint: null,
    command: ['node', '/app/dist/database/bootstrap-0000.js'],
    networks: ['internal'],
    mounts: [secretVolumeMount('meal_agent_admin_database_url')],
    secrets: [],
    tmpfs: defaultTmpfs,
    publishes: false,
    secretEnv: {
      DATABASE_URL_FILE: secretPath('meal_agent_admin_database_url')
    },
    environment: {
      DATABASE_URL_FILE: secretPath('meal_agent_admin_database_url')
    },
    dependsOn: { 'bootstrap-createdb': 'service_completed_successfully' }
  },
  'bootstrap-handoff': {
    image: pinnedPostgresImage,
    user: postgresUser,
    profiles: [bootstrapProfile],
    entrypoint: bootstrapEntrypoint,
    command: ['handoff', '--dbname', databaseName],
    networks: ['internal'],
    // 服务级 volumes 整体覆盖 anchor，因此这里必须**同时**有两条。
    mounts: [bootstrapMount, handoffStage06Mount, pgpassMount],
    secrets: [],
    tmpfs: defaultTmpfs,
    publishes: false,
    secretEnv: psqlSecretEnvironment,
    environment: pgClusterEnvironment,
    dependsOn: { 'bootstrap-schema': 'service_completed_successfully' }
  },
  'bootstrap-acl': {
    image: pinnedPostgresImage,
    user: postgresUser,
    profiles: [bootstrapProfile],
    entrypoint: bootstrapEntrypoint,
    command: ['acl', '--dbname', databaseName],
    networks: ['internal'],
    mounts: [bootstrapMount, pgpassMount],
    secrets: [],
    tmpfs: defaultTmpfs,
    publishes: false,
    secretEnv: psqlSecretEnvironment,
    environment: pgClusterEnvironment,
    dependsOn: { 'bootstrap-handoff': 'service_completed_successfully' }
  },
  'bootstrap-grants': {
    image: pinnedPostgresImage,
    user: postgresUser,
    profiles: [bootstrapProfile],
    entrypoint: bootstrapEntrypoint,
    command: ['grants', '--dbname', databaseName],
    networks: ['internal'],
    mounts: [bootstrapMount, pgpassMount],
    secrets: [],
    tmpfs: defaultTmpfs,
    publishes: false,
    secretEnv: psqlSecretEnvironment,
    environment: pgClusterEnvironment,
    dependsOn: { migrate: 'service_completed_successfully' }
  },
  migrate: {
    image: apiImage,
    user: apiUser,
    profiles: [],
    entrypoint: null,
    command: ['node', '/app/dist/database/migrate.js'],
    networks: ['internal'],
    mounts: [secretVolumeMount('meal_agent_migration_database_url')],
    secrets: [],
    tmpfs: defaultTmpfs,
    publishes: false,
    secretEnv: {
      DATABASE_URL_FILE: secretPath('meal_agent_migration_database_url')
    },
    environment: {
      DATABASE_URL_FILE: secretPath('meal_agent_migration_database_url')
    },
    dependsOn: { postgres: 'service_healthy' }
  },
  api: {
    image: apiImage,
    user: apiUser,
    profiles: [],
    entrypoint: null,
    // 沿用镜像的 CMD（node /app/dist/index.js），不在 Compose 里另起启动命令。
    command: null,
    networks: ['edge', 'internal'],
    mounts: [secretVolumeMount('meal_agent_runtime_database_url')],
    secrets: [],
    tmpfs: defaultTmpfs,
    publishes: true,
    secretEnv: {
      DATABASE_URL_FILE: secretPath('meal_agent_runtime_database_url')
    },
    environment: {
      NODE_ENV: 'development',
      DEPLOYMENT_STAGE: pinnedDeployment.DEPLOYMENT_STAGE,
      DEPLOYMENT_EXPOSURE: pinnedDeployment.DEPLOYMENT_EXPOSURE,
      HOST: '0.0.0.0',
      PORT: String(apiContainerPort),
      LOG_LEVEL: 'info',
      WECHAT_ADAPTER: 'fake',
      DATABASE_APP_ROLE: 'meal_agent_app',
      DATABASE_URL_FILE: secretPath('meal_agent_runtime_database_url')
    },
    dependsOn: {
      postgres: 'service_healthy',
      migrate: 'service_completed_successfully'
    }
  },
  backup: {
    image: pinnedPostgresImage,
    user: postgresUser,
    profiles: [bootstrapProfile],
    entrypoint: ['bash'],
    command: null,
    networks: ['internal'],
    mounts: [
      secretVolumeMount('meal_agent_backup_password'),
      volumeMount('backup-transfer', '/transfer')
    ],
    secrets: [],
    tmpfs: ['/tmp:mode=0700,uid=999,gid=999,size=16m'],
    publishes: false,
    secretEnv: {},
    environment: {},
    dependsOn: { postgres: 'service_healthy' }
  },
  'backup-transfer-loader': {
    image: pinnedPostgresImage,
    user: postgresUser,
    profiles: [bootstrapProfile],
    entrypoint: ['bash'],
    command: null,
    networkMode: 'none',
    networks: [],
    mounts: [volumeMount('backup-transfer', '/transfer')],
    secrets: [],
    tmpfs: [],
    publishes: false,
    secretEnv: {},
    environment: {},
    dependsOn: {}
  },
  restore: {
    image: pinnedPostgresImage,
    user: postgresUser,
    profiles: [bootstrapProfile],
    entrypoint: bootstrapEntrypoint,
    command: null,
    networks: ['internal'],
    mounts: [
      bootstrapMount,
      pgpassMount,
      volumeMount('backup-transfer', '/transfer', true)
    ],
    secrets: [],
    tmpfs: defaultTmpfs,
    publishes: false,
    secretEnv: psqlSecretEnvironment,
    environment: pgClusterEnvironment,
    dependsOn: { postgres: 'service_healthy' }
  }
}
const serviceOrder = Object.keys(expectations).sort()
const defaultServices = ['api', 'migrate', 'postgres', 'secret-materializer']
const apiImageServices = ['api', 'migrate', 'bootstrap-schema']

const failures = []
const fail = (message) => {
  failures.push(diagnosticScrubber.scrubUntrusted(message))
}
const abort = (message) => {
  safeDiagnostic(`${diagnosticScrubber.scrubUntrusted(message)}\n`)
  process.exit(1)
}
// 任一尚未被逐层 shape guard 覆盖的外部证据也必须固定理由失败，不能让
// TypeError/JSON exception 与其携带的非可信内容落到 Node 默认 stack。
process.on('uncaughtException', () => {
  abort('compose topology check received malformed resolved configuration evidence')
})
process.on('unhandledRejection', () => {
  abort('compose topology check received malformed resolved configuration evidence')
})

// Git 的 ambient plumbing 变量能把 index/worktree/object database 整体替换掉；
// 必须在第一次 Docker/Git 调用之前拒绝，而不是让后面的 `git ls-files` 在一张
// alternate index 上得出「Secret 没被跟踪」的假结论。
const ambientGitOverrides = ambientGitRepositoryViewOverrides()
if (ambientGitOverrides.length > 0) {
  abort(
    `compose topology check requires the canonical Git repository view: ` +
      `${ambientGitOverrides.join(', ')}`
  )
}
try {
  assertCanonicalGitRepositoryView(repositoryRoot)
} catch {
  abort('compose topology check requires the canonical Git repository view')
}
// 对象按键排序后再比较（Compose 输出的键序不稳定），数组保持顺序——argv 与
// 挂载顺序是语义的一部分，不能被规范化掉。
const canonical = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    )
  }
  return value
}
const same = (actual, expected) =>
  JSON.stringify(canonical(actual ?? null)) ===
  JSON.stringify(canonical(expected ?? null))

// environmentOverrides 里显式的 undefined 表示**删除**该变量，用来区分
// 「未设置」与「设为空字符串」。
const runCompose = (args, environmentOverrides = {}) => {
  const environment = { ...process.env }
  for (const [key, value] of Object.entries(environmentOverrides)) {
    if (value === undefined) {
      delete environment[key]
    } else {
      environment[key] = value
    }
  }
  const result = spawnSync(
    'docker',
    ['compose', '--project-directory', composeDirectory, '--file', composeFile, ...args],
    {
      cwd: composeDirectory,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: environment
    }
  )
  if (result.error !== undefined) {
    abort('compose topology check is missing a prerequisite tool')
  }
  if (result.status !== 0) {
    abort(
      `compose topology check failed to resolve the configuration ` +
        `(docker compose evidence command failed)`
    )
  }
  return result.stdout
}

// git 的非零退出**不能**被当作「未跟踪」静默通过：无法判定即失败。
const gitTracks = (path) => {
  const result = spawnSync('git', canonicalGitArguments([
    'ls-files',
    '--error-unmatch',
    '--',
    path
  ]), {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
  if (result.error !== undefined) {
    abort('compose topology check is missing a prerequisite tool')
  }
  if (result.status === 0) {
    return true
  }
  // 1 = 该路径未被跟踪，是唯一可接受的非零退出。
  if (result.status === 1) {
    return false
  }
  abort('compose topology check could not determine whether a required path is tracked')
  return true
}

// **本文件唯一读取 Compose 源文本的地方**，有明确理由：`docker compose config`
// 会把**未被任何服务引用**的顶层 network / volume / secret 直接裁掉（`--no-normalize`
// 同样如此），因此「新增一个没人用的声明」在解析后的配置里根本不可见。要让这类
// 声明也失败，只能读源文件的顶层键。其余全部断言仍然只看解析后的配置。
let composeSource
try {
  composeSource = readFileSync(composeFile, 'utf8')
} catch {
  abort('compose topology check could not read the selected Compose source')
}

// 这三个 section **只允许** canonical bare key 写法。扫描是 fail closed 的：
// 二级缩进上任何非空、非注释且不符合该文法的声明行都会报错，而不是被静默
// 忽略——`"spare": {}`、`'spare': {}`、`<<: *alias` 都属于合法 YAML，但用
// 正则扫描无法可靠理解，所以只能拒绝，不能当作「这里没有键」。
const canonicalBareKey = /^ {2}([a-z0-9][a-z0-9_.-]*):(?:\s|$)/
const canonicalTopLevelKey = /^([a-z][a-z0-9_.-]*):(?:\s|$)/
const expectedTopLevelKeys = [
  'name',
  'x-hardening',
  'x-api-image',
  'x-bootstrap-psql',
  'x-pg-cluster-env',
  'services',
  'networks',
  'volumes',
  'secrets'
].sort()
const declaredTopLevelKeys = () => {
  const keys = []
  for (const line of composeSource.split('\n')) {
    if (line === '' || line.startsWith(' ') || line.trimStart().startsWith('#')) continue
    const match = canonicalTopLevelKey.exec(line)
    if (match === null) return null
    keys.push(match[1])
  }
  return keys.sort()
}
const declaredTopLevelSection = (section) => {
  const lines = composeSource.split('\n')
  const start = lines.indexOf(`${section}:`)
  if (start === -1) {
    return { found: false, keys: [], problems: [] }
  }
  const keys = []
  const problems = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') {
      continue
    }
    // 注释不结束 mapping，**零列注释也不结束**：YAML 的 mapping 只由下一个
    // 零列声明终止。把零列注释当成 section 结束，会让它后面的声明整段逃出扫描。
    if (line.trimStart().startsWith('#')) {
      continue
    }
    // 只有零列、非注释、非空的下一个顶层声明才结束本 section。
    if (!line.startsWith(' ')) {
      break
    }
    // 更深的缩进是值，不是声明。
    if (!line.startsWith('  ') || line.startsWith('   ')) {
      continue
    }
    const match = canonicalBareKey.exec(line)
    if (match === null) {
      problems.push(index + 1)
      continue
    }
    keys.push(match[1])
  }
  return { found: true, keys: keys.sort(), problems }
}

// 严格的仓库内判断：裸 startsWith 会让「与仓库同前缀的相邻目录」蒙混过关。
const insideRepository = (path) => {
  const absolute = resolve(path)
  if (absolute === repositoryRoot) {
    return true
  }
  const rel = relative(repositoryRoot, absolute)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// --------------------------------------------------------------------------
// 0. 顶层声明的源码扫描（**先于**任何 docker 调用）
// --------------------------------------------------------------------------
// 源文件侧覆盖「多出一个没人用的声明」，解析后侧覆盖「被引用的声明被删掉或
// 改名」，两侧缺一不可。这一段刻意排在最前面：非 canonical 的声明语法一旦出现，
// 后续所有基于正则的源码判断都不再可信，因此立即 fail closed，不给
// `docker compose config` 的 schema 校验抢先给出别的理由的机会。
const declaredSectionProblems = []
const sourceTopLevelKeys = declaredTopLevelKeys()
if (sourceTopLevelKeys === null || !same(sourceTopLevelKeys, expectedTopLevelKeys)) {
  declaredSectionProblems.push(
    'the Compose source top-level capability set drifted from its registered closed schema'
  )
}
for (const [section, expectedKeys] of [
  ['networks', expectedNetworkKeys],
  ['volumes', expectedVolumeKeys],
  ['secrets', Object.keys(expectedSecretFiles).sort()]
]) {
  const declared = declaredTopLevelSection(section)
  if (!declared.found) {
    declaredSectionProblems.push(
      `declared top-level ${section} section is missing from the compose source`
    )
    continue
  }
  for (const lineNumber of declared.problems) {
    declaredSectionProblems.push(
      `declared top-level ${section} uses a non-canonical declaration ` +
        `(line ${String(lineNumber)} omitted); this section only accepts canonical bare ` +
        `keys so the source scan can never silently miss a declaration`
    )
  }
  if (!same(declared.keys, expectedKeys)) {
    fail(`declared top-level ${section} drifted from its registered fixed set`)
  }
}
if (declaredSectionProblems.length > 0) {
  safeDiagnostic('Compose topology check FAIL\n')
  for (const message of declaredSectionProblems) {
    safeDiagnostic(`  - ${message}\n`)
  }
  process.exit(1)
}

let resolved
resolved = parseResolvedComposeDocument(
  // `*` includes every declared profile. Otherwise a hostile service hidden behind a profile
  // is absent from the resolved model and can carry arbitrary capabilities without review.
  runCompose(['--profile', '*', 'config', '--format', 'json'])
)
if (resolved === null) {
  abort('compose topology check received invalid resolved configuration evidence')
}
if (resolved.name !== composeProjectName) {
  fail('Compose project name drifted from the registered fixed value')
}
const services = resolved.services
const serviceNames = Object.keys(services).sort()

// --------------------------------------------------------------------------
// 1. 服务集合与显式调用边界
// --------------------------------------------------------------------------
if (!same(serviceNames, serviceOrder)) {
  fail('unexpected service set')
}

// 默认 profile 只能是 materializer/postgres/migrate/api：bootstrap 绝不能在 `docker compose
// up` 或任何普通重启里被再次执行。
const activeByDefault = runCompose(['config', '--services'])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .sort()
if (!same(activeByDefault, [...defaultServices].sort())) {
  fail('default profile must contain exactly the registered fixed service set')
}

// --------------------------------------------------------------------------
// 2. 逐服务固定：镜像、用户、profile、entrypoint、command、网络、挂载、
//    depends_on、环境与 secret 映射
// --------------------------------------------------------------------------
// bind 与 volume **都**保留 read_only：可写/只读是语义的一部分，
// 「没写 read_only」不等于「不必比较」——数据卷被改成只读必须被发现。
const normalizeMount = (mount) => ({
  type: mount.type,
  source:
    mount.type === 'bind' ? resolve(String(mount.source ?? '')) : mount.source,
  target: mount.target,
  read_only: mount.read_only === true
})
const hasOnlyKeys = (value, allowed) =>
  isResolvedServiceRecord(value) &&
  Object.keys(value).every((key) => allowed.has(key))
const mountShapeIsClosed = (mount) => {
  if (!isResolvedServiceRecord(mount)) return false
  const allowed = new Set(['type', 'source', 'target', 'read_only', 'bind', 'volume'])
  if (!hasOnlyKeys(mount, allowed)) return false
  if (!['bind', 'volume'].includes(mount.type)) return false
  if (typeof mount.source !== 'string' || typeof mount.target !== 'string') return false
  if (mount.read_only !== undefined && typeof mount.read_only !== 'boolean') return false
  if (mount.bind !== undefined && !same(mount.bind, {})) return false
  if (mount.volume !== undefined && !same(mount.volume, {})) return false
  if (mount.type === 'bind' && mount.volume !== undefined) return false
  if (mount.type === 'volume' && mount.bind !== undefined) return false
  return true
}

// resolved Compose service 是可执行能力面，不只 entrypoint/command。未知字段可能
// 承载 post_start/pre_stop 等 lifecycle hook；因此按当前受审解析结果做闭集，新增
// 字段必须先补 expectation 与反向变异，不能被 Compose 默默接受。
const allowedResolvedServiceKeys = new Set([
  'build',
  'cap_add',
  'cap_drop',
  'command',
  'depends_on',
  'entrypoint',
  'environment',
  'healthcheck',
  'image',
  'logging',
  'network_mode',
  'networks',
  'ports',
  'profiles',
  'read_only',
  'restart',
  'secrets',
  'security_opt',
  'tmpfs',
  'user',
  'volumes'
])

for (const name of serviceOrder) {
  const service = services[name]
  if (service === undefined) {
    fail(`${name}: service is missing from the resolved configuration`)
    continue
  }
  if (!isResolvedServiceRecord(service)) {
    fail(`${name}: resolved service must be a plain object`)
    continue
  }
  const expected = expectations[name]
  const unknownKeys = Object.keys(service).filter(
    (key) => !allowedResolvedServiceKeys.has(key)
  )
  if (unknownKeys.length > 0) {
    fail(`${name}: resolved service contains unsupported capability fields`)
  }
  if (
    !Array.isArray(service.profiles ?? []) ||
    !Array.isArray(service.volumes ?? []) ||
    !(service.volumes ?? []).every(mountShapeIsClosed) ||
    !Array.isArray(service.secrets ?? []) ||
    !(service.secrets ?? []).every(
      (entry) =>
        hasOnlyKeys(entry, new Set(['source', 'target'])) &&
        typeof entry.source === 'string' &&
        typeof entry.target === 'string'
    ) ||
    !Array.isArray(service.tmpfs ?? []) ||
    !isResolvedServiceRecord(service.networks ?? {}) ||
    Object.values(service.networks ?? {}).some((attachment) => attachment !== null) ||
    !isResolvedServiceRecord(service.depends_on ?? {}) ||
    !isResolvedServiceRecord(service.environment ?? {})
  ) {
    fail(`${name}: resolved nested capability evidence has an unsupported shape`)
    continue
  }

  // `build` / `healthcheck` 不能只靠全局 key allowlist。它们都是可执行能力：
  // 前者能改变 build network/secret/ssh 等边界，后者能在容器内周期执行命令。
  // 只有登记过的服务可以持有；否则即使后面的“已知服务形状”检查全绿，也会把
  // 新能力静默留在 resolved Compose 里。
  if (!apiImageServices.includes(name) && service.build !== undefined) {
    fail(`${name}: must not declare a build stanza`)
  }
  if (name !== 'postgres' && name !== 'api' && service.healthcheck !== undefined) {
    fail(`${name}: must not declare a healthcheck`)
  }

  if (service.image !== expected.image) {
    fail(`${name}: image drifted from the registered fixed value`)
  }
  if (service.user !== expected.user) {
    fail(`${name}: user drifted from the registered fixed value`)
  }
  if (!same((service.profiles ?? []).slice().sort(), expected.profiles.slice().sort())) {
    fail(`${name}: profile set drifted from the registered fixed set`)
  }
  if (!same(service.entrypoint ?? null, expected.entrypoint)) {
    fail(`${name}: entrypoint drifted from the registered fixed value`)
  }
  if (!same(service.command ?? null, expected.command)) {
    fail(`${name}: command drifted from the registered fixed value`)
  }
  if ((service.network_mode ?? null) !== (expected.networkMode ?? null)) {
    fail(`${name}: network_mode drifted from the registered fixed value`)
  }
  if (!same(Object.keys(service.networks ?? {}).sort(), expected.networks)) {
    fail(`${name}: network set drifted from the registered fixed set`)
  }

  const actualMounts = (service.volumes ?? []).map(normalizeMount)
  const expectedMounts = expected.mounts.map(normalizeMount)
  if (!same(actualMounts, expectedMounts)) {
    fail(`${name}: mount set drifted from the registered fixed set`)
  }

  const actualSecrets = (service.secrets ?? []).map((entry) => ({
    source: entry.source,
    target: entry.target
  }))
  if (!same(actualSecrets, expected.secrets ?? [])) {
    fail(`${name}: raw Compose secret set drifted from the registered fixed set`)
  }

  if (!same(service.tmpfs ?? [], expected.tmpfs)) {
    fail(`${name}: tmpfs drifted from the registered fixed set`)
  }

  const actualDependsOn = {}
  for (const [key, value] of Object.entries(service.depends_on ?? {})) {
    const condition = resolvedDependencyProjection(value)
    if (condition === null) {
      fail(`${name}: depends_on metadata drifted from the registered fixed semantics`)
      continue
    }
    actualDependsOn[key] = condition
  }
  if (!same(actualDependsOn, expected.dependsOn)) {
    fail(`${name}: depends_on drifted from the registered fixed set`)
  }

  const actualEnvironment = Object.fromEntries(
    Object.entries(service.environment ?? {}).map(([key, value]) => [
      key,
      value === null ? '' : String(value)
    ])
  )
  if (!same(actualEnvironment, expected.environment)) {
    fail(`${name}: environment drifted from the registered fixed set`)
  }

  // 消费者不直挂原始 Compose secret；*_FILE / PGPASSFILE 必须指向
  // 一个独立、只读的 materialized volume，且 volume 名与 secret 身份精确对应。
  for (const [key, target] of Object.entries(expected.secretEnv)) {
    if (actualEnvironment[key] !== target) {
      fail(`${name}: ${key} must point at its registered secret target`)
    }
    const nameFromPath = target
      .replace('/run/secrets/', '')
      .replace(/\/value$/, '')
    const mount = actualMounts.find(
      (candidate) => candidate.target === `/run/secrets/${nameFromPath}`
    )
    if (
      mount === undefined ||
      mount.type !== 'volume' ||
      mount.source !== secretVolumes[nameFromPath] ||
      mount.read_only !== true
    ) {
      fail(`${name}: ${key} must be backed by its registered read-only materialized volume`)
    }
  }
}

// API runtime 绝不能持有 admin / migration / backup 凭据（验收门禁 #4）。
for (const entry of services.api?.volumes ?? []) {
  if (/admin|migration|backup/.test(String(entry.source ?? ''))) {
    fail('api: runtime must never receive an admin, migration, or backup credential volume')
  }
}

// --------------------------------------------------------------------------
// 3. 镜像固定与 API 构建来源
// --------------------------------------------------------------------------
const digestPattern = /@sha256:[0-9a-f]{64}$/
for (const name of serviceOrder) {
  const image = services[name]?.image ?? ''
  if (image === apiImage) {
    continue
  }
  if (!digestPattern.test(image)) {
    fail(`${name}: image must pin an immutable sha256 digest`)
  }
  if (/:(latest|lts|stable)(@|$)/.test(image)) {
    fail(`${name}: floating image tag is not allowed`)
  }
}

// 三个 API 镜像服务都必须声明 build，且精确指向 monorepo 根上下文与已 Accepted
// 的 Dockerfile。build 缺失即失败——不能因为「没写 build」就跳过检查。
for (const name of apiImageServices) {
  const build = services[name]?.build
  if (build === undefined || build === null || typeof build !== 'object' || Array.isArray(build)) {
    fail(`${name}: must declare a build stanza pinning ${apiDockerfile}`)
    continue
  }
  const buildKeys = Object.keys(build).sort()
  if (!same(buildKeys, ['context', 'dockerfile'])) {
    fail(`${name}: build contains unsupported execution capability fields`)
  }
  if (resolve(build.context ?? '') !== repositoryRoot) {
    fail(`${name}: build context must be the registered monorepo root`)
  }
  if (build.dockerfile !== apiDockerfile) {
    fail(`${name}: build must use the registered API Dockerfile`)
  }
}

// --------------------------------------------------------------------------
// 4. 容器权限与逃逸面
// --------------------------------------------------------------------------
const hostModes = ['pid', 'ipc', 'uts', 'cgroup', 'userns_mode', 'network_mode']
for (const name of serviceOrder) {
  const service = services[name] ?? {}

  if (service.privileged === true) {
    fail(`${name}: privileged containers are not allowed`)
  }
  for (const key of hostModes) {
    const value = service[key]
    if (typeof value === 'string' && value.split(':')[0] === 'host') {
      fail(`${name}: ${key}: host is not allowed`)
    }
  }
  if (
    service.network_mode !== undefined &&
    service.network_mode !== expectations[name].networkMode
  ) {
    fail(`${name}: unexpected network_mode`)
  }

  const securityOpt = service.security_opt ?? []
  if (!same(securityOpt, ['no-new-privileges:true'])) {
    fail(`${name}: security_opt must match the registered fixed set`)
  }

  if (!(service.cap_drop ?? []).includes('ALL')) {
    fail(`${name}: cap_drop must include ALL`)
  }
  const capAdd = (service.cap_add ?? []).slice().sort()
  const expectedCapAdd = (expectations[name].capAdd ?? []).slice().sort()
  if (!same(capAdd, expectedCapAdd)) {
    fail(`${name}: cap_add drifted from the registered fixed set`)
  }
  if ((service.devices ?? []).length > 0) {
    fail(`${name}: device passthrough is not allowed`)
  }
  if (service.restart !== 'no') {
  fail(`${name}: restart must be "no"`)
  }
  if (service.read_only !== true) {
    fail(`${name}: read_only root filesystem must be enabled`)
  }
  if (
    expectations[name].allowRoot !== true &&
    ['0', 'root', '0:0'].includes(service.user ?? '')
  ) {
    fail(`${name}: must not run as root`)
  }

  const logging = service.logging ?? {}
  if (
    !same(logging, {
      driver: 'json-file',
      options: { 'max-file': '3', 'max-size': '10m' }
    })
  ) {
    fail(`${name}: logging must match the registered bounded local rotation policy`)
  }

  for (const mount of service.volumes ?? []) {
    const source = String(mount.source ?? '')
    if (/docker\.sock/.test(source) || /docker\.sock/.test(String(mount.target ?? ''))) {
      fail(`${name}: mounting the Docker socket is not allowed`)
    }
    if (mount.type === 'bind') {
      if (mount.read_only !== true) {
        fail(`${name}: every bind mount must be read-only`)
      }
      if (!insideRepository(source)) {
        fail(`${name}: every bind mount must stay inside the repository`)
      }
    }
  }
}

if ((services.postgres?.volumes ?? []).some((mount) => mount.type === 'bind')) {
  fail('postgres: the database must use a named volume, never a host bind mount')
}

// --------------------------------------------------------------------------
// 5. 端口发布
// --------------------------------------------------------------------------
for (const name of serviceOrder) {
  const ports = services[name]?.ports ?? []
  if (!expectations[name].publishes) {
    if (ports.length > 0) {
      fail(`${name}: must not publish any host port`)
    }
    continue
  }
  if (ports.length !== 1) {
    fail(`${name}: expected exactly one published port`)
    continue
  }
  const [port] = ports
  if (
    !isResolvedServiceRecord(port) ||
    !same(Object.keys(port).sort(), ['host_ip', 'mode', 'protocol', 'published', 'target'])
  ) {
    fail(`${name}: published port capability shape drifted from the registered fixed set`)
    continue
  }
  if (port.host_ip !== apiHostIp) {
    fail(`${name}: host publish address must be exactly ${apiHostIp}`)
  }
  if (Number(port.target) !== apiContainerPort) {
    fail(`${name}: container port must be ${apiContainerPort}`)
  }
  if ((port.protocol ?? 'tcp') !== 'tcp') {
    fail(`${name}: published port must be tcp`)
  }
  if (!/^[0-9]+$/.test(String(port.published))) {
    fail(`${name}: published host port must be a single number`)
  }
  if (port.mode !== 'host') {
    fail(`${name}: published port mode must be host`)
  }
}

// --------------------------------------------------------------------------
// 6. 网络隔离与 project scope 命名
// --------------------------------------------------------------------------
const networks = resolved.networks ?? {}
if (!same(Object.keys(networks).sort(), expectedNetworkKeys)) {
  fail('top-level networks drifted from the registered fixed set')
}
if (!same(Object.keys(resolved.volumes ?? {}).sort(), expectedVolumeKeys)) {
  fail('top-level volumes drifted from the registered fixed set')
}
if (networks.internal?.internal !== true) {
  fail('networks.internal must set internal: true (no gateway, no host port)')
}
for (const key of expectedNetworkKeys) {
  const definition = networks[key]
  const expectedDefinition =
    key === 'internal'
      ? {
          name: `${resolved.name}_${key}`,
          driver: 'bridge',
          ipam: {},
          internal: true
        }
      : { name: `${resolved.name}_${key}`, driver: 'bridge', ipam: {} }
  if (!same(definition, expectedDefinition)) {
    fail('a registered network capability shape drifted')
  }
}
for (const key of expectedVolumeKeys) {
  const definition = resolved.volumes?.[key]
  if (!same(definition, { name: `${resolved.name}_${key}` })) {
    fail('a registered volume capability shape drifted')
  }
}
// 网络与卷不得写死全局 name：并行 worktree 必须能靠 project name 互相隔离。
for (const key of expectedNetworkKeys) {
  const definition = networks[key]
  const expectedName = `${resolved.name}_${key}`
  if (definition.name !== expectedName) {
    fail('network names must be project-scoped')
  }
}
for (const key of expectedVolumeKeys) {
  const definition = resolved.volumes?.[key]
  const expectedName = `${resolved.name}_${key}`
  if (definition.name !== expectedName) {
    fail('volume names must be project-scoped')
  }
}

// 两个不同 project name 必须解析出互不相同的 network 与 volume 真实名称。
const probeNames = ['meal-agent-m2b-probe-alpha', 'meal-agent-m2b-probe-beta']
const probes = probeNames.map((project) => {
  const probe = parseResolvedComposeDocument(
    runCompose(['--project-name', project, 'config', '--format', 'json'])
  )
  if (probe === null) {
    abort('compose topology check received invalid project-scope probe evidence')
  }
  return probe
})
for (const [index, probe] of probes.entries()) {
  if (probe.name !== probeNames[index]) {
    fail('the registered --project-name was not honoured')
  }
}
const probeIdentifiers = probes.map((probe) =>
  [
    ...Object.values(probe.networks ?? {}).map((n) => n.name),
    ...Object.values(probe.volumes ?? {}).map((v) => v.name)
  ].sort()
)
for (const identifier of probeIdentifiers[0]) {
  if (probeIdentifiers[1].includes(identifier)) {
    fail('a network or volume is shared across project names')
  }
}

// --------------------------------------------------------------------------
// 7. 数据库 identity 不可被环境变量改写
// --------------------------------------------------------------------------
const baseline = runCompose(['--profile', bootstrapProfile, 'config'])
for (const poison of ['evil', '--host=evil', 'meal_agent postgres']) {
  const poisoned = runCompose(['--profile', bootstrapProfile, 'config'], {
    MEAL_AGENT_DATABASE: poison
  })
  if (poisoned !== baseline) {
    fail('database identity is influenced by an ambient override')
  }
}
for (const name of ['bootstrap-createdb', 'bootstrap-handoff', 'bootstrap-acl', 'bootstrap-grants']) {
  if (!(services[name]?.command ?? []).includes(databaseName)) {
    fail(`${name}: must operate on the pinned database ${databaseName}`)
  }
}

// --------------------------------------------------------------------------
// 8. Secret 边界
// --------------------------------------------------------------------------
const secretKeyPattern = /(PASSWORD|PASSWD|SECRET|TOKEN|DSN)$/
const connectionStringPattern = /^postgres(ql)?:\/\//i
const credentialsInUrlPattern = /:\/\/[^/\s]*:[^/\s]*@/

for (const name of serviceOrder) {
  for (const [key, rawValue] of Object.entries(services[name]?.environment ?? {})) {
    const value = rawValue === null ? '' : String(rawValue)
    if (secretKeyPattern.test(key)) {
      fail(`${name}: a sensitive environment key must not carry a value in Compose`)
    }
    if (key === 'DATABASE_URL' || key === 'PGPASSWORD') {
      fail(`${name}: a database credential variable must not appear in Compose`)
    }
    if (connectionStringPattern.test(value) || credentialsInUrlPattern.test(value)) {
      fail(`${name}: an environment value looks like a connection string with credentials`)
    }
  }
}

// 顶层 secret 集合逐项固定：增加、删除或改名都必须失败。
const secretNames = Object.keys(resolved.secrets ?? {}).sort()
const expectedSecretNames = Object.keys(expectedSecretFiles).sort()
if (!same(secretNames, expectedSecretNames)) {
  fail('top-level secrets drifted from the registered fixed set')
}

// 每个 secret 的 backing file 身份必须精确：effective 目录 + 期望文件名。
// 只比较路径，绝不读取或输出文件内容。
const assertSecretFiles = (definitions, directory, label) => {
  for (const [name, expectedFilename] of Object.entries(expectedSecretFiles)) {
    const file = definitions[name]?.file
    if (typeof file !== 'string' || file === '') {
      fail(`secret ${name}: must be backed by a file in the registered source mode`)
      continue
    }
    const expectedFile = resolve(directory, expectedFilename)
    if (resolve(file) !== expectedFile) {
      fail(`secret ${name}: backing file drifted from the registered source path`)
    }
  }
}
// 两条分支都**显式**指定 MEAL_AGENT_SECRETS_DIR，因此结果与调用 checker 时的
// 宿主环境无关：预先导出了该变量也不会让默认分支变成在测 override。
const resolveSecretsWith = (override) => {
  const evidence = parseResolvedComposeDocument(
    runCompose(['--profile', bootstrapProfile, 'config', '--format', 'json'], {
      MEAL_AGENT_SECRETS_DIR: override
    })
  )
  if (evidence === null) {
    abort('compose topology check received invalid Secret resolution evidence')
  }
  if (evidence.name !== composeProjectName) {
    fail('Secret resolution evidence drifted from the registered project identity')
  }
  return evidence.secrets
}

// 分支一：空字符串必须与「未设置」语义完全一致，回落到 <compose 目录>/secrets/，
// 而**不是**把 compose 目录本身当成 secret 目录。
const unsetSecrets = resolveSecretsWith(undefined)
const emptySecrets = resolveSecretsWith('')
for (const name of Object.keys(expectedSecretFiles)) {
  const emptyFile = emptySecrets[name]?.file
  const unsetFile = unsetSecrets[name]?.file
  if (emptyFile !== unsetFile) {
    fail("MEAL_AGENT_SECRETS_DIR='' must resolve identically to leaving it unset")
  }
}
assertSecretFiles(
  emptySecrets,
  secretsDirectoryFor(''),
  "default fallback (MEAL_AGENT_SECRETS_DIR='')"
)

// 分支二：显式的非空 override 必须落在同一套 name → filename 映射上。
const secretsProbeDirectory = resolve(composeDirectory, 'm2b-secrets-probe')
assertSecretFiles(
  resolveSecretsWith(secretsProbeDirectory),
  secretsProbeDirectory,
  'MEAL_AGENT_SECRETS_DIR override'
)

for (const [name, definition] of Object.entries(resolved.secrets ?? {})) {
  const file = definition.file
  if (typeof file !== 'string' || file === '') {
    continue
  }
  // 仓库外的 secret 目录是显式支持的分支：它不可能被 Git 跟踪，因此只检查权限。
  if (insideRepository(file)) {
    if (gitTracks(file)) {
      fail(`secret ${name}: its backing file is tracked by git; secrets must stay untracked`)
    }
  }
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o777
    if ((mode & 0o077) !== 0) {
      fail(`secret ${name}: its backing file is group/world accessible`)
    }
  }
}

// --------------------------------------------------------------------------
// 8b. 部署身份与暴露级别（M3A）
// --------------------------------------------------------------------------
// `DEPLOYMENT_STAGE` / `DEPLOYMENT_EXPOSURE` 在 config.ts 里没有默认值，因此
// 「被删掉」与「被改成别的值」是两种不同的篡改，两种都必须在这里失败——只靠
// 上面第 2 节的 environment 全等比较也能捕获，但那条失败理由是「environment
// 漂移」，读起来看不出安全含义。这一节给出显式理由。
const apiEnvironment = Object.fromEntries(
  Object.entries(services.api?.environment ?? {}).map(([key, value]) => [
    key,
    value === null ? '' : String(value)
  ])
)
for (const [key, expectedValue] of Object.entries(pinnedDeployment)) {
  if (apiEnvironment[key] === undefined) {
    fail(
      `api: ${key} must be declared explicitly (config.ts has no default; ` +
        `omitting it makes the deployment identity a guess)`
    )
    continue
  }
  if (apiEnvironment[key] !== expectedValue) {
    fail(`api: ${key} must use its registered local-test value`)
  }
}
// 与 config.ts 完全相同的判据，在 Compose 层再执行一次：fake adapter 只允许
// 出现在 local-test + loopback + 非 production 上。
if (apiEnvironment['WECHAT_ADAPTER'] === 'fake') {
  if (apiEnvironment['DEPLOYMENT_STAGE'] !== 'local-test') {
      fail('api: the fake WeChat adapter is only allowed at DEPLOYMENT_STAGE local-test')
  }
  if (apiEnvironment['DEPLOYMENT_EXPOSURE'] !== 'loopback') {
      fail('api: the fake WeChat adapter is only allowed at DEPLOYMENT_EXPOSURE loopback')
  }
  if (apiEnvironment['NODE_ENV'] === 'production') {
    fail('api: the fake WeChat adapter is not allowed with NODE_ENV=production')
  }
}
// 部署身份只属于 API：把它塞给 migrate 或 bootstrap-* 会让「这套部署是什么」
// 出现第二个、可能互相矛盾的事实源。
for (const name of serviceOrder) {
  if (name === 'api') {
    continue
  }
  for (const key of ['DEPLOYMENT_STAGE', 'DEPLOYMENT_EXPOSURE']) {
    if ((services[name]?.environment ?? {})[key] !== undefined) {
      fail(`${name}: must not declare ${key}; only api carries the deployment identity`)
    }
  }
}
// local-test 使用合成身份，因此整套拓扑不得出现真实微信凭据。
for (const name of serviceOrder) {
  for (const key of forbiddenWechatCredentialKeys) {
    if ((services[name]?.environment ?? {})[key] !== undefined) {
      fail(
        `${name}: ${key} must not appear in the local-test topology; ` +
          `it uses synthetic identities only`
      )
    }
  }
}

// --------------------------------------------------------------------------
// 9. 健康检查
// --------------------------------------------------------------------------
const postgresHealth = resolvedHealthcheckProjection(services.postgres?.healthcheck)
const expectedPostgresHealth = [
  'CMD',
  'pg_isready',
  '--host=127.0.0.1',
  '--port=5432',
  '--username=postgres',
  '--dbname=postgres',
  '--quiet'
]
if (
  !same(postgresHealth, {
    test: expectedPostgresHealth,
    interval: '5s',
    timeout: '5s',
    retries: 24,
    start_period: '30s',
    start_interval: null,
    disable: null
  })
) {
  fail('postgres: healthcheck drifted from the registered fixed semantics')
}
const apiHealth = resolvedHealthcheckProjection(services.api?.healthcheck)
const expectedApiHealth = [
  'CMD',
  'node',
  '-e',
  "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
]
if (
  !same(apiHealth, {
    test: expectedApiHealth,
    interval: '10s',
    timeout: '5s',
    retries: 5,
    start_period: '15s',
    start_interval: null,
    disable: null
  })
) {
  fail('api: healthcheck drifted from the registered fixed semantics')
}

// --------------------------------------------------------------------------
// 结果
// --------------------------------------------------------------------------
if (failures.length > 0) {
  safeDiagnostic('Compose topology check FAIL\n')
  for (const message of failures) {
    safeDiagnostic(`  - ${message}\n`)
  }
  process.exit(1)
}

process.stdout.write(
  `Compose topology check PASS (${serviceNames.length} services, ` +
    `${Object.keys(resolved.secrets ?? {}).length} secret files, ` +
    `${Object.keys(networks).length} networks, project scope ${resolved.name})\n`
)
