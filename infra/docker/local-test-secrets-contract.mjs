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
  'DSN',
  'DATABASE_URL',
  'URL',
  'URI'
]
const assignmentPattern = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

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
// 固定类别：扫描器**没能完整扫完**这一行的连接串候选。消息里只有类别、文件与
// 行号，绝不回显 URL、key 或取值。
const unscannableCategory = 'contains an unscannable connection string candidate'
const fullDsnPatterns = [
  {
    // 顺序固定：userinfo 形排在最前，两条既有反例继续命中这条消息。
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]*@[^\s/?#]+/i,
    category: 'contains a full connection string with credentials'
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
  'credential'
]

/** 资源上限：一行最多 8 个 `scheme://` 起点，每个候选最长 2048 字符。 */
const maximumCandidates = 8
const maximumCandidateLength = 2048

/**
 * 候选的**空白**边界——只有 ASCII 空格与制表符两个字符。
 *
 * 标点**全部**从边界判据里移除了（此前是 `,;'"\`<>|\\`）。维护一张标点
 * allowlist/denylist 是个错误的方向：这些字符**在合法 URL 里就是合法的**，
 * 把它们当边界只会把一条完整的 URL 拦腰截断——`https://host/path,rest?…` 会
 * 被切成 `https://host/path`，query 连同其中的凭据一起消失，扫描器于是既没
 * 报「有凭据」也没报「扫不完」，静默放行。哪个标点算边界的问题，交给 WHATWG
 * URL 解析器按规范回答；解析不动的候选走 fail closed 那条路。
 */
const candidateWhitespace = /[ \t]/

/**
 * 行内的连接串候选：**先独立枚举全部 `scheme://` 起点**，再各自定界。
 *
 * 这是本轮的结构性修正。此前的实现是「找到一个候选 → 从它的结束位置继续找下
 * 一个」，于是任何**落在前一个候选内部**的起点都被整段跳过：
 * `https://first.invalid?mode=ok(redis://…?pass%77ord=…)` 里的 `redis://` 起点
 * 位于第一个候选的区间内，扫描游标直接越过它，第二条 URI 从未被解析过。括号、
 * 方括号、花括号只是同一个结构缺陷的不同外衣。
 *
 * 现在：
 *
 *   1. 用只匹配 `scheme://` **前缀**的正则枚举出一行里的**全部**起点——前缀很
 *      短，`matchAll` 的 lastIndex 只会越过前缀本身，因此嵌在后面的起点照样
 *      会被枚举到；
 *   2. 候选数量按**起点总数**计算：一旦出现第 9 个起点就立刻 fail closed，不
 *      再「扫前 8 个、剩下的悄悄丢掉」；
 *   3. 每个候选的结束位置**只**取三者中最早的一个：下一个 `scheme://` 起点、
 *      一个 ASCII 水平空白（空格或制表符）、`start + 2048 + 1` 的硬上界。
 *      标点不在其中——见 `candidateWhitespace` 的说明。
 *
 * 返回 `{ candidates, unscannable }`。资源上限不是免检额度：起点超过 8 个、
 * 或某个候选超过 2048 字符时 `unscannable` 置位，调用方必须 fail closed。
 */
const connectionStringCandidates = (line) => {
  const text = String(line)
  const starts = []
  const startPattern = /[a-z][a-z0-9+.-]*:\/\//gi
  for (const match of text.matchAll(startPattern)) {
    starts.push(match.index)
    if (starts.length > maximumCandidates) {
      // 第 9 个起点：立即 fail closed，不再继续枚举。
      return { candidates: [], unscannable: 1 }
    }
  }
  const candidates = []
  for (const [index, start] of starts.entries()) {
    const nextStart = index + 1 < starts.length ? starts[index + 1] : text.length
    const hardLimit = start + maximumCandidateLength + 1
    const scanLimit = Math.min(text.length, nextStart, hardLimit)
    let end = start
    while (end < scanLimit && !candidateWhitespace.test(text[end])) {
      end += 1
    }
    if (end - start > maximumCandidateLength) {
      return { candidates: [], unscannable: 1 }
    }
    candidates.push(text.slice(start, end))
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
const encodedCredentialVerdict = (line) => {
  const { candidates, unscannable } = connectionStringCandidates(line)
  if (unscannable > 0) {
    // 扫不完就**不许放行**：资源上限是为了防病态输入，不是免检额度。
    return 'unscannable'
  }
  for (const candidate of candidates) {
    let url
    try {
      url = new URL(candidate)
    } catch {
      return 'unscannable'
    }
    for (const [key, value] of url.searchParams) {
      if (value === '') {
        // 空占位与模板的「空值允许」规则一致。
        continue
      }
      const compact = key.toLowerCase().replace(/[-_.]/g, '')
      if (compactCredentialStems.some((stem) => compact.includes(stem))) {
        return 'credential'
      }
    }
  }
  return null
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
    const lines = content.split('\n')
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
      // 解码后的 query key：原始文本层漏掉百分号编码时由它兜住。
      if (dsnCategory === null && encodedVerdict === 'credential') {
        dsnCategory = credentialQueryCategory
      }
      if (dsnCategory !== null) {
        // 只报**类别 + 文件 + 行号**：命中的连接串本身就是凭据，绝不回显。
        problems.push(`${label}:${String(index + 1)}: tracked template ${dsnCategory}`)
      }
      // 剥掉行首注释标记后再匹配赋值：`# WECHAT_APP_SECRET=real` 与未注释的
      // 版本同样是进了 Git 的凭据。**反复剥离**直到不再变化——单次剥离会被
      // `# # KEY=value` 绕过（实测：`#+\s*` 吃掉第一个 `#` 和空格后剩下的
      // `# KEY=value` 不再匹配赋值文法）。
      let uncommented = line
      for (;;) {
        const stripped = uncommented.replace(/^\s*#+\s*/, '')
        if (stripped === uncommented) {
          break
        }
        uncommented = stripped
      }
      const match = assignmentPattern.exec(uncommented)
      if (match === null) {
        continue
      }
      const key = match[1].toUpperCase()
      const value = match[2].trim()
      // 后缀 + **词元**双判据：`API_KEYS` / `MY_SECRETS` / `WECHAT_APP_SECRET_2`
      // 这类形态 endsWith 抓不到，但它们同样是敏感键。
      const keyTokens = key.split(/[^A-Z0-9]+/).filter(Boolean)
      const sensitive =
        sensitiveKeySuffixes.some((suffix) => key.endsWith(suffix)) ||
        keyTokens.some((token) =>
          sensitiveKeySuffixes.some(
            (suffix) => token === suffix || token === `${suffix}S` || token.startsWith(suffix)
          )
        )
      if (sensitive && value !== '' && value !== '""' && value !== "''") {
        problems.push(
          `${label}:${String(index + 1)}: tracked template assigns a non-empty ` +
            `value to the sensitive key ${match[1]}`
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
