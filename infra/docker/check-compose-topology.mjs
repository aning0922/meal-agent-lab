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
// Docker CLI 缺失时本脚本以「缺少前置工具」失败退出，不降级成纯文本检查后宣称
// 通过（阶段 09A 验收门禁 #11）。
//
// 覆盖范围是 M2B 自己的边界：镜像固定、端口发布、网络隔离、容器权限、一次性
// 任务的显式调用与顺序，以及「Compose 里不出现口令或完整连接串」。
// 运行期动态门禁（非 loopback 访问、镜像/日志 Secret 扫描）属于 M3 与 M5。
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const repositoryRoot = resolve(composeDirectory, '..', '..')
const composeFile = resolve(composeDirectory, 'compose.local-test.yaml')

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
const bootstrapProfile = 'bootstrap'
const defaultServices = ['api', 'migrate', 'postgres']
const bootstrapServices = [
  'bootstrap-cluster',
  'bootstrap-logins',
  'bootstrap-createdb',
  'bootstrap-schema',
  'bootstrap-handoff',
  'bootstrap-acl',
  'bootstrap-grants'
]
const apiImageServices = ['api', 'migrate', 'bootstrap-schema']

const failures = []
const fail = (message) => {
  failures.push(message)
}

const runCompose = (args) => {
  const result = spawnSync(
    'docker',
    ['compose', '--file', composeFile, ...args],
    { cwd: composeDirectory, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
  if (result.error !== undefined) {
    process.stderr.write(
      `compose topology check is missing a prerequisite tool: ` +
        `failed to run docker (${result.error.message})\n`
    )
    process.exit(1)
  }
  if (result.status !== 0) {
    process.stderr.write(
      `compose topology check failed to resolve the configuration ` +
        `(docker compose ${args.join(' ')} exit=${String(result.status)}): ` +
        `${result.stderr.trim() || '(no stderr)'}\n`
    )
    process.exit(1)
  }
  return result.stdout
}

const runGit = (args) => {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
  if (result.error !== undefined) {
    process.stderr.write(
      `compose topology check is missing a prerequisite tool: ` +
        `failed to run git (${result.error.message})\n`
    )
    process.exit(1)
  }
  return result.stdout
}

const resolved = JSON.parse(
  runCompose(['--profile', bootstrapProfile, 'config', '--format', 'json'])
)
const services = resolved.services ?? {}
const serviceNames = Object.keys(services).sort()

// --------------------------------------------------------------------------
// 1. 服务集合与显式调用边界
// --------------------------------------------------------------------------
const expectedServices = [...defaultServices, ...bootstrapServices].sort()
if (serviceNames.join(',') !== expectedServices.join(',')) {
  fail(
    `unexpected service set: got [${serviceNames.join(', ')}], ` +
      `expected [${expectedServices.join(', ')}]`
  )
}

// 默认 profile 只能是 postgres/migrate/api：bootstrap 绝不能在 `docker compose
// up` 或任何普通重启里被再次执行。
const activeByDefault = runCompose(['config', '--services'])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .sort()
if (activeByDefault.join(',') !== [...defaultServices].sort().join(',')) {
  fail(
    `default profile must contain exactly [${defaultServices.join(', ')}], ` +
      `got [${activeByDefault.join(', ')}]`
  )
}

for (const name of bootstrapServices) {
  const profiles = services[name]?.profiles ?? []
  if (profiles.length !== 1 || profiles[0] !== bootstrapProfile) {
    fail(
      `${name}: one-shot bootstrap job must be gated by exactly the ` +
        `"${bootstrapProfile}" profile, got [${profiles.join(', ')}]`
    )
  }
}
for (const name of defaultServices) {
  const profiles = services[name]?.profiles ?? []
  if (profiles.length > 0) {
    fail(`${name}: must not be profile-gated, got [${profiles.join(', ')}]`)
  }
}

// --------------------------------------------------------------------------
// 2. 一次性任务的顺序
// --------------------------------------------------------------------------
const dependsOn = (name, dependency) =>
  services[name]?.depends_on?.[dependency]?.condition

const expectedOrder = [
  ['bootstrap-cluster', 'postgres', 'service_healthy'],
  ['bootstrap-logins', 'bootstrap-cluster', 'service_completed_successfully'],
  ['bootstrap-createdb', 'bootstrap-logins', 'service_completed_successfully'],
  ['bootstrap-schema', 'bootstrap-createdb', 'service_completed_successfully'],
  ['bootstrap-handoff', 'bootstrap-schema', 'service_completed_successfully'],
  ['bootstrap-acl', 'bootstrap-handoff', 'service_completed_successfully'],
  ['bootstrap-grants', 'migrate', 'service_completed_successfully'],
  ['migrate', 'postgres', 'service_healthy'],
  // API 只能在 migration 成功之后启动，并且数据库必须已经 healthy。
  ['api', 'migrate', 'service_completed_successfully'],
  ['api', 'postgres', 'service_healthy']
]
for (const [name, dependency, condition] of expectedOrder) {
  const actual = dependsOn(name, dependency)
  if (actual !== condition) {
    fail(
      `${name}: expected depends_on.${dependency}.condition=${condition}, ` +
        `got ${actual ?? '(none)'}`
    )
  }
}

// --------------------------------------------------------------------------
// 3. 镜像固定
// --------------------------------------------------------------------------
const digestPattern = /@sha256:[0-9a-f]{64}$/
for (const name of serviceNames) {
  const image = services[name].image
  if (typeof image !== 'string' || image === '') {
    fail(`${name}: must declare an explicit image`)
    continue
  }
  if (apiImageServices.includes(name)) {
    if (image !== apiImage) {
      fail(`${name}: expected the API image ${apiImage}, got ${image}`)
    }
    continue
  }
  if (image !== pinnedPostgresImage) {
    fail(
      `${name}: expected the pinned PostgreSQL image ${pinnedPostgresImage}, ` +
        `got ${image}`
    )
  }
  if (!digestPattern.test(image)) {
    fail(`${name}: image must pin an immutable sha256 digest, got ${image}`)
  }
  if (/:(latest|lts|stable)(@|$)/.test(image)) {
    fail(`${name}: floating image tag is not allowed, got ${image}`)
  }
}

// API 镜像必须由已 Accepted 的 Dockerfile 从 monorepo 根上下文构建；
// M2B 不得 fork 出第二个服务端镜像定义。
for (const name of apiImageServices) {
  const build = services[name].build
  if (build === undefined) {
    continue
  }
  if (resolve(build.context ?? '') !== repositoryRoot) {
    fail(
      `${name}: build context must be the monorepo root ${repositoryRoot}, ` +
        `got ${build.context ?? '(none)'}`
    )
  }
  if (build.dockerfile !== apiDockerfile) {
    fail(
      `${name}: build must use ${apiDockerfile}, got ` +
        `${build.dockerfile ?? '(none)'}`
    )
  }
}

// --------------------------------------------------------------------------
// 4. 容器权限与逃逸面
// --------------------------------------------------------------------------
const hostModes = ['pid', 'ipc', 'uts', 'cgroup', 'userns_mode', 'network_mode']
for (const name of serviceNames) {
  const service = services[name]

  if (service.privileged === true) {
    fail(`${name}: privileged containers are not allowed`)
  }
  for (const key of hostModes) {
    const value = service[key]
    if (typeof value === 'string' && value.split(':')[0] === 'host') {
      fail(`${name}: ${key}: host is not allowed (got ${value})`)
    }
  }
  if (service.network_mode !== undefined) {
    fail(`${name}: network_mode must not be set (got ${service.network_mode})`)
  }

  const securityOpt = service.security_opt ?? []
  if (!securityOpt.includes('no-new-privileges:true')) {
    fail(`${name}: security_opt must include no-new-privileges:true`)
  }
  for (const option of securityOpt) {
    if (/unconfined/.test(option)) {
      fail(`${name}: security_opt must not relax confinement (got ${option})`)
    }
  }

  const capDrop = service.cap_drop ?? []
  if (!capDrop.includes('ALL')) {
    fail(`${name}: cap_drop must include ALL`)
  }
  const capAdd = service.cap_add ?? []
  if (capAdd.length > 0) {
    fail(`${name}: cap_add must stay empty, got [${capAdd.join(', ')}]`)
  }

  if ((service.devices ?? []).length > 0) {
    fail(`${name}: device passthrough is not allowed`)
  }

  if (service.restart !== 'no') {
    fail(`${name}: restart must be "no", got ${service.restart ?? '(none)'}`)
  }

  if (service.read_only !== true) {
    fail(`${name}: read_only root filesystem must be enabled`)
  }

  const user = service.user
  if (user === undefined || ['0', 'root', '0:0'].includes(user)) {
    fail(`${name}: must run as an explicit non-root user, got ${user ?? '(none)'}`)
  }

  const logging = service.logging ?? {}
  if (logging.driver !== 'json-file') {
    fail(`${name}: logging driver must be json-file, got ${logging.driver ?? '(none)'}`)
  }
  const loggingOptions = logging.options ?? {}
  if (loggingOptions['max-size'] === undefined || loggingOptions['max-file'] === undefined) {
    fail(`${name}: logging must set both max-size and max-file (bounded local rotation)`)
  }
}

if (apiImageServices.some((name) => services[name].user !== apiUser)) {
  fail(
    `API-image services must declare user ${apiUser} to match the accepted ` +
      `Dockerfile baseline`
  )
}

// --------------------------------------------------------------------------
// 5. 挂载：无 Docker socket、无数据库 bind mount
// --------------------------------------------------------------------------
for (const name of serviceNames) {
  for (const mount of services[name].volumes ?? []) {
    const source = String(mount.source ?? '')
    if (/docker\.sock/.test(source) || /docker\.sock/.test(String(mount.target ?? ''))) {
      fail(`${name}: mounting the Docker socket is not allowed (${source})`)
    }
    if (mount.type === 'bind') {
      if (mount.read_only !== true) {
        fail(`${name}: bind mount ${source} must be read-only`)
      }
      if (!resolve(source).startsWith(repositoryRoot)) {
        fail(`${name}: bind mount ${source} must stay inside the repository`)
      }
    }
  }
}

const postgresMounts = services.postgres?.volumes ?? []
if (postgresMounts.some((mount) => mount.type === 'bind')) {
  fail('postgres: the database must use a named volume, never a host bind mount')
}
if (!postgresMounts.some((mount) => mount.type === 'volume')) {
  fail('postgres: the database must persist through a named volume')
}

// --------------------------------------------------------------------------
// 6. 端口发布
// --------------------------------------------------------------------------
if ((services.postgres?.ports ?? []).length > 0) {
  fail('postgres: must not publish any host port')
}
for (const name of bootstrapServices) {
  if ((services[name].ports ?? []).length > 0) {
    fail(`${name}: one-shot jobs must not publish host ports`)
  }
}
if ((services.migrate?.ports ?? []).length > 0) {
  fail('migrate: one-shot jobs must not publish host ports')
}

const apiPorts = services.api?.ports ?? []
if (apiPorts.length !== 1) {
  fail(`api: expected exactly one published port, got ${apiPorts.length}`)
} else {
  const [port] = apiPorts
  if (port.host_ip !== apiHostIp) {
    fail(
      `api: host publish address must be exactly ${apiHostIp}, ` +
        `got ${port.host_ip ?? '(unqualified)'}`
    )
  }
  if (Number(port.target) !== apiContainerPort) {
    fail(`api: container port must be ${apiContainerPort}, got ${port.target}`)
  }
  if ((port.protocol ?? 'tcp') !== 'tcp') {
    fail(`api: published port must be tcp, got ${port.protocol}`)
  }
  if (!/^[0-9]+$/.test(String(port.published))) {
    fail(`api: published host port must be a single number, got ${port.published}`)
  }
}

// HOST=0.0.0.0 只允许作为容器内部监听事实存在。
if (services.api?.environment?.HOST !== '0.0.0.0') {
  fail(
    `api: HOST must be 0.0.0.0 inside the container, got ` +
      `${services.api?.environment?.HOST ?? '(none)'}`
  )
}
if (String(services.api?.environment?.PORT) !== String(apiContainerPort)) {
  fail(`api: PORT must be ${apiContainerPort} inside the container`)
}

// --------------------------------------------------------------------------
// 7. 网络隔离
// --------------------------------------------------------------------------
const networks = resolved.networks ?? {}
if (networks.internal?.internal !== true) {
  fail('networks.internal must set internal: true (no gateway, no host port)')
}
const internalOnly = ['postgres', 'migrate', ...bootstrapServices]
for (const name of internalOnly) {
  const attached = Object.keys(services[name]?.networks ?? {}).sort()
  if (attached.join(',') !== 'internal') {
    fail(`${name}: must attach only to the internal network, got [${attached.join(', ')}]`)
  }
}
const apiNetworks = Object.keys(services.api?.networks ?? {}).sort()
if (apiNetworks.join(',') !== 'edge,internal') {
  fail(`api: expected networks [edge, internal], got [${apiNetworks.join(', ')}]`)
}

// --------------------------------------------------------------------------
// 8. 健康检查
// --------------------------------------------------------------------------
const postgresHealth = services.postgres?.healthcheck?.test ?? []
if (postgresHealth[0] !== 'CMD' || postgresHealth[1] !== 'pg_isready') {
  fail('postgres: healthcheck must use the image-provided pg_isready via CMD')
}

const apiHealth = services.api?.healthcheck?.test ?? []
if (apiHealth[0] !== 'CMD' || apiHealth[1] !== 'node') {
  fail('api: healthcheck must use the image-provided node binary via CMD')
}
const apiHealthText = apiHealth.join(' ')
for (const forbidden of ['curl', 'wget', 'apt', 'apt-get', 'apk', 'npm', 'pnpm', 'yarn']) {
  if (new RegExp(`(^|[^a-z])${forbidden}([^a-z]|$)`).test(apiHealthText)) {
    fail(`api: healthcheck must not depend on ${forbidden} (nothing is installed at runtime)`)
  }
}

// --------------------------------------------------------------------------
// 9. Secret 边界
// --------------------------------------------------------------------------
const secretKeyPattern = /(PASSWORD|PASSWD|SECRET|TOKEN|DSN)$/
const connectionStringPattern = /^postgres(ql)?:\/\//i
const credentialsInUrlPattern = /:\/\/[^/\s]*:[^/\s]*@/

for (const name of serviceNames) {
  for (const [key, rawValue] of Object.entries(services[name].environment ?? {})) {
    const value = rawValue === null ? '' : String(rawValue)
    if (secretKeyPattern.test(key)) {
      fail(`${name}: ${key} must not carry a value in Compose; use a secret file`)
    }
    if (key === 'DATABASE_URL' || key === 'PGPASSWORD') {
      fail(`${name}: ${key} must not appear in Compose; use a secret file`)
    }
    if (connectionStringPattern.test(value) || credentialsInUrlPattern.test(value)) {
      fail(`${name}: ${key} looks like a connection string with credentials`)
    }
  }
}

// 每个服务只能拿到它那一步需要的凭据。API runtime 尤其不得持有 bootstrap 或
// migration 凭据（阶段 09A 验收门禁 #4）。
const expectedSecrets = {
  api: ['meal_agent_runtime_database_url'],
  migrate: ['meal_agent_migration_database_url'],
  'bootstrap-schema': ['meal_agent_admin_database_url'],
  postgres: ['postgres_superuser_password'],
  'bootstrap-cluster': ['postgres_admin_pgpass'],
  'bootstrap-createdb': ['postgres_admin_pgpass'],
  'bootstrap-handoff': ['postgres_admin_pgpass'],
  'bootstrap-acl': ['postgres_admin_pgpass'],
  'bootstrap-grants': ['postgres_admin_pgpass'],
  'bootstrap-logins': [
    'meal_agent_backup_password',
    'meal_agent_migration_password',
    'meal_agent_runtime_password',
    'postgres_admin_pgpass'
  ]
}
for (const name of serviceNames) {
  const granted = (services[name].secrets ?? [])
    .map((entry) => entry.source)
    .sort()
  const expected = [...(expectedSecrets[name] ?? [])].sort()
  if (granted.join(',') !== expected.join(',')) {
    fail(
      `${name}: least-privilege secret set drifted: got ` +
        `[${granted.join(', ')}], expected [${expected.join(', ')}]`
    )
  }
}
const apiSecrets = (services.api?.secrets ?? []).map((entry) => entry.source)
for (const forbidden of apiSecrets.filter((source) => /admin|migration|backup/.test(source))) {
  fail(`api: runtime must never receive the ${forbidden} credential`)
}

// 每个 secret 都必须指向未跟踪的文件：Compose 只声明路径，不声明值。
for (const [name, definition] of Object.entries(resolved.secrets ?? {})) {
  const file = definition.file
  if (typeof file !== 'string' || file === '') {
    fail(`secret ${name}: must be backed by a file`)
    continue
  }
  const tracked = runGit(['ls-files', '--', file]).trim()
  if (tracked !== '') {
    fail(`secret ${name}: ${file} is tracked by git; secrets must stay untracked`)
  }
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o777
    if ((mode & 0o077) !== 0) {
      fail(
        `secret ${name}: ${file} is group/world accessible ` +
          `(mode ${mode.toString(8).padStart(3, '0')}); use chmod 600`
      )
    }
  }
}

// --------------------------------------------------------------------------
// 结果
// --------------------------------------------------------------------------
if (failures.length > 0) {
  process.stderr.write('Compose topology check FAIL\n')
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}

process.stdout.write(
  `Compose topology check PASS (${serviceNames.length} services, ` +
    `${Object.keys(resolved.secrets ?? {}).length} secret files, ` +
    `${Object.keys(networks).length} networks)\n`
)
