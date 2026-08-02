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
  const result = spawnSync(
    'git',
    ['ls-files', '--error-unmatch', '--', path],
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
  const result = spawnSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  })
  if (result.error !== undefined) {
    throw new Error(
      `cannot determine the enclosing git repository (failed to run git: ${result.error.message})`
    )
  }
  if (result.status === 0) {
    return resolve(result.stdout.trim())
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
const assignmentPattern = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/

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
 *   IDEO   U+3000      "　"               非空
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
 * dotenv 里键与 `=` 之间只可能隔着空白类字符。判据用两个通用属性：
 * `\p{White_Space}`（含 ASCII SPACE/TAB、NBSP、U+3000、VT、FF、U+0085 NEL……）
 * 与 `\p{Cf}`（格式/零宽：U+200B、U+200C、U+200D、U+2060、U+FEFF、U+180E……）。
 *
 * 这仍然**不是枚举**：没有一张需要逐个补字符的名单，属性由 Unicode 数据决定，
 * 新增字符自动落到正确的一侧。
 *
 * 其余字符（可见标点、符号、字母、数字）都**不是间隔**——遇到它们说明这根本
 * 不是一条赋值，而是散文。这一条是审计实测逼出来的：早先「任何非词字符都算
 * 间隔」使得 `` - `POSTGRES_PASSWORD` = 数据库密码 ``、`keys += 1`、
 * `# TOKEN >= 32 chars`、`if (token != null) { }` 等 **20 种**普通 markdown /
 * 英文行全部被判成敏感赋值，而两份 tracked README 正在扫描范围内。
 */
const isGapCharacter = (character) =>
  character !== undefined && /[\p{White_Space}\p{Cf}]/u.test(character)

/** 间隔扫描的硬上界：`键` 与 `=` 之间不可能有意义地隔着这么多字符。 */
const maximumAssignmentGap = 64

/**
 * 读取「敏感键」与 `=` 之间的**间隔**，判定它是否被支持。
 *
 * 三种结局：
 *
 *   - 间隔全部由 ASCII SPACE / TAB 组成并抵达 `=` → **supported**（Node 读得到）；
 *   - 间隔里出现其他空白/格式字符并抵达 `=` → **unsupported** → fail closed
 *     （Node 那一行整条不生效，但文件里确实写着凭据）；
 *   - 出现任何**非间隔字符** → 这不是一条赋值 → 不判定（散文）。
 *
 * 还有第四种：扫到 `maximumAssignmentGap` 仍未定论。**放弃扫描必须 fail
 * closed**——审计实测 `PASSWORD` + 65 个空格 + `=SYNTHETIC` 在 Node 里是一条
 * **活的**凭据，而早先的实现在越界后直接判成「不是赋值」，静默放行（基线反而
 * 抓得到）。有界是为了防病态输入，不是免检额度。
 */
const readAssignmentGap = (text, from) => {
  let index = from
  let supported = true
  const limit = Math.min(text.length, from + maximumAssignmentGap)
  while (index < limit) {
    const character = text[index]
    if (character === '=') {
      return { reachedEquals: true, index, supported, exhausted: false }
    }
    if (!isGapCharacter(character)) {
      // 非间隔字符：这不是赋值。
      return { reachedEquals: false, index, supported: true, exhausted: false }
    }
    if (!isAsciiHorizontalWhitespace(character)) {
      supported = false
    }
    index += 1
  }
  // 越界：`=` 可能就在后面，也可能没有——不知道就 fail closed。
  const exhausted = index === from + maximumAssignmentGap && index < text.length
  return { reachedEquals: exhausted, index, supported: exhausted ? false : supported, exhausted }
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
 *   assignment := [ `export` ASCII_WS+ ] KEY GAP `=` VALUE
 *   KEY        := [A-Za-z_][A-Za-z0-9_]*
 *   GAP        := ASCII_WS*                     → supported
 *               | 含任何非 ASCII 空白的间隔     → **unsupported**（fail closed）
 *   VALUE      := 见 readAssignmentValue
 *
 * 返回命中条数。**不返回键名也不返回取值**——两者都是输入派生的内容。
 */
const sensitiveAssignmentsIn = (text) => {
  const source = String(text)
  const keyPattern = /(?:^|[^A-Za-z0-9_])(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)/g
  let hits = 0
  let cursor = 0
  for (;;) {
    keyPattern.lastIndex = cursor
    const match = keyPattern.exec(source)
    if (match === null) {
      break
    }
    const keyEnd = match.index + match[0].length
    // GAP：结构性判定，不枚举字符（见 readAssignmentGap）。
    const gap = readAssignmentGap(source, keyEnd)
    if (gap.reachedEquals && isSensitiveKeyName(match[1])) {
      const unsupportedGap = !gap.supported
      // 越界那一支没有真正看到 `=`，取值从越界点之后读；它已经被标成
      // unsupported，因此无论取值读成什么都会 fail closed。
      const parsed = readAssignmentValue(source, gap.exhausted ? gap.index : gap.index + 1)
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
const supportedTemplateFile =
  /(^|\/)([^/]*\.)?env(\.(example|sample|template))?$|(^|\/)(README\.md|\.gitignore|\.gitkeep)$/

export const scanTrackedTemplates = (repository = repositoryRoot) => {
  const problems = []
  const listing = spawnSync(
    'git',
    ['ls-files', '-z', '--', 'infra/environments'],
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
  const scanTemplateContent = (label, content) => {
    // **先去掉行尾 CR**。`assignmentPattern` 的 `(.*)$` 里 `.` 不匹配 CR、`$`
    // 又没有 `m` 标志，于是一份 CRLF 模板里**每一行**都不再被识别成赋值，整条
    // 敏感键判据静默失效（审计实测：同一份内容 LF 版报 5 条、CRLF 版只报 1 条）。
    const lines = content.split('\n').map((line) => line.replace(/\r$/, ''))
    for (const [index, line] of lines.entries()) {
      // 一行只切一次片段，DSN 判据与敏感赋值判据共用同一份切分结果。
      const { segments: lineSegments } = dotenvLogicalSegments(line)
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
      // 敏感赋值判据跑在**每一个片段**上，而不只是整行。
      //
      // 此前只判定整行：`NOTES="ok" # PASSWORD=SYNTHETIC` 与
      // `NOTES=ok # PASSWORD=SYNTHETIC` 的赋值键都被读成 `NOTES`（不敏感），
      // 行内注释里的 `PASSWORD=SYNTHETIC` 于是完全没被看到。现在 tokenizer
      // 会为这两种形态各生成一个 **comment 片段**，片段与整行走**同一份**
      // `sensitiveAssignmentIn`。
      // 敏感赋值只报**一条固定类别**：类别 + 文件标签 + 行号，**不含任何
      // 输入派生的键名或取值**。
      //
      // 此前回显键名（对高熵形态做启发式改写）。启发式的问题在于它要先判断
      // 「这个键名像不像 Secret」——而行内注释是自由文本，键位上可以放进任意
      // 内容，任何阈值都只是把泄漏面缩小而不是关掉。一行报一条就够了：定位靠
      // 文件与行号，键名对操作者不是必要信息。
      //
      // 整行与**每一个片段**——主取值、行内注释、非赋值整行——走**同一份**
      // 文法（`sensitiveAssignmentsIn`），且都是非锚定扫描：片段是自由文本，
      // 赋值不一定出现在开头。
      let sensitiveHits = sensitiveAssignmentsIn(line)
      for (const segment of lineSegments) {
        sensitiveHits += sensitiveAssignmentsIn(segment.text)
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
      scanTemplateContent(file, worktreeContent)
    }
    const indexBlob = spawnSync('git', ['show', `:${file}`], {
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
      scanTemplateContent(`${file} (git index)`, indexBlob.stdout)
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
