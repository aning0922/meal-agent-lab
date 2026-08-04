// 阶段 09A / M3B：八份 local-test Secret 的**唯一事实源**。
//
// 生成器（generate-local-test-secrets.mjs）与预检（preflight-local-test-secrets.mjs）
// 都从这里取文件清单、角色、host/port/database 常量、派生规则与判据实现；两边不再
// 各自维护一份手写事实表——generator 能写出的每一个字节，preflight 都按同一份
// 常量重新推导后比对。
//
// 部署 identity 在 M3B 是固定的（与 M2B 固定的 Compose 拓扑一致）：
//   host=postgres port=5432 database=meal_agent
//   admin=postgres migration=meal_agent_migration_login runtime=meal_agent_runtime_login
//
// 本模块**从不**把 Secret 取值放进错误消息、返回的问题列表或任何输出：所有 reason
// 只包含文件名、字段名与原因。
import { spawnSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync
} from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))

/** 仓库根（infra/docker/ 的上两级）。模板扫描与 git 判定都锚定在这里。 */
export const repositoryRoot = resolve(moduleDirectory, '..', '..')

// 这些变量会改写 Git 命令看到的 repository / worktree / index / object database
// 或 pathspec。containment 的安全边界必须是调用方传入的 canonical repository，
// 不能继承 ambient Git plumbing view；存在任意一项时只报告变量名并 fail closed。
const gitRepositoryViewVariables = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_REPLACE_REF_BASE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_LITERAL_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
  'GIT_CONFIG',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_PARAMETERS'
])

export const ambientGitRepositoryViewOverrides = (environment = process.env) =>
  Object.keys(environment)
    .filter(
      (name) =>
        gitRepositoryViewVariables.has(name) ||
        /^GIT_CONFIG_(?:COUNT|KEY_[0-9]+|VALUE_[0-9]+)$/.test(name)
    )
    .sort()

const assertNoAmbientGitRepositoryViewOverrides = (environment = process.env) => {
  const overrides = ambientGitRepositoryViewOverrides(environment)
  if (overrides.length > 0) {
    throw new Error(
      `ambient Git repository view overrides are not permitted: ${overrides.join(', ')}`
    )
  }
}

/**
 * 所有 production Git 读取都显式禁用 replace-object 解析。repo-level preflight
 * 与每次读取必须同时存在：前者拒绝一张非 canonical 仓库视图，后者关闭
 * preflight 与 blob 读取之间新增 replace ref 的窄竞态。
 */
export const canonicalGitArguments = (arguments_) => [
  '--no-replace-objects',
  ...arguments_
]

export const assertCanonicalGitRepositoryView = (
  repository = repositoryRoot,
  environment = process.env
) => {
  assertNoAmbientGitRepositoryViewOverrides(environment)
  const replacements = spawnSync(
    'git',
    canonicalGitArguments([
      'for-each-ref',
      '--count=1',
      '--format=x',
      'refs/replace/'
    ]),
    {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    }
  )
  if (replacements.error !== undefined || replacements.status !== 0) {
    throw new Error('the canonical Git replacement-ref view could not be verified')
  }
  if (replacements.stdout.trim() !== '') {
    throw new Error('repository-local Git replacement refs are not permitted')
  }
}

/** Compose 契约的默认 secret 目录（`MEAL_AGENT_SECRETS_DIR` 未设置时的回落）。 */
export const defaultSecretsDirectory = resolve(moduleDirectory, 'secrets')

/** 默认目录里唯二允许的非 Secret 条目（tracked 说明与忽略规则）。 */
export const defaultDirectoryAllowedEntries = Object.freeze([
  '.gitignore',
  'README.md'
])

/**
 * 固定的部署 identity。与 compose.local-test.yaml（M2B Accepted）逐字一致：
 * 数据库名是字面量 meal_agent，bootstrap 的 psql 任务连 maintenance 库 postgres。
 */
export const deploymentIdentity = Object.freeze({
  host: 'postgres',
  port: 5432,
  database: 'meal_agent',
  maintenanceDatabase: 'postgres',
  adminUser: 'postgres',
  migrationUser: 'meal_agent_migration_login',
  runtimeUser: 'meal_agent_runtime_login'
})

/**
 * 四个**原始**随机口令的角色。八个文件全部由这四个值派生，不存在第五个来源。
 * backup 口令在 M3B 只进入 bootstrap-logins（建立 SCRAM verifier）；它的备份
 * 生命周期属于 M4。
 */
export const passwordRoles = Object.freeze([
  'superuser',
  'migration',
  'runtime',
  'backup'
])

/**
 * 口令字母表：URL userinfo 与 pgpass **双安全**。
 * 只含字母数字，因此：不需要百分号编码（node-postgres 拿到的就是原始字节）、
 * 不含 pgpass 的转义字符 `:` 与 `\`、不含 shell/psql 需要引用的任何字符。
 */
export const passwordAlphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** 62^48 ≈ 2^285：远超口令强度需要，也让「相同口令」只能来自复制。 */
export const passwordLength = 48

// 口令长度**精确钉住**为 passwordLength（48）：预检不接受任何其他长度，
// 手写 bundle 也必须用同长度的 CSPRNG 值（用 generator 就不会遇到这条）。

/** 与 M3A 消费侧一致的单文件字节上限。 */
export const maximumSecretFileBytes = 4096

/**
 * 八份 Secret 文件的清单。`name` 是 Compose 顶层 secret 名，`filename` 是
 * backing file 名（唯一不同名的是 pgpass），`consumerUid` 是容器内消费进程的
 * EUID（Docker Desktop 会把 bind 进来的 secret 呈现为该 UID 所有，M3B 探针
 * 已在容器内实测）。
 */
export const secretFiles = Object.freeze([
  Object.freeze({
    name: 'postgres_superuser_password',
    filename: 'postgres_superuser_password',
    kind: 'password',
    role: 'superuser',
    consumerUid: 999
  }),
  Object.freeze({
    name: 'postgres_admin_pgpass',
    filename: 'postgres_admin.pgpass',
    kind: 'pgpass',
    role: 'superuser',
    consumerUid: 999
  }),
  Object.freeze({
    name: 'meal_agent_migration_password',
    filename: 'meal_agent_migration_password',
    kind: 'password',
    role: 'migration',
    consumerUid: 999
  }),
  Object.freeze({
    name: 'meal_agent_runtime_password',
    filename: 'meal_agent_runtime_password',
    kind: 'password',
    role: 'runtime',
    consumerUid: 999
  }),
  Object.freeze({
    name: 'meal_agent_backup_password',
    filename: 'meal_agent_backup_password',
    kind: 'password',
    role: 'backup',
    consumerUid: 999
  }),
  Object.freeze({
    name: 'meal_agent_admin_database_url',
    filename: 'meal_agent_admin_database_url',
    kind: 'url',
    role: 'superuser',
    user: deploymentIdentity.adminUser,
    consumerUid: 10001
  }),
  Object.freeze({
    name: 'meal_agent_migration_database_url',
    filename: 'meal_agent_migration_database_url',
    kind: 'url',
    role: 'migration',
    user: deploymentIdentity.migrationUser,
    consumerUid: 10001
  }),
  Object.freeze({
    name: 'meal_agent_runtime_database_url',
    filename: 'meal_agent_runtime_database_url',
    kind: 'url',
    role: 'runtime',
    user: deploymentIdentity.runtimeUser,
    consumerUid: 10001
  })
])

export const secretFilenames = Object.freeze(
  secretFiles.map((entry) => entry.filename)
)

/** 生成一个 CSPRNG 口令。randomInt 均匀取样，没有模偏差。 */
export const generatePassword = () => {
  let value = ''
  for (let index = 0; index < passwordLength; index += 1) {
    value += passwordAlphabet[randomInt(passwordAlphabet.length)]
  }
  return value
}

/** 连接 URL 的 canonical 形态。八个文件里的三条 URL 只能是这个形状。 */
export const renderDatabaseUrl = (user, password) =>
  `postgresql://${user}:${password}@${deploymentIdentity.host}:` +
  `${String(deploymentIdentity.port)}/${deploymentIdentity.database}`

/**
 * pgpass 只覆盖**两个精确 endpoint**（不用 database=* 宽泛规则）：
 * maintenance 库（cluster/logins/createdb）与目标库（handoff/acl/grants）。
 */
export const pgpassEndpointDatabases = Object.freeze([
  deploymentIdentity.maintenanceDatabase,
  deploymentIdentity.database
])

export const renderPgpassLines = (superuserPassword) =>
  pgpassEndpointDatabases.map(
    (database) =>
      `${deploymentIdentity.host}:${String(deploymentIdentity.port)}:` +
      `${database}:${deploymentIdentity.adminUser}:${superuserPassword}`
  )

/**
 * 由四个原始口令派生八个文件体（不含末尾 LF；写文件时统一补一个 LF）。
 * 这是生成与预检共用的**同一个**派生函数。
 */
export const deriveSecretBodies = (passwords) => {
  for (const role of passwordRoles) {
    if (typeof passwords[role] !== 'string' || passwords[role] === '') {
      throw new Error(`deriveSecretBodies: missing the ${role} password`)
    }
  }
  const bodies = new Map()
  for (const entry of secretFiles) {
    if (entry.kind === 'password') {
      bodies.set(entry.filename, passwords[entry.role])
    } else if (entry.kind === 'pgpass') {
      bodies.set(entry.filename, renderPgpassLines(passwords.superuser).join('\n'))
    } else {
      bodies.set(entry.filename, renderDatabaseUrl(entry.user, passwords[entry.role]))
    }
  }
  return bodies
}

// ---------------------------------------------------------------------------
// 预检实现（fail closed）
// ---------------------------------------------------------------------------

const passwordPattern = /^[A-Za-z0-9]+$/

/**
 * 打开并读取一个 secret 文件，返回 { body, problems }。
 * 判据与 M3A 的消费侧按条对齐：O_NOFOLLOW|O_NONBLOCK 打开后 **fstat**、普通
 * 文件、nlink=1、owner=expectedOwnerUid、owner-only 0400/0600、≤4096 字节、
 * 非空、合法 UTF-8、无 NUL/BOM/CR，最多移除一个末尾 LF。
 * 任何一条不满足都记 problem 并返回 body=null；绝不把文件内容放进 problem。
 */
const readSecretFileForPreflight = (path, filename, expectedOwnerUid) => {
  const problems = []
  let symlink = false
  try {
    symlink = lstatSync(path).isSymbolicLink()
  } catch {
    problems.push(`${filename}: missing from the bundle directory`)
    return { body: null, problems }
  }
  if (symlink) {
    problems.push(`${filename}: is a symbolic link; secret files must be opened directly`)
    return { body: null, problems }
  }

  let fd
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'unknown'
    problems.push(`${filename}: could not be opened (${code})`)
    return { body: null, problems }
  }

  try {
    const stats = fstatSync(fd)
    if (!stats.isFile()) {
      problems.push(
        `${filename}: is not a regular file (directories, FIFOs, sockets and devices are rejected)`
      )
      return { body: null, problems }
    }
    if (stats.nlink !== 1) {
      problems.push(
        `${filename}: has ${String(stats.nlink)} hard links; a secret file must have exactly one name`
      )
      return { body: null, problems }
    }
    if (stats.uid !== expectedOwnerUid) {
      problems.push(
        `${filename}: is owned by uid ${String(stats.uid)} but the expected owner is uid ${String(expectedOwnerUid)}`
      )
      return { body: null, problems }
    }
    const permissions = stats.mode & 0o7777
    if ((permissions & 0o7177) !== 0 || (permissions & 0o400) === 0) {
      problems.push(
        `${filename}: has mode ${permissions.toString(8).padStart(4, '0')}; only owner-only 0400 or 0600 is accepted`
      )
      return { body: null, problems }
    }
    if (stats.size > maximumSecretFileBytes) {
      problems.push(
        `${filename}: is ${String(stats.size)} bytes; the limit is ${String(maximumSecretFileBytes)}`
      )
      return { body: null, problems }
    }

    const buffer = Buffer.alloc(maximumSecretFileBytes + 1)
    let read = 0
    for (;;) {
      const chunk = readSync(fd, buffer, read, buffer.length - read, null)
      if (chunk === 0) {
        break
      }
      read += chunk
      if (read > maximumSecretFileBytes) {
        problems.push(
          `${filename}: is larger than ${String(maximumSecretFileBytes)} bytes`
        )
        return { body: null, problems }
      }
    }
    if (read !== stats.size) {
      problems.push(`${filename}: changed size while it was being read`)
      return { body: null, problems }
    }

    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, read)
      )
    } catch {
      problems.push(`${filename}: is not valid UTF-8`)
      return { body: null, problems }
    }
    const body = text.endsWith('\n') ? text.slice(0, -1) : text
    if (body === '') {
      problems.push(`${filename}: is empty`)
      return { body: null, problems }
    }
    if (body.endsWith('\n')) {
      problems.push(`${filename}: ends with more than one newline`)
      return { body: null, problems }
    }
    if (body.includes('\u0000')) {
      problems.push(`${filename}: contains a NUL byte`)
      return { body: null, problems }
    }
    if (body.includes('\uFEFF')) {
      problems.push(`${filename}: contains a byte order mark`)
      return { body: null, problems }
    }
    if (body.includes('\r')) {
      problems.push(
        `${filename}: contains a carriage return (CRLF line endings are rejected)`
      )
      return { body: null, problems }
    }
    return { body, problems }
  } finally {
    closeSync(fd)
  }
}

/** 单行文件（口令与 URL）不允许包含任何内部 LF。 */
const assertSingleLine = (filename, body, problems) => {
  if (body.includes('\n')) {
    problems.push(`${filename}: must contain a single line`)
    return false
  }
  return true
}

const checkPasswordBody = (filename, body, problems) => {
  if (!assertSingleLine(filename, body, problems)) {
    return null
  }
  if (!passwordPattern.test(body)) {
    problems.push(
      `${filename}: the password must use only [A-Za-z0-9] so it stays safe in both URLs and pgpass`
    )
    return null
  }
  if (body.length !== passwordLength) {
    problems.push(
      `${filename}: the password must be exactly ${String(passwordLength)} characters`
    )
    return null
  }
  return body
}

/**
 * URL 的字段级判据。每条给出**指定理由**；最后一道 canonical 全等比较兜住
 * userinfo 绕过、编码变体等一切字段检查看不见的形态。
 */
const checkUrlBody = (filename, body, entry, passwordBody, problems) => {
  if (!assertSingleLine(filename, body, problems)) {
    return
  }
  if (!body.startsWith('postgresql://')) {
    problems.push(`${filename}: the connection URL must start with postgresql://`)
    return
  }
  let url
  try {
    url = new URL(body)
  } catch {
    problems.push(`${filename}: the connection URL is not a valid URL`)
    return
  }
  if (url.search !== '') {
    problems.push(`${filename}: the connection URL must not carry a query string`)
  }
  if (url.hash !== '') {
    problems.push(`${filename}: the connection URL must not carry a fragment`)
  }
  if (url.hostname !== deploymentIdentity.host) {
    problems.push(
      `${filename}: the connection URL host must be ${deploymentIdentity.host}` +
        ' (a Unix socket path or any other host is rejected)'
    )
  }
  if (url.port !== String(deploymentIdentity.port)) {
    problems.push(
      `${filename}: the connection URL port must be ${String(deploymentIdentity.port)}`
    )
  }
  if (url.pathname !== `/${deploymentIdentity.database}`) {
    problems.push(
      `${filename}: the connection URL database must be exactly /${deploymentIdentity.database}`
    )
  }
  if (url.username !== entry.user) {
    problems.push(`${filename}: the connection URL user must be ${entry.user}`)
  }
  if (passwordBody !== null && url.password !== passwordBody) {
    problems.push(
      `${filename}: the connection URL password does not match the ` +
        `${entry.role} password file`
    )
  }
  // canonical 全等：任何字段检查看不见的形态（第二个 @、编码变体、大小写
  // scheme、显式空字段）都在这里被拒绝。
  if (passwordBody !== null && body !== renderDatabaseUrl(entry.user, passwordBody)) {
    problems.push(
      `${filename}: the connection URL is not byte-identical to the canonical ` +
        `postgresql://${entry.user}:<password>@${deploymentIdentity.host}:` +
        `${String(deploymentIdentity.port)}/${deploymentIdentity.database} form`
    )
  }
}

const checkPgpassBody = (filename, body, superuserBody, problems) => {
  const lines = body.split('\n')
  if (lines.length !== pgpassEndpointDatabases.length) {
    problems.push(
      `${filename}: must contain exactly ${String(pgpassEndpointDatabases.length)} ` +
        `endpoint lines (${pgpassEndpointDatabases.join(', ')}), got ${String(lines.length)}`
    )
    return
  }
  for (const [index, line] of lines.entries()) {
    const database = pgpassEndpointDatabases[index]
    const fields = line.split(':')
    if (fields.length !== 5) {
      problems.push(
        `${filename}: endpoint line ${String(index + 1)} must have exactly 5 ` +
          'colon-separated fields'
      )
      continue
    }
    const [host, port, db, user] = fields
    if ([host, port, db, user].includes('*')) {
      problems.push(
        `${filename}: endpoint line ${String(index + 1)} must not use wildcard rules`
      )
      continue
    }
    if (host !== deploymentIdentity.host) {
      problems.push(
        `${filename}: endpoint line ${String(index + 1)} host must be ${deploymentIdentity.host}`
      )
    }
    if (port !== String(deploymentIdentity.port)) {
      problems.push(
        `${filename}: endpoint line ${String(index + 1)} port must be ${String(deploymentIdentity.port)}`
      )
    }
    if (db !== database) {
      problems.push(
        `${filename}: endpoint line ${String(index + 1)} database must be ${database}`
      )
    }
    if (user !== deploymentIdentity.adminUser) {
      problems.push(
        `${filename}: endpoint line ${String(index + 1)} user must be ${deploymentIdentity.adminUser}`
      )
    }
    if (superuserBody !== null && line !== `${deploymentIdentity.host}:${String(deploymentIdentity.port)}:${database}:${deploymentIdentity.adminUser}:${superuserBody}`) {
      if (
        host === deploymentIdentity.host &&
        port === String(deploymentIdentity.port) &&
        db === database &&
        user === deploymentIdentity.adminUser
      ) {
        problems.push(
          `${filename}: endpoint line ${String(index + 1)} password does not ` +
            'match the superuser password file'
        )
      }
    }
  }
}

/** git 无法判定时抛错（缺前置工具/意外退出码不等于「未跟踪」）。 */
const gitTracksPath = (repository, path) => {
  assertCanonicalGitRepositoryView(repository)
  const result = spawnSync(
    'git',
    canonicalGitArguments(['ls-files', '--error-unmatch', '--', path]),
    { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
  )
  if (result.error !== undefined) {
    throw new Error(
      `cannot determine git tracking (failed to run git: ${result.error.message})`
    )
  }
  if (result.status === 0) {
    return true
  }
  if (result.status === 1) {
    return false
  }
  throw new Error(
    `cannot determine git tracking for ${path} (git ls-files exit=${String(result.status)})`
  )
}

const enclosingGitRepository = (directory) => {
  assertNoAmbientGitRepositoryViewOverrides()
  const result = spawnSync('git', canonicalGitArguments([
    '-C',
    directory,
    'rev-parse',
    '--show-toplevel'
  ]), {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  })
  if (result.error !== undefined) {
    throw new Error(
      `cannot determine the enclosing git repository (failed to run git: ${result.error.message})`
    )
  }
  if (result.status === 0) {
    const repository = resolve(result.stdout.trim())
    assertCanonicalGitRepositoryView(repository)
    return repository
  }
  // **只有「确实不在 git 仓库里」才允许跳过**跟踪判定。其余非零退出
  // （dubious ownership、bare 仓库、子进程被信号杀掉导致 status === null）
  // 一律 fail closed——此前一律返回 null，等于让整条「Secret 不得被 git
  // 跟踪 + .gitignore 覆盖」的防线静默消失。
  const stderr = String(result.stderr ?? '')
  if (/not a git repository|não é um repositório/i.test(stderr)) {
    return null
  }
  throw new Error(
    'cannot determine the enclosing git repository ' +
      `(git rev-parse exited ${String(result.status)}); the tracked-secret checks ` +
      'cannot be skipped silently'
  )
}

/**
 * tracked 模板扫描：`infra/environments/` 下任何 tracked 文件出现非空的
 * password/token/AppID/AppSecret/key/DSN 赋值、或任何完整连接串（带 userinfo
 * 或带 password 查询参数），都 fail closed。空占位（`WECHAT_APP_ID=`）明确
 * 允许。**注释行同样扫描**——被注释掉的真实凭据仍然是泄漏进 Git 的凭据。
 * 扫描到零个 tracked 文件时抛错：静默零覆盖不是通过。
 */
const sensitiveKeySuffixes = [
  'PASSWORD',
  'PASSWD',
  'PASS',
  'PWD',
  'TOKEN',
  'SECRET',
  'KEY',
  'KEY_BASE',
  'CREDENTIAL',
  'CREDENTIALS',
  'APP_ID',
  'APPID',
  // `PRIVATE_KEY` 已由 `KEY` 后缀覆盖；`SIGNATURE` 需要单列。
  'SIGNATURE',
  'DSN',
  'DATABASE_URL',
  'URL',
  'URI'
]
// 分段器用的赋值文法。空白一律**只认 ASCII SPACE / TAB**，与
// `sensitiveAssignmentsIn` 的文法同源：此前这里是 `^\s*…\s*=`，`\s` 会把 NBSP
// 之类一并吃掉，于是同一个字符在「分段」和「敏感赋值」两处得到相反结论——
// `PASSWORD=""<NBSP>` 会被分段器判成 ambiguous，最后以
// `unscannable connection string candidate` 报出来（那一行根本没有连接串）。
/**
 * `export` 前缀：Node 只认 `export` + **一个或多个 SPACE**。
 *
 * 实测 v24.18.0：`export PASSWORD=A` 与 `export  PASSWORD=B` 建的键都是
 * `PASSWORD`；`export \tPASSWORD=E` 也是 `PASSWORD`（前缀认掉之后键的前导空白被
 * 去掉）；但 `export\tPASSWORD=C` 建的键是**完整的** `export\tPASSWORD`——TAB 不是
 * 前缀分隔符。`export[ \t]+` 那种写法把 TAB 也算进去，等于凭空发明了一条 Node
 * 没有的文法。
 */
const exportPrefixSource = 'export +'
const exportPrefixPattern = new RegExp(`^${exportPrefixSource}`)

// `export` 前缀的唯一事实源见 `exportPrefixPattern`：Node 只认 `export` + 一个或
// 多个 **SPACE**。此前这里写 `export[ \t]+`，那是**冒充** Node 文法——实测
// v24.18.0，`export\tPASSWORD=C` 建的键是完整的 `export\tPASSWORD`，不是 PASSWORD。
const assignmentPattern = new RegExp(
  `^[ \\t]*(?:${exportPrefixSource})?([A-Za-z_][A-Za-z0-9_]*)[ \\t]*=(.*)$`
)

/**
 * 连接串里的凭据判据。**两条都与赋值键名无关**：判据看的是行内容本身，因此
 * `CACHE_ENDPOINT=redis://TOKEN@redis:6379/0` 这种「中性键 + 有凭据的连接串」
 * 同样会被抓住——凭据是不是泄漏，取决于它写没写进文件，不取决于左边那个变量
 * 叫什么名字。
 *
 * 1. **userinfo 形**（任意 scheme、任意 userinfo 形态）。此前只认
 *    `user:password@`：必须有那个冒号、且两侧都至少一个字符。实测因此漏掉
 *    - `https://ghp_TOKEN@github.com`（token-only：`@` 前无冒号），
 *    - `postgresql://:pw@host/db`（password-only：冒号左侧为空），
 *    - `redis://@host`（退化形）。
 *    现在只要 `scheme://…@host` 的 authority 里出现 `@` 就拒绝。`@` 之前不允许
 *    出现 `/`、`?`、`#`，因此 `https://example.com/a@b` 这类路径里的 `@` 不会
 *    被误判成 userinfo。
 * 2. **credential 查询参数形**（任意 scheme）。此前锚死在 postgres + 词干
 *    `password`，于是 `redis://redis:6379?password=…`、任何 scheme 的
 *    `?token=`/`?secret=`/`?api_key=`/`?access_token=`/`?pwd=`/`?passwd=` 全部
 *    漏网。键名允许带前后缀（`sslpassword`、`x-access_token`）。取值必须非空：
 *    `?password=` 这样的空占位与模板的「空占位允许」规则一致。
 */
const credentialQueryKeyStems = [
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'api[_.-]?key',
  'access[_.-]?token',
  'credential'
]
const credentialQueryCategory = 'contains a connection string with a credential query parameter'
// userinfo 形的固定类别。**单一来源**：下面的 `fullDsnPatterns[0].category` 直接
// 引用它，原始文本正则与 URL 解析器两条路径因此不可能各自漂移成两个字符串。
const userinfoCategory = 'contains a full connection string with credentials'
// 固定类别：扫描器**没能完整扫完**这一行的连接串候选。消息里只有类别、文件与
// 行号，绝不回显 URL、key 或取值。
const unscannableCategory = 'contains an unscannable connection string candidate'
const fullDsnPatterns = [
  {
    // 顺序固定：userinfo 形排在最前，两条既有反例继续命中这条消息。
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]*@[^\s/?#]+/i,
    category: userinfoCategory
  },
  {
    // **原始文本**上的词干判据。它抓不到百分号编码（`pass%77ord`），因此下面
    // 还有一层按**解码后**的 query key 判定；两层并存，任一命中即拒绝。
    pattern: new RegExp(
      String.raw`[a-z][a-z0-9+.-]*://\S*[?&][^\s=&#]*(?:` +
        credentialQueryKeyStems.join('|') +
        String.raw`)[^\s=&#]*=[^\s&#]`,
      'i'
    ),
    category: credentialQueryCategory
  }
]

/**
 * 词干的**紧凑**形态：判定前把 key 转小写并去掉 `-`/`_`/`.`，因此
 * `api_key`、`apiKey`、`API-KEY`、`x-access_token` 归到同一判据上。
 */
const compactCredentialStems = [
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'apikey',
  'accesstoken',
  'credential',
  // 精确追加（审计 S5 的一部分）：`private_key` 与 `signature`。紧凑化之后
  // `private%5Fkey` / `signa%74ure` 解码出来的键同样命中。**刻意不加**宽泛的
  // `auth` / `session` / `salt`——那三个词在非凭据语境里太常见，扩进来需要各自
  // 的误报分析与反例，不属于本轮 bounded 范围。
  'privatekey',
  'signature'
]

/** 资源上限：一行最多 8 个 `scheme://` 起点，每个候选最长 2048 字符。 */
const maximumCandidates = 8
const maximumCandidateLength = 2048

/**
 * 一行里**受支持的 dotenv 逻辑取值**片段。
 *
 * 边界判据不再来自任何 URL 字符表。`candidateDelimiter`（标点表）与
 * `candidateWhitespace`（空白表）都已删除：URL 里哪个字符是分隔符只有 WHATWG
 * 解析器有资格回答，而**一个取值在哪里结束**是 dotenv 语法的问题，不是 URL 的
 * 问题。前几轮反复在字符表上打补丁，正是因为把这两件事混成了一件。
 *
 * 判据（逐条明确，含异常形态）：
 *
 *   - **注释**：行首的 `#` 反复剥离后再判定。被注释掉的凭据仍然是进了 Git 的
 *     凭据，必须照扫；
 *   - **赋值**：`KEY=` 之后的部分是取值。非赋值形态（README 散文等）整行作为
 *     一个片段，覆盖面与此前一致；
 *   - **quoted**：取值以 `"` 或 `'` 开头时，边界是**配对的同种引号**。引号内
 *     的空格与制表符**原样保留**，绝不截断——这正是
 *     `NOTES="https://host/path rest?…"` 此前被切断的原因；
 *   - **unquoted**：主取值一直到行尾（尾部空白去掉），**不因行内 `#` 截断**；
 *     「空白 + `#`」之后的部分**额外**再生成一个 comment 片段供敏感赋值判据使用
 *     （它是主取值的子串，因此不重复参与 DSN 起点计数）；
 *   - **异常/未闭合**：引号没有配对、或闭合引号之后还跟着**非空白且非 `#`**
 *     的内容——两者都是「这一行的取值边界不明确」，直接 fail closed；闭合引号
 *     之后的 `#` 注释作为**另一个片段**继续扫描。
 */

/** Node-active 键的扫描上限（code point）。越界即无法判定 → fail closed。 */
const maximumActiveKeyLength = 2048

/** 连续空键（`=`、`==`、`= =`……）最多跳过多少段，越界即 fail closed。 */
const maximumActiveKeySegments = 16

/**
 * 这一行按 **Node `--env-file` 真实文法**解析出来的键与取值起点；不是赋值返回
 * `null`。strict 扫描、`export` 前缀语义与注释赋值判据都从这里取，**只有一份**。
 *
 * 文法（逐条实测得到）：
 *
 *   1. 整行注释（首个非空白字符是 `#`）不定义任何变量；
 *   2. 没有 `=` 不定义任何变量；
 *   3. 键 = **第一个使键非空的** `=` 之前的那段文本，去掉前导/尾随 ASCII 空白；
 *      `=` 之前 trim 后为空时 Node 会跳过它继续往后找（`=0PASSWD=V` 的键是
 *      `0PASSWD`），跳过的段数有上限，越界 fail closed；
 *   4. 键前可以有 `export` + SPACE（见 `exportPrefixPattern`），去掉之后再去一次
 *      前导空白。
 *
 * 键**没有字符集限制**：`0PASSWD`、`1PASSWORD`、`PASSWORD-FILE`、
 * `FOO # PASSWORDé` 全都是 Node 真实建立的键（实测）。此前 strict 走的是
 * `[A-Za-z_][A-Za-z0-9_]*` 的自由文本 keyPattern，数字开头的键一条都匹配不上——
 * `0PASSWD=AUDITVALUE` 这类**活凭据** 8/8 全部漏检。
 */
export const nodeActiveAssignment = (line) => {
  const text = String(line)
  if (/^[ \t]*#/.test(text)) {
    return null
  }
  // Node **不是**在第一个 `=` 处停下：如果 `=` 之前的文本 trim 之后是空的，它会
  // 跳过这个 `=` 继续往后找。实测 v24.18.0：`=0PASSWD=AUDITVALUE` 建的键是
  // `0PASSWD`、`=PASSWORDé=AUDITVALUE` 建的是 `PASSWORDé`、`==…`/`= …`/`  =…`
  // 同理。此前这里只看 `indexOf('=')`，键取到空串就返回 null——于是**在行首多打
  // 一个 `=` 就能让整条 strict 通路失效**（审计实测 6/6，其中 `=0PASSWD=` 正好
  // 绕过本轮新增的数字开头键判据）。
  let segmentFrom = 0
  for (let seen = 0; seen < maximumActiveKeySegments; seen += 1) {
    const equals = text.indexOf('=', segmentFrom)
    if (equals === -1) {
      return null
    }
    let key = text.slice(segmentFrom, equals).replace(/^[ \t]+/, '')
    const exported = exportPrefixPattern.exec(key)
    if (exported !== null) {
      // 只有**剥掉之后仍有键名**时才认这个前缀。实测 `export =PASSWORD=V` 的键
      // 就是 `export` 本身（Node 没把它当前缀），剥空会让我们错认成 `PASSWORD`。
      const stripped = key.slice(exported[0].length).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')
      if (stripped !== '') {
        key = stripped
      }
    }
    key = key.replace(/[ \t]+$/, '')
    if (key !== '') {
      return {
        key,
        valueFrom: equals + 1,
        // 超长键无法可靠判定 → 按 ambiguous 处理 → fail closed。
        overLength: [...key].length > maximumActiveKeyLength
      }
    }
    segmentFrom = equals + 1
  }
  // 恰好消费完上限且后面已经没有另一个 `=` 时，没有任何未扫描候选：
  // `================`（16 个）只是 16 个空段，必须保持干净。只有余下文本里
  // **确实还有一个赋值候选**时才算 exhausted；第 17 个 `=` 或 16 个空段后再跟
  // `0PASSWD=...` 都走 fail closed。
  if (text.indexOf('=', segmentFrom) === -1) {
    return null
  }
  // 连续空键超出上限：放弃解析不等于放行。
  return { key: '', valueFrom: segmentFrom, overLength: true, exhausted: true }
}

const compactSensitiveTokens = new Set(
  sensitiveKeySuffixes.flatMap((suffix) => {
    const compact = suffix.replace(/[^A-Z0-9]/g, '')
    return [compact, `${compact}S`]
  })
)
for (const token of ['PRIVATEKEY', 'APIKEY', 'XAPIKEY']) {
  compactSensitiveTokens.add(token)
}
const maximumCompactSensitiveTokenLength = Math.max(
  ...[...compactSensitiveTokens].map((token) => token.length)
)
const weakPunctuationTokens = new Set(['PASS', 'PWD', 'KEY', 'URL', 'URI', 'DSN'])
// 标点把 weak stem 独立成一个完整词元时默认 fail closed。不能维护一份有限的
// 「credential qualifier」表：`KEY-MATERIAL`、`PASS-PIN`、`DSN-STRING` 只需换
// 一个新后缀就能绕过。少量**完整 compound** 例外只为钉住已实证的普通英文词；
// 默认方向仍是拒绝未知 compound，而不是猜它是否像凭据。
const benignWeakPunctuationCompounds = new Set([
  'COMPASSION',
  'KEYBOARD',
  'PASSAGE',
  'SECRETARY',
  'SIGNATURED',
  'TOKENYA'
])
const isBenignWeakPunctuationCompound = (value) =>
  benignWeakPunctuationCompounds.has(String(value).toUpperCase().replace(/[^A-Z0-9]/g, ''))
const stripBoundaryDigits = (value) => value.replace(/^\d+/, '').replace(/\d+$/, '')
const isExactCompactSensitiveToken = (value) =>
  value !== '' && compactSensitiveTokens.has(stripBoundaryDigits(value))

const tokenSequenceContainsSensitive = (tokens, { allowWeakSingleton }) => {
  const normalized = tokens.map((token) => stripBoundaryDigits(token.replace(/[^A-Z0-9]/g, '')))
  for (let start = 0; start < normalized.length; start += 1) {
    let joined = ''
    for (let end = start; end < normalized.length; end += 1) {
      joined += normalized[end]
      if (joined.length > maximumCompactSensitiveTokenLength) {
        break
      }
      const width = end - start + 1
      if (
        isExactCompactSensitiveToken(joined) &&
        (width > 1 || allowWeakSingleton || !weakPunctuationTokens.has(joined))
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * 一个 sensitive token 只有在其 occurrence **真正跨过**标点边界时才命中。
 * 这覆盖 `XPA-SSWORD` / `PA-SSWORDX`，同时不会把无分隔的
 * `1PASSWORDOLD2` 扩成新的策略，也不会用宽泛 includes 误伤普通 compound。
 */
const punctuationBoundaryCrossesSensitiveToken = (normalizedPieces) => {
  const compact = normalizedPieces.join('')
  const boundaries = []
  let offset = 0
  for (const piece of normalizedPieces.slice(0, -1)) {
    offset += piece.length
    boundaries.push(offset)
  }
  for (const token of compactSensitiveTokens) {
    let start = compact.indexOf(token)
    while (start !== -1) {
      const end = start + token.length
      if (boundaries.some((boundary) => boundary > start && boundary < end)) {
        return true
      }
      start = compact.indexOf(token, start + 1)
    }
  }
  return false
}

const keyCrossesSensitivePunctuationBoundary = (key) => {
  // 完整 benign compound 的裁决必须先于任何子片段拼接。否则
  // `COMP-ASSION` 会被下面的 crossing matcher 重新拼成 `COMPASSION`，再从中
  // 找到 `PASS`，使 direct 视图虽已短路，nested / quoted / prose 三个视图仍
  // 误报。这里与 `containsSensitiveKeyToken` 共用同一份完整键 allowlist，不再
  // 让调用视图决定结论。
  if (isBenignWeakPunctuationCompound(key)) {
    return false
  }
  const pieces = String(key).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
  const normalizedPieces = pieces.map((piece) => stripBoundaryDigits(piece))
  return punctuationBoundaryCrossesSensitiveToken(normalizedPieces)
}

/**
 * 敏感 token 是否真正跨过 `/` 本身，而不只是跨过同一 path segment 里的其他标点。
 *
 * `PRIVATE/KEY`、`DATABASE/URL`、`API/KEY` 都是注册 token 跨 slash；反过来，
 * `/api/pa-ssword` 与 `docs/pa-ssword` 的 `PASSWORD` 完全位于 slash 后的 segment，
 * 只是 segment 内又跨过 `-`。把两类形态混用一个宽泛 crossing boolean，会在
 * “关闭凭据绕过”和“保留文档 path”之间来回回退。
 */
const slashSensitiveOccurrencePosition = (key) => {
  if (isBenignWeakPunctuationCompound(key)) {
    return 'none'
  }
  const normalizedSegments = String(key)
    .toUpperCase()
    .split('/')
    .map((segment) => stripBoundaryDigits(segment.replace(/[^A-Z0-9]/g, '')))
  // 空 normalized segment 也保留它的**原始 path 位置**：`.` / `..` / `2026` /
  // `_` / `@` 都会归一成空串，但它们仍是 token 之前真实存在的 path segment。
  // 过滤它们会把 `./private/key` 错看成从第一个 segment 开始的 `PRIVATE/KEY`。
  const compact = normalizedSegments.join('')
  const segmentStarts = []
  const slashBoundaries = []
  let offset = 0
  for (const [index, segment] of normalizedSegments.entries()) {
    segmentStarts.push(offset)
    offset += segment.length
    if (index < normalizedSegments.length - 1) {
      slashBoundaries.push(offset)
    }
  }
  let suffixOccurrence = false
  for (const token of compactSensitiveTokens) {
    let start = compact.indexOf(token)
    while (start !== -1) {
      const end = start + token.length
      if (slashBoundaries.some((boundary) => boundary > start && boundary < end)) {
        const segmentIndex = segmentStarts.findLastIndex((segmentStart) => segmentStart <= start)
        if (segmentIndex === 0) {
          return 'first-segment'
        }
        suffixOccurrence = true
      }
      start = compact.indexOf(token, start + 1)
    }
  }
  return suffixOccurrence ? 'path-suffix' : 'none'
}

/**
 * Node-active 键的有界 stem matcher。下划线是词边界；词元内的 ASCII 标点可折叠，
 * 折叠后再剥首尾数字。因此 `1TOK-EN2` 与 `MY_TOK-EN_VALUE` 都找到 TOKEN。
 * weak stem 一旦成为完整标点词元就默认 fail closed；只有上面登记的完整 benign
 * compound（如 `PASS-AGE`）保持干净，未知后缀不再形成绕过词表。
 */
const containsSensitiveKeyToken = (key) => {
  // 必须在任何 component/window 判据**之前**作完整键裁决；否则 `PASS_AGE`
  // 会先以 `PASS` 这个独立 component 命中，永远走不到后面的整键短路。
  if (isBenignWeakPunctuationCompound(key)) {
    return false
  }
  const components = String(key).toUpperCase().split(/_+/).filter(Boolean)
  if (tokenSequenceContainsSensitive(components, { allowWeakSingleton: true })) {
    return true
  }
  for (const component of components) {
    if (/[^A-Z0-9]/.test(component)) {
      const pieces = component.split(/[^A-Z0-9]+/).filter(Boolean)
      const normalizedPieces = pieces.map((piece) =>
        stripBoundaryDigits(piece.replace(/[^A-Z0-9]/g, ''))
      )
      const wholeCompound = normalizedPieces.join('')
      // 完整 benign compound 必须在任何子窗口扫描**之前**短路；否则
      // `P-A-S-S-A-G-E` 仍会被动态窗口里的 `PASS` 重新命中。
      if (benignWeakPunctuationCompounds.has(wholeCompound)) {
        continue
      }
      if (punctuationBoundaryCrossesSensitiveToken(normalizedPieces)) {
        return true
      }
      // 保留 Round 16 之前已经覆盖的 suffix/token 语义。`XPASS-WORD` 的第一个
      // piece 是 `XPASS`，旧判据会因 endsWith(PASS) fail closed；Round 17 一度
      // 只判 compact exact token，把这个 Node-active 键回退成了漏检。
      if (pieces.some((piece) => isSensitiveKeyName(stripBoundaryDigits(piece)))) {
        return true
      }
      if (normalizedPieces.some((piece) => weakPunctuationTokens.has(piece))) {
        return true
      }
      if (tokenSequenceContainsSensitive(pieces, { allowWeakSingleton: false })) {
        return true
      }
    }
  }
  // 下划线也是分隔符，但它在上面的 legacy component 语义里先被切掉。
  // 因此再用整键视图判断一次“敏感 token 是否跨过任意分隔边界”，闭合
  // `XPA_SSWORD` / `PA_SSWORDX`，同时保留完整 benign compound 的短路。
  const wholeKeyPieces = String(key).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
  const normalizedWholeKeyPieces = wholeKeyPieces.map((piece) => stripBoundaryDigits(piece))
  const wholeKeyCompound = normalizedWholeKeyPieces.join('')
  if (
    !benignWeakPunctuationCompounds.has(wholeKeyCompound) &&
    punctuationBoundaryCrossesSensitiveToken(normalizedWholeKeyPieces)
  ) {
    return true
  }
  return false
}

/** 注释赋值判据的上限：键 run 长度与一行里的候选个数都有界。 */
const maximumCommentKeyLength = 256
const maximumCommentAssignments = 8

const isSensitivePathSuffix = (key) => {
  const slash = key.indexOf('/')
  if (slash === -1) {
    return false
  }
  const slashOccurrence = slashSensitiveOccurrencePosition(key)
  // 绝对 path，或敏感 occurrence 在一个完整 path segment **之后**才开始，均按
  // path suffix 处理：`/api/private/key`、`docs/private/key`、
  // `docs/xpa/ssword`。只有 occurrence 从第一个实际 segment 内开始并跨 slash 的
  // `PRIVATE/KEY` / `XPA/SSWORD` 才属于本轮要关闭的键名绕过。
  if (key.startsWith('/') || slashOccurrence === 'path-suffix') {
    return true
  }
  if (slashOccurrence === 'first-segment') {
    return false
  }
  return (
    !containsSensitiveKeyToken(key.slice(0, slash)) &&
    containsSensitiveKeyToken(key.slice(slash + 1))
  )
}

/**
 * `X>=`、`X+=`、`X!=`、`X<=` 这类**复合运算符**不是 dotenv 赋值。
 *
 * 这是注释判据里唯一的字符表，而且刻意只看**紧挨 `=` 的那一个字符**：
 * `# TOKEN >= 32 chars`、`# keys += 1`、`if (token != null)` 因此保持干净，而
 * `# PASSWORD-FILE=...`、`# PASSWORD(old)=...` 照常命中。
 */
const compoundOperatorTail = /[<>!+\-*/%&|^~?:=]$/

/**
 * URL / query 形状：`://`、`?`、`&` 出现在 run 里就不是 dotenv 键。
 *
 * 注释体里最常见的就是文档链接，而 Markdown 的 `#` 标题也会被当成注释体。审计
 * 实测新增 4 条误报：`# See https://api.example.com/v1/keys?limit=10`、
 * `# GET /api/secrets?page=2`、`# docs …/tokens?lang=zh`、
 * `# [keys](https://example.com/keys?ref=doc)`——Node 对它们不定义任何变量。
 * `PASSWORD/v2=…` 这类真正的键名续字符不含 `://`/`?`/`&`，照旧命中。
 */
const urlShapedRun = /:\/\/|[?&]/

/**
 * 这一行里的**注释体**（可能 0 或 1 段）。
 *
 * 整行注释取 `#` 之后的全部；否则只有**第一个 `=` 之后**出现的 ` #` 才是行内
 * 注释（`=` 之前的 `#` 对 Node 是普通键名字符）。
 */
const commentBodiesOf = (line) => {
  const text = String(line)
  const wholeLine = /^[ \t]*#+[ \t]*(.*)$/.exec(text)
  if (wholeLine !== null) {
    return [wholeLine[1]]
  }
  const equals = text.indexOf('=')
  if (equals === -1) {
    return []
  }
  // **不要求 `#` 前面有空白**：实测 v24.18.0，`NOTES=#PASSWORD-FILE=AUDITVALUE`
  // 里 `NOTES` 的取值是**空串**——`#` 紧贴 `=` 同样开启注释。此前这里沿用
  // `(?:^|[ \t])#`，于是这一行根本没有注释体，藏在里面的凭据 1/1 漏检。
  const inline = /#+[ \t]*/.exec(text.slice(equals + 1))
  if (inline === null) {
    return []
  }
  return [text.slice(equals + 1 + inline.index + inline[0].length)]
}

/**
 * `=` 之后那个引号，是不是**外层取值的闭引号**（因而这一格是真正的空占位）？
 *
 * **compact 与 legacy 两条路径共用这一份判据**，不再各写一半。
 *
 * 上一轮两条路径都只验证了「键前面是引号」且「`=` 后面是同种引号」，**没有证明
 * 前面那个引号是本赋值的开引号**。而键 run 是往前扫到 空白/`=`/`"`/`'` 为止的，
 * 它停下的那个引号完全可能是**上一段取值的闭引号**——此时 `=` 后面的引号是一段
 * **真实非空取值的开引号**，却被判成空占位，整行零 problem。审计与总控独立实测
 * 350 格里净新增 280 格漏检，`# psql "dbname=meal"PGPASSWORD="<值>"` 就是最小反例。
 *
 * 判据两条，缺一不可：
 *
 * 1. **它必须是这段文本里同种引号的第一个**。这条刻意比「奇偶」更严：奇偶只证明
 *    引号成对，证明不了配对关系没有被**外层包装引号**移位。实测
 *    `NOTES="psql "dbname=meal"PASSWORD=" <值>""` 里，`PASSWORD` 前面那个引号按
 *    奇偶算是开引号，可整行仍然藏着一段真实凭据，12/12 因此静默放行。空占位捷径
 *    本来就只是为了消一类误报，**证明不了就不许走捷径**：文本里还有别的同种引号
 *    时一律回退到 `readAssignmentValue` 并 fail closed。
 *    键 run 的边界集包含两种引号，因此 run 内不含引号；开引号之后遇到的下一个
 *    同种引号必然就是 `equals + 1` 这一个，它才是配对的闭引号。
 * 2. **闭合引号之后只允许输入结束 / ASCII 水平空白 / `#`**——与既有取值文法
 *    （`readAssignmentValue`）同一条规则。其余内容按边界不明确 fail closed，
 *    绝不因为「看起来像空占位」就放行。
 *
 * 代价（已登记）：同一段文本里出现**第二个**同种引号包裹的空占位
 * （`NOTES="PASSWORD=" OTHER="SECRET="`）会被判成非空。方向是 fail closed，
 * 且真实 tracked 模板与两份 README 均不含该写法。
 */
const closesEnclosingQuotedValue = (text, keyStart, equals) => {
  const quote = keyStart > 0 ? text[keyStart - 1] : ''
  if (quote !== '"' && quote !== "'") {
    return false
  }
  if (text[equals + 1] !== quote) {
    return false
  }
  for (let index = 0; index < keyStart - 1; index += 1) {
    if (text[index] === quote) {
      return false
    }
  }
  const after = text[equals + 2]
  return after === undefined || after === ' ' || after === '\t' || after === '#'
}

/**
 * 注释体里的**敏感赋值**。有界判据，不是「让散文吃可见字符」。
 *
 * 被注释掉的凭据同样会随 commit 进 Git，本文件的契约一直是「注释里的赋值也要
 * 扫」。可此前只有 `KEY=` 这种纯词字符键名能命中：`# PASSWORD-FILE=AUDITVALUE`、
 * `# PASSWORD.FILE=`、`# PASSWORD/v2=`、`# PASSWORD(old)=` 这些**含 ASCII 标点
 * 续字符**的形态 4/4 全漏（实测；`# PASSWORD_OLD=` 与 `# PASSWORD=` 是能命中的
 * 正向对照）。
 *
 * 判据：注释体里每个 `=` 往前取一段**不含 ASCII 空白**的 run（有界），
 * run 非空、不以复合运算符结尾、且含敏感词 run，则按 dotenv 取值文法读取
 * `=` 之后的取值；取值非空即命中。候选个数同样有界。
 */
const sensitiveCompactAssignments = (body, { crossingOnly = false } = {}) => {
  const text = String(body)
  let hits = 0
  let cursor = 0
  let exhausted = false
  for (let seen = 0; ; seen += 1) {
    if (seen === maximumCommentAssignments) {
      exhausted = text.indexOf('=', cursor) !== -1
      break
    }
    const equals = text.indexOf('=', cursor)
    if (equals === -1) {
      break
    }
    cursor = equals + 1
    // 键 run 与 `=` 之间的**有界 ASCII 水平间隔**——**只在 crossing 判据下开启**。
    //
    // 此前逆扫直接从 `=` 起步、遇 SPACE/TAB 即停，于是 `NOTES=XPA-SSWORD =v` 只
    // 得到一个空 key 就 continue：crossing 判据在这条路径上，gap 文法在下面的
    // legacy 路径上，两个维度各自完备而**交叉处零覆盖**（审计实测 14 键 ×
    // {SPACE,TAB} × 5 个非 active 视图共 140 格全漏）。
    //
    // 为什么只给 crossingOnly：**非** crossing 的敏感键带 gap 本来就由 legacy 路径
    // 完整覆盖（`# PASSWORD =v` 一直命中），这里再开一次只会多吃散文——实测
    // `# - \`POSTGRES_PASSWORD\` = 数据库密码` 会因为 run 吞掉反引号而被判成赋值，
    // 那正是本文件明确要求保持干净的注册写法。
    //
    // **上一轮在这里写错了理由**：当时说「crossing 视图没有这个代价，反引号里的
    // `POSTGRES_PASSWORD` 里 PASSWORD 本身就是完整词元，不构成跨越」。那只是碰巧。
    // `API_KEY` / `DATABASE_URL` / `PRIVATE_KEY` / `WECHAT_APP_ID` 的紧凑形自身即
    // 注册 token 且跨过下划线，**全部构成跨越**，于是 `` - `API_KEY` = 说明 `` 这类
    // 本仓库在用的散文写法 4/4 变成误报（`WECHAT_APP_ID` 就是本项目的键名）。
    //
    // 真正的判据是**间隔左边那一格必须还是键字符**：dotenv 的 `KEY GAP = VALUE` 里
    // 键以 identifier 字符收尾，而 `` ` ``、`)`、`]`、`"` 这些包装标点收尾的 run 是
    // 散文里的**引用**，不是键。这条同时保住了 crossing 闭合（`PA-SSWORD =v` 的
    // run 以 `D` 收尾）与全部注册散文写法。
    //
    // 上界复用 `readAssignmentGap` 的同一个 `maximumAssignmentGap`，只认 SPACE/TAB
    // 也与前向文法的 supported 间隔同源——**唯一 assignment 文法**的不变量保持。
    // 越界**不是免检额度**：与 `readAssignmentGap` 的 `exhausted` 对齐，放弃扫描
    // 一律 fail closed（上一轮这里越界后得到空 key 就静默 continue，实测 gap=65 与
    // gap=200 全部放行，与本文件反复声明的判据直接矛盾）。
    let runEnd = equals
    let gapWidth = 0
    let gapExhausted = false
    while (crossingOnly && runEnd > 0 && (text[runEnd - 1] === ' ' || text[runEnd - 1] === '\t')) {
      if (gapWidth === maximumAssignmentGap) {
        gapExhausted = true
        break
      }
      runEnd -= 1
      gapWidth += 1
    }
    if (gapExhausted) {
      // 越界**不是免检额度**，但它也不该把**空占位**变成命中：`=` 与取值都还看得
      // 见，看不清的只是键。因此照常读取值，只在「取值非空**且**整段文本跨过敏感
      // 边界」时 fail closed——与 `readAssignmentGap` 的越界语义同向，同时保住
      // 「空值允许」这条贯穿全文件的规则。
      const overBound = readAssignmentValue(text, equals + 1)
      if (
        !assignmentValueIsEmpty(overBound) &&
        (crossingOnly
          ? keyCrossesSensitivePunctuationBoundary(text)
          : containsSensitiveKeyToken(text))
      ) {
        hits += 1
      }
      continue
    }
    if (gapWidth > 0 && !/[A-Za-z0-9_]/.test(text[runEnd - 1] ?? '')) {
      // 间隔左边是包装标点而不是键字符 → 这是散文引用，不是赋值。
      continue
    }
    let start = runEnd
    // `=` 与引号同样是嵌套赋值的左边界。若只在空白处停，
    // `NOTES=COMP-ASSION=...` 会把外层 `NOTES=` 粘进 candidate，导致完整 benign
    // compound 的短路失效；`NOTES=XPA-SSWORD=...` 也无法证明命中的是内层键。
    while (
      start > 0 &&
      text[start - 1] !== ' ' &&
      text[start - 1] !== '\t' &&
      text[start - 1] !== '=' &&
      text[start - 1] !== '"' &&
      text[start - 1] !== "'"
    ) {
      start -= 1
    }
    const key = text.slice(start, runEnd)
    if (
      key === '' ||
      compoundOperatorTail.test(key) ||
      urlShapedRun.test(key) ||
      isSensitivePathSuffix(key)
    ) {
      continue
    }
    const keyIsSensitive = crossingOnly
      ? keyCrossesSensitivePunctuationBoundary(key)
      : containsSensitiveKeyToken(key)
    if ([...key].length > maximumCommentKeyLength) {
      // **越界不是免检额度**：run 太长无法判定，只要它含敏感词就 fail closed。
      if (keyIsSensitive) {
        hits += 1
      }
      continue
    }
    if (!keyIsSensitive) {
      continue
    }
    // `NOTES="XPA-SSWORD="` 的第二个 `=` 后面紧跟的是**外层** closing quote，
    // 不是一段新 quoted value 的 opening quote。把这一格认成真正的空占位；
    // 非空 nested value 仍由同一个 readAssignmentValue 读取并 fail closed。
    // 「前面那个引号确实是本赋值的开引号」由共用判据证明，见
    // `closesEnclosingQuotedValue`——只看「前面是引号」会把上一段取值的闭引号
    // 当成开引号，从而把一段真实非空取值判成空占位。
    const value = closesEnclosingQuotedValue(text, start, equals)
      ? { value: '', ambiguous: false }
      : readAssignmentValue(text, equals + 1)
    if (!assignmentValueIsEmpty(value)) {
      hits += 1
    }
  }
  if (
    exhausted &&
    (crossingOnly
      ? keyCrossesSensitivePunctuationBoundary(text)
      : containsSensitiveKeyToken(text))
  ) {
    // 候选个数越界同理：放弃扫描绝不等于放行。
    hits += 1
  }
  return hits
}

/**
 * 这一行里**真正会被 dotenv 消费**的那段文本；整行注释返回 `null`。
 *
 * strict 角色只作用在这段文本上。注释体在 `.env` 家族里同样是**散文**：Node
 * 完全不消费注释，可它按 strict 文法解析时 ` >`、`` ` ``、`+` 都会被当成间隔，
 * 于是 `# POSTGRES_PASSWORD >= 32 chars` 这类说明被报成「敏感赋值」——而报文
 * 是固定类别，操作者拿不到任何可据以排查的信息。审计实测 4/4 假阳性，其中三条
 * 正是本文件文档里声明「必须保持干净」的写法。
 *
 * 行内注释的起点与取值解析同源：`#` 前是行首或 ASCII 空白——但**只有第一个
 * `=` 之后**的 `#` 才是注释。`=` 之前的 `#` 对 Node 只是普通的**键名字符**：
 * 实测 v24.18.0，`FOO # PASSWORD\u00e9=SECRET` 定义了键 `FOO # PASSWORD\u00e9`，
 * 取值 `SECRET`——一条**活的**凭据。此前这里在第一个 ` #` 处就把整行截断，于是
 * strict 根本看不到后面那段，prose 又在 `\u00e9` 上按词字符终止，两条通路一起
 * 报 0（审计实测 5/5 这种形态全部漏检）。
 */
const dotenvConsumedText = (line) => {
  const text = String(line)
  if (/^[ \t]*#/.test(text)) {
    return null
  }
  const equals = text.indexOf('=')
  if (equals === -1) {
    // 没有 `=`：这一行不定义任何变量，整段都按可扫描文本处理。
    return text
  }
  const inlineComment = /(?:^|[ \t])#/.exec(text.slice(equals))
  return inlineComment === null ? text : text.slice(0, equals + inlineComment.index)
}

const dotenvLogicalSegments = (line) => {
  const text = String(line)
  // 行首注释标记反复剥离（`# # KEY=value` 同样要还原成赋值形态）。
  let uncommented = text
  for (;;) {
    const stripped = uncommented.replace(/^[ \t]*#+[ \t]*/, '')
    if (stripped === uncommented) {
      break
    }
    uncommented = stripped
  }
  const assignment = assignmentPattern.exec(uncommented)
  if (assignment === null) {
    // 非赋值行（README 散文等）：整行作为一个片段。
    return { segments: [{ text: uncommented, role: 'line', dsn: true }], ambiguous: false }
  }
  const rest = assignment[2].replace(/^[ \t]+/, '')
  const quote = rest[0]
  if (quote !== '"' && quote !== "'") {
    // unquoted：**主取值仍然是整条 rest**（不截断，DSN 扫描覆盖面不变）。
    // 「空白 + #」之后的部分**额外**再生成一个 comment 片段——它是同一行里的
    // 另一段可扫描文本，而不是主取值的替代品。
    const value = rest.replace(/[ \t]+$/, '')
    const segments = [{ text: value, role: 'value', dsn: true }]
    const inlineComment = /(?:^|[ \t])#(.*)$/.exec(value)
    if (inlineComment !== null) {
      // `dsn: false`——这个片段是主取值的**子串**，它的 `scheme://` 起点已经被
      // 主取值数过一次。再数一次会让「一行最多 8 个起点」的预算在带行内注释的
      // 行上实际只剩 4 个（审计实测：5 个起点加一个行内 `#` 就被判 unscannable）。
      segments.push({
        text: inlineComment[1].replace(/^#*\s*/, ''),
        role: 'comment',
        dsn: false
      })
    }
    return { segments, ambiguous: false }
  }
  const closing = rest.indexOf(quote, 1)
  if (closing === -1) {
    // 未闭合引号：取值边界不明确。
    return { segments: [], ambiguous: true }
  }
  // 引号内原样保留（含空格与制表符）。
  const segments = [{ text: rest.slice(1, closing), role: 'value', dsn: true }]
  const trailing = rest.slice(closing + 1).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')
  if (trailing === '') {
    return { segments, ambiguous: false }
  }
  if (trailing.startsWith('#')) {
    // 引号之后的行内注释：另一个 comment 片段（注释里的凭据同样算泄漏）。
    // 引号之后的注释**不是**主取值的子串，必须参与 DSN 枚举。
    segments.push({ text: trailing.replace(/^#+\s*/, ''), role: 'comment', dsn: true })
    return { segments, ambiguous: false }
  }
  // 闭合引号之后还有别的内容：dotenv 对此没有确定语义。
  return { segments: [], ambiguous: true }
}

/**
 * 连接串候选：在**逻辑取值**内部枚举 `scheme://` 起点，每个起点给出一个
 * **独立、可重叠**的候选视图。
 *
 * 关键改动：候选视图一律延伸到**所在逻辑片段的末尾**，内层起点**不再截断**
 * 外层候选。此前每个候选都在「下一个起点」处结束，于是
 * `https://first.invalid?redirect=https://second.invalid/path&pass%77ord=…`
 * 的外层候选被砍成 `https://first.invalid?redirect=`——真正带凭据的那个
 * query 参数落在被砍掉的部分里，而内层视图 `https://second.invalid/path&…`
 * 根本没有 `?`，于是两个视图都判不出凭据，整行静默放行。
 *
 * 内层起点仍然**计数**并各自独立成一个视图（`?mode=ok(redis://…?pass%77ord=…)`
 * 这类要靠内层视图才抓得到），只是不再影响外层视图的长度。
 *
 * 资源上限保持不变，且**都不是免检额度**：起点总数超过 8、或任一候选视图超过
 * 2048 字符，都置 `unscannable`，调用方 fail closed。
 */
const connectionStringCandidates = (line) => {
  const { segments, ambiguous } = dotenvLogicalSegments(line)
  if (ambiguous) {
    return { candidates: [], unscannable: 1 }
  }
  const startPattern = /[a-z][a-z0-9+.-]*:\/\//gi
  const candidates = []
  let startCount = 0
  for (const { text: segment, dsn } of segments) {
    if (dsn === false) {
      continue
    }
    for (const match of segment.matchAll(startPattern)) {
      startCount += 1
      if (startCount > maximumCandidates) {
        // 第 9 个起点：立即 fail closed，不再继续枚举。
        return { candidates: [], unscannable: 1 }
      }
      // 视图延伸到**片段末尾**：内层起点不截断外层候选。
      const candidate = segment.slice(match.index)
      if (candidate.length > maximumCandidateLength) {
        return { candidates: [], unscannable: 1 }
      }
      candidates.push(candidate)
    }
  }
  return { candidates, unscannable: 0 }
}

/**
 * 按**解码后**的 query key 判定 credential 参数。
 *
 * 只在原始文本上匹配词干是不够的：`?pass%77ord=…`、`?%70assword=…`、
 * `?access%5Ftoken=…` 在字节层面根本不含 `password` / `access_token`，但
 * 解析成 URL 之后它们**就是**那些键——写进模板同样是凭据入 Git。
 * 这里用 WHATWG `URL` + `URLSearchParams` 做有界解析（它按规范解码 key）。
 * **解析失败不再 `continue`**：一个已经被识别为 `scheme://` 候选的片段，如果
 * WHATWG 解析器都读不懂它（malformed IPv6 字面量 `redis://[invalid?…`、非法
 * 端口 `redis://host:99999?…`），那就是「这一段没被扫过」，只能 fail closed。
 * 此前的 `catch { continue }` 把它当成「这里没有凭据」，于是任何能让解析器
 * 抛错的写法都是一张免检通行证。
 *
 * **只返回类别名**：key、取值与整条连接串一律不外传，调用方只能拿到类别。
 * 返回 `'unscannable'`（超出资源上限，必须 fail closed）、
 * `'credential'`（解码后的 query key 命中）或 `null`。
 */
/**
 * ASCII 水平空白——**只有**这两个字符。
 *
 * 与 Node 24.18.0 `--env-file` 的真实消费语义逐项实测对齐：它在 unquoted 取值
 * 两侧只吃掉 ASCII SPACE 与 TAB，其余「看起来像空白」的字符都是**真实字节**，
 * 原样进入 `process.env`。因此判空绝不能用 `\s` 或 `trim()`——JS 的 `trim()`
 * 会把 NBSP / U+3000 / VT / FF 一并抹掉，于是 `PASSWORD=<NBSP>` 这种「Node 眼里
 * 非空」的取值被当成空占位放行。
 *
 *   PASSWORD=<c>       Node 实测消费结果      判定
 *   ----------------   --------------------   ----
 *   SPACE  U+0020      ""                     空占位
 *   TAB    U+0009      ""                     空占位
 *   NBSP   U+00A0      "\u00a0"               非空
 *   IDEO   U+3000      "\u3000"               非空
 *   ZWSP   U+200B      "\u200b"               非空
 *   VT     U+000B      "\u000b"(原样保留)   非空
 *   FF     U+000C      "\u000c"(原样保留)   非空
 *
 * 键与 `=` 之间同理：`PASSWORD =V` Node 读得到，而 `PASSWORD<NBSP>=V`（以及
 * U+3000 / U+200B / VT / FF 版本）**整行不生效**，`process.env.PASSWORD` 为
 * `null`——那是 unsupported 形态，按 fail closed 处理。
 */
const isAsciiHorizontalWhitespace = (character) =>
  character === ' ' || character === '\t'

/**
 * 「间隔字符」——Unicode **属性**判定，不是手写清单。
 *
 * **注意**：非 ASCII 间隔让 `PASSWORD` 这个名字读不到，但**不等于整行不生效**。
 * 实测 v24.18.0：`PASSWORD<NBSP>=V` 定义的是**扩展键** `PASSWORD<NBSP>`，取值
 * `V`——仍然是一条活凭据，只是名字不同。fail closed 的理由因此不是「这一行没
 * 作用」，而是「这一行确实定义了凭据，而别的消费者未必按同一个名字解析」。
 *
 * `\p{White_Space}`（ASCII SPACE/TAB、NBSP、U+3000、VT、FF、U+0085 NEL……）与
 * `\p{Cf}`（格式/零宽：U+200B、U+200C、U+200D、U+2060、U+FEFF、U+180E，以及
 * **星平面**的 U+110BD、U+1BCA0、U+13430……）。属性由 Unicode 数据决定，新增
 * 字符自动落到正确的一侧，不需要逐个补名单。
 */
const isGapCharacter = (character) =>
  character !== undefined && /[\p{White_Space}\p{Cf}]/u.test(character)

/** 「词字符」——任何书写系统的字母/数字加 `_`：遇到它说明这是另一个词。 */
const isWordCharacter = (character) =>
  character !== undefined && /[\p{L}\p{N}_]/u.test(character)

/**
 * 间隔扫描的上限，**以 Unicode code point 计**（不是 UTF-16 code unit）。
 *
 * **inclusive**：允许消费 64 个 gap code point **之后**再检查那个终止字符。
 * 只有当第 **65** 个 gap code point 出现时才判 exhausted。此前把上限写成
 * 「扫描位置不得越过 from+64」，于是 n=64 的间隔在检查终止符**之前**就越界，
 * `PASSWORD` + 64 空格 + `+=`（根本不是赋值）被误判成 fail closed（实测）。
 */
const maximumAssignmentGap = 64

/**
 * 读取「敏感键」与 `=` 之间的**间隔**，判定它是否被支持。
 *
 * **按 code point 读**：`text[index]` 取的是 UTF-16 code unit，星平面字符会被
 * 拆成孤立代理项，`\p{Cf}` 对代理项为假——实测 U+110BD / U+1BCA0 / U+13430 的
 * 间隔在三条路径上 **9/9 全部漏检**。这里用 `codePointAt` + `String.fromCodePoint`
 * 取完整码点，并按 `character.length` 前进。
 *
 * 结局：
 *
 *   - 间隔全是 ASCII SPACE/TAB 并抵达 `=` → **supported**；
 *   - 间隔含其他空白/格式字符并抵达 `=` → **unsupported** → fail closed；
 *   - 遇到**词字符**或**可见字符**（既非间隔也非词，例如 `†`）→ 取决于 `strict`：
 *       · strict（`.env` 家族）→ 都算「键与 `=` 之间的续字符」，计入有界间隔
 *         并 unsupported → fail closed；
 *       · prose（README 等）→ 这不是赋值，是散文；
 *   - 第 65 个 code point → **exhausted** → fail closed（放弃扫描绝不等于放行）。
 *
 * strict 里**不能**用「词字符 ⇒ 不是赋值」终止：ASCII 键名已经被调用方的
 * `[A-Za-z_][A-Za-z0-9_]*` 贪婪吃完，停在这里的词字符必然是**非 ASCII 续字符**，
 * 而 Node 把它算进键名并真的定义出一个活凭据（见函数体内的实测记录）。
 */
const readAssignmentGap = (text, from, { strict = false } = {}) => {
  let index = from
  let consumed = 0
  let supported = true
  while (index < text.length) {
    const codePoint = text.codePointAt(index)
    const character = String.fromCodePoint(codePoint)
    if (character === '=') {
      return { reachedEquals: true, index, supported, exhausted: false }
    }
    const gapLike = isGapCharacter(character)
    if (!strict && (isWordCharacter(character) || !gapLike)) {
      // **只有 prose 模式**允许「词字符 / 可见字符 ⇒ 这不是赋值」这条终止判据。
      //
      // strict 模式不能用它。键名的 ASCII 部分由 `sensitiveAssignmentsIn` 的
      // `[A-Za-z_][A-Za-z0-9_]*` 贪婪吃完，所以**第一次**停在这里的词字符必然是
      // 非 ASCII 续字符；实测 v24.18.0：`PASSWORDé=AUDITVALUE` 定义
      // `PASSWORDé`、`PASSWORD٣=` 定义 `PASSWORD٣`、`PASSWORD密码=` 定义
      // `PASSWORD密码`，三条都是**活的**凭据，而按词字符终止会让它们全部漏检
      // （基线 3/3 漏）。组合附标（U+0301 / U+0327）不是 `\p{L}\p{N}_`，此前就
      // 已经走可见字符那一支 fail closed。
      //
      // **后续迭代不止于此**：消费掉一个 ASCII 标点之后，下一个字符可以是 ASCII
      // 词字符，于是 `POSTGRES_PASSWORD-FILE=…`、`SECRET/v2=…` 这类键也一并
      // fail closed。这是**有意的**——Node 同样把它们定义成活的环境变量（逐条
      // 实测），判据覆盖的是「词干之后、`=` 之前的任何有界续字符」，不只是非
      // ASCII 的那部分。两类都有注册反例。
      return { reachedEquals: false, index, supported: true, exhausted: false }
    }
    if (consumed === maximumAssignmentGap) {
      // 第 65 个 gap：放弃扫描 → fail closed。
      return { reachedEquals: true, index, supported: false, exhausted: true }
    }
    if (!gapLike || !isAsciiHorizontalWhitespace(character)) {
      supported = false
    }
    index += character.length
    consumed += 1
  }
  return { reachedEquals: false, index, supported: true, exhausted: false }
}

/**
 * 从 `=` 之后读出**一个赋值取值**，有界。
 *
 * 取值的边界是**引号**（不是某几个字符）：
 *
 *   - 以 `"`/`'` 开头 → 边界是配对的同种引号，引号内的 `#` 与空白原样保留；
 *     未闭合时 fail closed。闭合引号之后只允许「输入结束 / ASCII 水平空白后
 *     结束 / `#` 注释」，其余收尾一律 ambiguous；
 *   - 否则 → 读到 **ASCII 水平空白**或 `#` 为止。此前用的是 `/[\s#]/`——那会让
 *     `PASSWORD=<NBSP>SYNTHETIC` 在第一个字符就终止、取值读成空串，而 Node
 *     实际消费到的是一整段非空取值。
 *
 * 有界：最多读 `maximumCandidateLength + 1` 个字符。
 */
const readAssignmentValue = (text, from) => {
  // `=` 之后的 **ASCII** 水平空白跳过：`PASSWORD= value` 的取值是 `value`。
  let start = from
  while (start < text.length && isAsciiHorizontalWhitespace(text[start])) {
    start += 1
  }
  // 跳过空白之后遇到 `#` 就是注释起点，取值为空——`PASSWORD= # 说明` 仍然是
  // 允许的空占位。
  //
  // 紧贴 `=` 的 `#`（`PASSWORD=#secret`）本实现**当作取值**，这是一处**刻意
  // 偏离 Node** 的收紧，如实记录：实测 `node --env-file` 对 `PASSWORD=#SYNTH`
  // 给出 `""`（它把紧贴 `=` 的 `#` 也当注释）。仍然按取值处理，是因为同一份
  // 模板还会被别的消费者读——compose 的 `env_file` 与常见 dotenv 库对「`#` 前
  // 没有空白」的处理并不一致，把它读成取值才是 fail closed 的那一侧。
  // 代价是 `WECHAT_APP_SECRET=#TODO` 这类占位写法会被判成敏感赋值。
  const hashIsComment = start !== from && text[start] === '#'
  if (hashIsComment) {
    return { value: '', end: start, quoted: false, ambiguous: false }
  }
  const limit = Math.min(text.length, start + maximumCandidateLength + 1)
  const quote = text[start]
  if (quote === '"' || quote === "'") {
    const closing = text.indexOf(quote, start + 1)
    if (closing === -1 || closing >= limit) {
      return { value: text.slice(start + 1, limit), end: limit, quoted: true, ambiguous: true }
    }
    let after = closing + 1
    while (after < text.length && isAsciiHorizontalWhitespace(text[after])) {
      after += 1
    }
    // 收尾合法 = 「吃掉可选的 ASCII 水平空白之后」到了末尾，或遇到 `#` 注释。
    const trailingOk = after >= text.length || text[after] === '#'
    return {
      value: text.slice(start + 1, closing),
      end: closing + 1,
      quoted: true,
      ambiguous: !trailingOk
    }
  }
  let end = start
  // 紧贴 `=` 的第一个字符即使是 `#` 也算取值的一部分（见上面「刻意偏离 Node」
  // 的说明）；其后的 `#` 才终止。
  if (end < limit && text[end] === '#') {
    end += 1
  }
  while (end < limit && !isAsciiHorizontalWhitespace(text[end]) && text[end] !== '#') {
    end += 1
  }
  return { value: text.slice(start, end), end, quoted: false, ambiguous: false }
}

/**
 * 一个赋值取值算不算「空占位」——判据与 Node `--env-file` 的消费结果一致。
 *
 * 读取阶段已经只吃掉 ASCII 水平空白，因此这里**只看长度**：长度为 0 才是空。
 * quoted 与 unquoted 共用同一条判据，不再有 `trim()` 这种会擦除真实字节的宽
 * 判据。`ambiguous`（引号未闭合、闭合引号后跟着说不清的内容、unsupported 的
 * 键/`=` 间隔）一律按**非空**处理。
 */
const assignmentValueIsEmpty = ({ value, ambiguous }) => {
  if (ambiguous) {
    return false
  }
  return value.length === 0
}

/**
 * 键名是否属于敏感键族（后缀 + **词元**双判据）。`API_KEYS` / `MY_SECRETS` /
 * `WECHAT_APP_SECRET_2` 这类形态 endsWith 抓不到，但它们同样是敏感键。
 */
const isSensitiveKeyName = (rawKey) => {
  const key = rawKey.toUpperCase()
  // strict 的 Node-active 键路径与下面这条自由文本路径必须对**同一个完整键**给出
  // 同一结论。此前 benign compound 只在 `containsSensitiveKeyToken` 里短路，
  // `PASSA_GE` / `KEYB_OARD` 随后又会被这条并行路径按 `PASSA` / `KEYB` 报成
  // sensitive。例外只认完整 compact compound；前后再粘任何字符都不会继承它。
  if (isBenignWeakPunctuationCompound(key)) {
    return false
  }
  const keyTokens = key.split(/[^A-Z0-9]+/).filter(Boolean)
  return (
    sensitiveKeySuffixes.some((suffix) => key.endsWith(suffix)) ||
    keyTokens.some((token) =>
      sensitiveKeySuffixes.some(
        (suffix) => token === suffix || token === `${suffix}S` || token.startsWith(suffix)
      )
    )
  )
}

/**
 * **唯一**的 assignment 文法——顶层 dotenv 行与 inline/comment/prose 片段共用
 * 这一份实现。
 *
 * 此前是两份：顶层走锚定的 `assignmentPattern`（`\s*=` 会把 NBSP 之类一并吞掉，
 * 于是 `PASSWORD<NBSP>=x` 被当成普通赋值），片段走非锚定扫描（`[ \t]*=` 对同一
 * 行则根本不匹配）。同一段文本两条路径给出不同结论，正是本轮要消掉的。
 *
 * 文法（与 Node `--env-file` 的实测语义对齐）：
 *
 *   assignment := [ `export` SPACE+ ] KEY GAP `=` VALUE
 *   KEY        := [A-Za-z_][A-Za-z0-9_]*
 *   GAP        := ASCII_WS*                     → supported
 *               | 含任何非 ASCII 空白的间隔     → **unsupported**（fail closed）
 *   VALUE      := 见 readAssignmentValue
 *
 * 返回命中条数。**不返回键名也不返回取值**——两者都是输入派生的内容。
 */
const sensitiveAssignmentsIn = (text, { strict = false } = {}) => {
  const fullSource = String(text)
  const active = nodeActiveAssignment(fullSource)
  // 把 value 变成一个新的扫描视图，而不是只把 RegExp.lastIndex 推到 value 起点。
  // 后一种写法会丢掉前面的 `=` 边界：value 以 `PASSWORD=` 开头时，正则既看不到
  // 字符串起点也看不到前置非字母数字，于是嵌套凭据被静默跳过。
  const source =
    active !== null && isBenignWeakPunctuationCompound(active.key)
      ? fullSource.slice(active.valueFrom)
      : fullSource
  // `export` 前缀与 `exportPrefixPattern` 同源：只认 SPACE。自由文本扫描本来就是
  // 非锚定的，这里保留它只为让 `export KEY=` 的键从 `export` 之后开始匹配。
  const keyPattern = new RegExp(
    `(?:^|[^A-Za-z0-9_])(?:${exportPrefixSource})?([A-Za-z_][A-Za-z0-9_]*)`,
    'g'
  )
  // 所有视图先走同一条 compact-run matcher。它从每个 `=` 往后/往前解析，
  // 因而能保留嵌套键里的标点边界：`NOTES=XPA-SSWORD=...`、quoted nested 与
  // 注释体不再退回旧 ASCII key regex。下面的 legacy gap scanner 仍负责
  // `PASSWORD = ...` 这类键与 `=` 之间含空白/结构性 gap 的形态。
  let hits = sensitiveCompactAssignments(source, { crossingOnly: true })
  // 如果这整段本身就是一个已登记的 benign Node-active assignment，只跳过它的
  // **键区**，从 value 起点继续非锚定扫描。这样 `PASS_AGE=AUDITVALUE` 不会被
  // 拆成 `PASS` 再误报，而 `PASS_AGE=PASSWORD=secret` 里的嵌套凭据仍然命中。
  let cursor = 0
  for (;;) {
    keyPattern.lastIndex = cursor
    const match = keyPattern.exec(source)
    if (match === null) {
      break
    }
    const keyEnd = match.index + match[0].length
    const keyStart = keyEnd - match[1].length
    // legacy ASCII matcher 可能落在同一个 punctuation-bearing candidate 的**中间**。
    // 先恢复完整 candidate：否则 compact prepass 已把 `COM-PASSION` 判为 benign，
    // 这里仍会从子片段 `PASSION` 重新制造一次命中。只跳过完整键区，游标停在
    // candidate 的 `=`，value 内下一层 assignment 仍会继续扫描。
    let compactStart = keyStart
    while (
      compactStart > 0 &&
      source[compactStart - 1] !== ' ' &&
      source[compactStart - 1] !== '\t' &&
      source[compactStart - 1] !== '=' &&
      source[compactStart - 1] !== '"' &&
      source[compactStart - 1] !== "'"
    ) {
      compactStart -= 1
    }
    const compactEquals = source.indexOf('=', keyEnd)
    if (
      compactEquals !== -1 &&
      isBenignWeakPunctuationCompound(source.slice(compactStart, compactEquals))
    ) {
      cursor = Math.max(cursor + 1, compactEquals)
      continue
    }
    if (!strict) {
      // prose 里的 URL / absolute-path 片段不是 dotenv 赋值：
      //
      //   https://example.invalid/password=placeholder
      //   [reset](https://example.invalid/password=placeholder)
      //   /api/password=placeholder?limit=10
      //
      // 新的 comment scanner 已经会跳过 URL-shaped run，但整行仍会先经过这条旧的
      // 非锚定 prose scanner；如果这里不共享同一边界，`password=` 会在 URL path
      // 里被重新解释成赋值。只看**键之前的同一 ASCII token**：含 `://`，或去掉
      // Markdown 包装后以 `/` 开头，才按 URL/path 跳过。键本身起始的
      // `PASSWORD/v2=secret` 没有这样的前缀，仍然命中。
      let tokenStart = keyStart
      while (
        tokenStart > 0 &&
        source[tokenStart - 1] !== ' ' &&
        source[tokenStart - 1] !== '\t'
      ) {
        tokenStart -= 1
      }
      const tokenPrefix = source.slice(tokenStart, keyStart)
      const unwrappedPrefix = tokenPrefix.replace(/^[#>*\[\](){}`'"|]+/, '')
      if (
        tokenPrefix.includes('://') ||
        tokenPrefix.includes('/') ||
        unwrappedPrefix.startsWith('/')
      ) {
        cursor = Math.max(cursor + 1, keyEnd - 1)
        continue
      }
    }
    // GAP：结构性判定，不枚举字符（见 readAssignmentGap）。
    const gap = readAssignmentGap(source, keyEnd, { strict })
    if (gap.reachedEquals && isSensitiveKeyName(match[1])) {
      const unsupportedGap = !gap.supported
      // 外层 closing quote 与 compact 路径**共用同一条判据**：
      // `OUTER="PASS_WORD="` 的第二个 `=` 后面跟的是**外层**引号，不是新一段
      // quoted value 的 opening quote。此前这条规则只写在 compact 路径上
      // （`OUTER="XPA-SSWORD="` 因此干净），普通敏感键仍从这里穿过去，被
      // readAssignmentValue 当成未闭合引号读到行尾，于是空占位被判成 ambiguous
      // 非空——同一形态两种结论。
      //
      // 上一轮把这条规则搬过来的时候，**连同 compact 那个未验证的假设一起搬了**：
      // 只要键前面是引号就认。于是 `# psql "dbname=meal"PGPASSWORD="<值>"` 里
      // 上一段取值的闭引号被当成开引号，一整行真实凭据零 problem。现在改由
      // `closesEnclosingQuotedValue` 证明它确实是本赋值的开引号。
      //
      // 越界那一支没有真正看到 `=`，取值从越界点之后读；它已经被标成
      // unsupported，因此无论取值读成什么都会 fail closed。
      const parsed =
        !gap.exhausted && closesEnclosingQuotedValue(source, compactStart, gap.index)
          ? { value: '', ambiguous: false }
          : readAssignmentValue(source, gap.exhausted ? gap.index : gap.index + 1)
      // unsupported 的键/`=` 间隔按 ambiguous 处理：Node 那一行整条不生效，但
      // 文件里确实写着凭据，别的消费者（compose env_file、dotenv 库）未必同样
      // 忽略它——fail closed。
      const verdict = { ...parsed, ambiguous: parsed.ambiguous || unsupportedGap }
      if (!assignmentValueIsEmpty(verdict)) {
        hits += 1
      }
    }
    // **退回到本次匹配的末字符上**，让紧随其后的 `=` 仍能充当下一层赋值的分隔
    // 符（`NOTES=PASSWORD=…`、`A=B=PASSWORD=…`）。
    //
    // 不会零宽循环：`match.index >= cursor` 且 `|match[0]| >= 1`，因此
    // `keyEnd >= cursor + 1`；下面的 `Math.max` 把「游标必须前进」写成显式
    // 不变量。
    // 不会重复输出：一行只产出一条固定类别消息，命中多少次都只报一条。
    cursor = Math.max(cursor + 1, keyEnd - 1)
  }
  return hits
}


const encodedCredentialVerdict = (line) => {
  const { candidates, unscannable } = connectionStringCandidates(line)
  if (unscannable > 0) {
    // 扫不完就**不许放行**：资源上限是为了防病态输入，不是免检额度。
    return 'unscannable'
  }
  // 先把所有候选走完再下结论：`unscannable`（有一段没扫到）**优先于**
  // 「扫到的那段是什么」。此前 userinfo 一命中就 return，于是同一行里后面
  // 一个解析不动的候选被跳过，结论从 unscannable 降级成 userinfo。
  let verdict = null
  for (const candidate of candidates) {
    let url
    try {
      url = new URL(candidate)
    } catch {
      return 'unscannable'
    }
    // **解析成功之后 userinfo 与 query 同时判定**。原始文本正则要求 `@` 之前
    // 没有空白，引号内合法保留的空格/制表符（`"https://user:pa ss@host/path"`）
    // 因此绕得过它；解析器给出的 username/password 把这条补上。
    if (verdict === null && (url.username !== '' || url.password !== '')) {
      verdict = 'userinfo'
    }
    // query 与 **fragment** 都要看：`#access_token=…` 不出现在 searchParams
    // 里，此前完全不可见。
    const pairSources = [url.searchParams]
    if (url.hash.length > 1) {
      pairSources.push(new URLSearchParams(url.hash.slice(1)))
    }
    for (const pairs of pairSources) {
      for (const [key, value] of pairs) {
        if (value === '') {
          // 空占位与模板的「空值允许」规则一致。
          continue
        }
        const compact = key.toLowerCase().replace(/[-_.]/g, '')
        if (verdict === null && compactCredentialStems.some((stem) => compact.includes(stem))) {
          verdict = 'credential'
        }
      }
    }
  }
  return verdict
}

/**
 * 模板扫描**只支持 dotenv 形态**（`KEY=value`，可带 `export` 前缀与 `#` 注释）。
 * 这是刻意收窄的：YAML/JSON/TOML 的嵌套结构无法用逐行赋值文法可靠判定，
 * 「假装支持」等于给一类格式发免检通行证。因此 `infra/environments/` 下出现
 * 非 `.env*` 形态的 tracked 文件时**直接拒绝**，而不是静默跳过——要新增格式，
 * 必须先为它写判据与反例。
 */
// 只认这几种**确定是 dotenv 形态**的文件名：`*.env`、`.env`、`*.env.example`、
// `*.env.sample`、`*.env.template`，外加三个非配置的元文件。
// 此前的 `(\.[^/]+)?` 对后缀不设约束，`app.env.yaml` / `app.env.json` /
// `secrets.env.sh` 都会被当作 dotenv 放行——它们一行都不匹配赋值文法，于是
// 零 problem 静默通过，正是这条 allowlist 要消灭的形态。
/**
 * **文件角色**决定 gap 判据的严格程度——同一份 parser，两个 context。
 *
 *   - `strict-dotenv`：`.env` / `*.env` / `*.env.{example,sample,template}`。
 *     这些文件里每一行都**应该**是 dotenv 赋值，因此敏感键与 `=` 之间出现
 *     有界的**可见** Unicode 间隔（`PASSWORD†=…`）是可疑的，必须 fail closed。
 *   - `prose`：`README.md` / `.gitignore` / `.gitkeep`。这些是给人读的，
 *     `` - `POSTGRES_PASSWORD` = 数据库密码 ``、`keys += 1`、`# TOKEN >= 32`
 *     都是正常写法，可见字符说明「这不是赋值」，必须保持干净（审计实测：按
 *     strict 判据扫 README 会有 18/18 种普通写法误报）。
 *
 * 两种角色**共用同一个** `sensitiveAssignmentsIn`/`readAssignmentGap`，只是传入
 * 不同的 context——不复制第二套赋值文法。
 */
const strictDotenvFile = /(^|\/)([^/]*\.)?env(\.(example|sample|template))?$/

const templateFileRole = (file) =>
  strictDotenvFile.test(file) ? 'strict-dotenv' : 'prose'

const supportedTemplateFile =
  /(^|\/)([^/]*\.)?env(\.(example|sample|template))?$|(^|\/)(README\.md|\.gitignore|\.gitkeep)$/

export const scanTrackedTemplates = (repository = repositoryRoot) => {
  assertCanonicalGitRepositoryView(repository)
  const problems = []
  const listing = spawnSync(
    'git',
    canonicalGitArguments(['ls-files', '-z', '--', 'infra/environments']),
    { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
  )
  if (listing.error !== undefined) {
    throw new Error(
      `cannot list tracked templates (failed to run git: ${listing.error.message})`
    )
  }
  if (listing.status !== 0) {
    throw new Error(
      `cannot list tracked templates (git ls-files exit=${String(listing.status)})`
    )
  }
  // 扫描到零个 tracked 文件时抛错：静默零覆盖不是通过。
  const files = listing.stdout.split('\u0000').filter(Boolean)
  if (files.length === 0) {
    throw new Error(
      'the tracked template scan found no files under infra/environments; ' +
        'a zero-coverage scan must not pass silently'
    )
  }
  const scanTemplateContent = (label, content, role) => {
    const strict = role === 'strict-dotenv'
    // **先去掉行尾 CR**。`assignmentPattern` 的 `(.*)$` 里 `.` 不匹配 CR、`$`
    // 又没有 `m` 标志，于是一份 CRLF 模板里**每一行**都不再被识别成赋值，整条
    // 敏感键判据静默失效（审计实测：同一份内容 LF 版报 5 条、CRLF 版只报 1 条）。
    const lines = content.split('\n').map((line) => line.replace(/\r$/, ''))
    for (const [index, line] of lines.entries()) {
      // 第二层先判：扫不完的行必须 fail closed，**优先于**原始文本层的结论
      // ——「有一段没扫到」比「扫到的那段是什么」更要紧。
      const encodedVerdict = encodedCredentialVerdict(line)
      let dsnCategory = encodedVerdict === 'unscannable' ? unscannableCategory : null
      if (dsnCategory === null) {
        for (const { pattern, category } of fullDsnPatterns) {
          if (pattern.test(line)) {
            dsnCategory = category
            break
          }
        }
      }
      // 解析器给出的 userinfo：原始文本正则漏掉带空白的 userinfo 时由它兜住。
      if (dsnCategory === null && encodedVerdict === 'userinfo') {
        dsnCategory = userinfoCategory
      }
      // 解码后的 query key：原始文本层漏掉百分号编码时由它兜住。
      if (dsnCategory === null && encodedVerdict === 'credential') {
        dsnCategory = credentialQueryCategory
      }
      if (dsnCategory !== null) {
        // 只报**类别 + 文件 + 行号**：命中的连接串本身就是凭据，绝不回显。
        problems.push(`${label}:${String(index + 1)}: tracked template ${dsnCategory}`)
      }
      // 通用敏感赋值判据只跑在 **dotenv 实际消费文本**上；整行/行内注释只交给
      // 后面的 shared compact-run matcher。此前原始整行、value/comment segments
      // 与专用 comment scanner 三路重叠：专用路径会把 `COM-PASSION` 正确判成
      // benign，通用路径却又从子片段 `PASSION` 误报，225 格 benign matrix 在两种
      // comment 视图各红 3 格。职责分开后，真实 value 内的嵌套 assignment 仍在
      // consumed text 中，注释凭据则由专用路径完整覆盖。
      // 敏感赋值只报**一条固定类别**：类别 + 文件标签 + 行号，**不含任何
      // 输入派生的键名或取值**。
      //
      // 此前回显键名（对高熵形态做启发式改写）。启发式的问题在于它要先判断
      // 「这个键名像不像 Secret」——而行内注释是自由文本，键位上可以放进任意
      // 内容，任何阈值都只是把泄漏面缩小而不是关掉。一行报一条就够了：定位靠
      // 文件与行号，键名对操作者不是必要信息。
      //
      const consumedText = dotenvConsumedText(line)
      let sensitiveHits =
        consumedText === null ? 0 : sensitiveAssignmentsIn(consumedText)
      if (strict) {
        // strict 通路 = **Node 真实文法**：解析第一个 `=` 之前的完整 Node-active
        // 键（`nodeActiveAssignment`），键里含敏感词 run 且取值非空就命中。
        // 它同时覆盖了非 ASCII 续字符、ASCII 标点续字符、数字开头的键、
        // `export\tPASSWORD` 与键区里的 `#`——都是同一条文法的自然结果，不再
        // 需要第二套「间隔」判据。取值内部不受它管辖（那里仍走 prose）。
        const active = nodeActiveAssignment(line)
        if (active !== null && active.exhausted === true) {
          // 空键段数越界：无法判定这一行到底给哪个键赋值 → fail closed。
          sensitiveHits += 1
        } else if (active !== null && containsSensitiveKeyToken(active.key)) {
          const parsed = readAssignmentValue(line, active.valueFrom)
          const verdict = { ...parsed, ambiguous: parsed.ambiguous || active.overLength }
          if (!assignmentValueIsEmpty(verdict)) {
            sensitiveHits += 1
          }
        }
      }
      // **注释体**：无论文件角色，被注释掉的凭据都要扫（有界判据，见
      // `sensitiveCompactAssignments`）。注释体内还可能有嵌套 assignment（例如
      // `NOTES="a PASSWORD=secret"`），因此同一**已剥离的 body**再走通用 scanner；
      // 不能退回扫描原始整行，否则 exact benign compound 会从子片段重新误报。
      for (const body of commentBodiesOf(line)) {
        sensitiveHits += sensitiveAssignmentsIn(body)
        // 注释 containment 比 prose 更严格：`PASSWORD/v2=` 这类 token 位于
        // separator 前、并未“跨过”边界，但它仍是被注释掉的完整凭据键。
        sensitiveHits += sensitiveCompactAssignments(body)
      }
      if (sensitiveHits > 0) {
        problems.push(
          `${label}:${String(index + 1)}: tracked template assigns a non-empty ` +
            'value to a sensitive key'
        )
      }
    }
  }

  for (const file of files) {
    if (!supportedTemplateFile.test(file)) {
      problems.push(
        `${file}: unsupported template format under infra/environments; the scanner ` +
          'only understands dotenv-style files (add explicit rules and negatives ' +
          'before introducing another format)'
      )
      continue
    }
    // **两层都扫**：工作树内容与 Git index blob。只扫工作树会漏掉「已经
    // git add、随后把工作树恢复干净」的凭据——它仍然会随下一次 commit 进入
    // 历史。index blob 用 `git show :<path>` 读取，读不到即 fail closed。
    const path = resolve(repository, file)
    let worktreeContent = null
    try {
      worktreeContent = readFileSync(path, 'utf8')
    } catch {
      problems.push(`${file}: tracked template could not be read from the worktree`)
    }
    if (worktreeContent !== null) {
      scanTemplateContent(file, worktreeContent, templateFileRole(file))
    }
    const indexBlob = spawnSync('git', canonicalGitArguments(['show', `:${file}`]), {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    })
    if (indexBlob.error !== undefined || indexBlob.status !== 0) {
      problems.push(
        `${file}: the git index blob could not be read ` +
          `(${indexBlob.error?.message ?? `git show exit=${String(indexBlob.status)}`})`
      )
      continue
    }
    if (indexBlob.stdout !== worktreeContent) {
      scanTemplateContent(`${file} (git index)`, indexBlob.stdout, templateFileRole(file))
    }
  }
  return problems
}

/**
 * 完整的 bundle 预检。返回 { problems, bodies }：problems 非空即 fail closed，
 * bodies 是 filename → body 的 Map（只在内存里，调用方不得输出）。
 *
 * expectedOwnerUid 只暴露给反向测试（非 root 进程无法真的制造一个错误属主的
 * 文件）；生产调用方一律用默认值（当前进程的 effective UID）。
 */
export const checkSecretBundle = (directory, options = {}) => {
  const problems = []
  const bodies = new Map()
  const expectedOwnerUid = options.expectedOwnerUid ?? process.geteuid()
  const scanTemplates = options.scanTemplates ?? true

  if (typeof directory !== 'string' || directory === '') {
    return { problems: ['the bundle directory must be a non-empty path'], bodies }
  }
  if (!isAbsolute(directory)) {
    return { problems: [`${directory} is not an absolute path`], bodies }
  }

  let directoryStats
  try {
    directoryStats = lstatSync(directory)
  } catch {
    return { problems: [`${directory} does not exist`], bodies }
  }
  if (directoryStats.isSymbolicLink()) {
    return {
      problems: [`${directory} is a symbolic link; the bundle directory must be a real directory`],
      bodies
    }
  }
  if (!directoryStats.isDirectory()) {
    return { problems: [`${directory} is not a directory`], bodies }
  }
  if (directoryStats.uid !== expectedOwnerUid) {
    problems.push(
      `${directory} is owned by uid ${String(directoryStats.uid)} but the ` +
        `expected owner is uid ${String(expectedOwnerUid)}`
    )
  }
  // 目录权限**精确** 0700：0500（owner 不可写）、0600（owner 不可进入）、
  // 1700（sticky）等变体都不是「已知安全」的形态，一律拒绝。
  if ((directoryStats.mode & 0o7777) !== 0o700) {
    problems.push(
      `${directory} has mode ${(directoryStats.mode & 0o7777).toString(8).padStart(4, '0')}; ` +
        'the bundle directory mode must be exactly 0700'
    )
  }

  const isDefaultDirectory =
    safeRealpath(directory) === safeRealpath(defaultSecretsDirectory)

  // 目录内容：恰好八份 Secret；默认目录额外允许 tracked 的 README 与 .gitignore。
  // 其他任何条目（含暂存残留、点文件、子目录）都是未知条目，一律拒绝。
  let entries
  try {
    entries = readdirSync(directory)
  } catch {
    return { problems: [...problems, `${directory} could not be listed`], bodies }
  }
  const allowed = new Set(secretFilenames)
  if (isDefaultDirectory) {
    for (const extra of defaultDirectoryAllowedEntries) {
      allowed.add(extra)
    }
  }
  // 未知条目**只报数量，不回显名字**：文件名本身是不可信输入，甚至可能就是
  // 一段 Secret（有人把口令误存成文件名）。回显它等于把 Secret 打进错误消息。
  const unknownEntries = entries.filter((entry) => !allowed.has(entry))
  if (unknownEntries.length > 0) {
    problems.push(
      `the bundle directory contains ${String(unknownEntries.length)} unknown ` +
        'entr' + (unknownEntries.length === 1 ? 'y' : 'ies') + '; a bundle ' +
        'contains exactly the eight declared secret files (unknown names are ' +
        'deliberately not echoed)'
    )
  }

  // 逐文件判据 + 读取。
  const rawBodies = new Map()
  for (const entry of secretFiles) {
    const path = resolve(directory, entry.filename)
    const { body, problems: fileProblems } = readSecretFileForPreflight(
      path,
      entry.filename,
      expectedOwnerUid
    )
    problems.push(...fileProblems)
    rawBodies.set(entry.filename, body)
  }

  // 口令文件先行（URL/pgpass 的交叉一致性依赖它们）。
  const passwords = {}
  for (const entry of secretFiles) {
    if (entry.kind !== 'password') {
      continue
    }
    const body = rawBodies.get(entry.filename)
    passwords[entry.role] =
      body === null ? null : checkPasswordBody(entry.filename, body, problems)
  }

  // 四个原始口令必须互不相同：同值只能来自复制粘贴，属于部署错误。
  const seen = new Map()
  for (const role of passwordRoles) {
    const value = passwords[role]
    if (typeof value !== 'string') {
      continue
    }
    if (seen.has(value)) {
      problems.push(
        `the ${role} password is identical to the ${seen.get(value)} password; ` +
          'the four raw passwords must be distinct'
      )
    } else {
      seen.set(value, role)
    }
  }

  for (const entry of secretFiles) {
    const body = rawBodies.get(entry.filename)
    if (body === null) {
      continue
    }
    if (entry.kind === 'url') {
      checkUrlBody(entry.filename, body, entry, passwords[entry.role] ?? null, problems)
    } else if (entry.kind === 'pgpass') {
      checkPgpassBody(entry.filename, body, passwords.superuser ?? null, problems)
    }
    bodies.set(entry.filename, body)
  }

  // git：bundle 内的 Secret 文件绝不能被跟踪；默认目录里除 README/.gitignore
  // 外也不能有别的 tracked 条目。bundle 目录在任何 git 仓库之外时没有可判定的
  // 跟踪状态，这一段自然不适用。跟踪判据对**每一份**文件执行，与文件级判据
  // 是否已失败无关——一份既被 track 又权限错误的文件必须两条都报。
  try {
    const repository = enclosingGitRepository(directory)
    if (repository !== null) {
      for (const entry of secretFiles) {
        const path = resolve(directory, entry.filename)
        if (gitTracksPath(repository, path)) {
          problems.push(
            `${entry.filename}: is tracked by git; secrets must stay untracked`
          )
        }
      }
      // 默认目录必须**主动**持有 .gitignore，且八个文件名都真的被忽略
      // （git check-ignore 逐一验证）：等到 Secret 已经进了 index 才由上面的
      // 跟踪判据发现，防线次序就反了。
      if (isDefaultDirectory) {
        if (!entries.includes('.gitignore')) {
          problems.push(
            '.gitignore: missing from the default bundle directory; without it ' +
              'a git add -A would stage every secret file'
          )
        } else {
          for (const entry of secretFiles) {
            const ignored = spawnSync(
              'git',
              ['check-ignore', '-q', '--', resolve(directory, entry.filename)],
              { cwd: repository, encoding: 'utf8', maxBuffer: 1024 * 1024 }
            )
            if (ignored.error !== undefined || (ignored.status !== 0 && ignored.status !== 1)) {
              problems.push(
                `${entry.filename}: cannot determine whether git ignores it ` +
                  `(git check-ignore ${ignored.error?.message ?? `exit=${String(ignored.status)}`})`
              )
            } else if (ignored.status === 1) {
              problems.push(
                `${entry.filename}: is not covered by the default directory's ` +
                  '.gitignore; a git add -A would stage it'
              )
            }
          }
        }
      }
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }

  // tracked 模板扫描（锚定本仓库，不依赖 bundle 位置）。
  if (scanTemplates) {
    try {
      problems.push(...scanTrackedTemplates())
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
  }

  return { problems, bodies }
}

/**
 * realpath 的 fail-safe 版本：解析失败时回落到 resolve。生成器与预检共用，
 * 保证「是不是默认目录」在两边是同一个判定。
 */
export const safeRealpath = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
