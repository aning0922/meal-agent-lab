#!/usr/bin/env node
//
// 阶段 09A / M3A：`check-compose-topology.mjs` 的反向测试。
//
//   node infra/docker/check-compose-topology-mutations.mjs
//
// 一个静态门禁只有在「被证明能捕获它声称要捕获的篡改」之后才算数。M2B 的 27 项
// 变异是手工执行并记录在文档里的；M3A 把这件事变成一条可重复的命令，重点覆盖
// 本轮新增的部署身份断言：删除 `DEPLOYMENT_STAGE` / `DEPLOYMENT_EXPOSURE`、把
// 它们改成 staging / production / private-network / public、把部署身份塞给别的
// 服务，以及往拓扑里写入真实微信凭据。
//
// 做法是把 tracked compose 的原始字节复制到本轮独占临时目录，只改临时副本，
// 再通过受限 `--compose-file` seam 运行同一门禁。tracked 文件从不被改写。
//
// 每一项都必须**以指定理由**失败：只要求「失败了」不够——一条完全无关的报错
// 也能让脚本变绿，那样证明不了断言本身存在。
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const repositoryRoot = resolve(composeDirectory, '..', '..')
const composeFile = resolve(composeDirectory, 'compose.local-test.yaml')
const safeDiagnostic = (message) => {
  try {
    writeSync(2, Buffer.from(message, 'utf8'))
    return true
  } catch {
    return false
  }
}
// 先读 tracked 源文件：读取失败时尚未创建任何临时资源。
let original
try {
  original = readFileSync(composeFile)
} catch {
  safeDiagnostic('FATAL: could not read the tracked topology source\n')
  process.exit(1)
}
let mutationDirectory
try {
  mutationDirectory = mkdtempSync(join(tmpdir(), 'meal-agent-compose-topology-'))
} catch {
  safeDiagnostic('FATAL: could not create the topology mutation directory\n')
  process.exit(1)
}
let mutationIdentity
const mutationFile = resolve(mutationDirectory, 'compose.local-test.yaml')
const checker = resolve(composeDirectory, 'check-compose-topology.mjs')

try {
  const stat = lstatSync(mutationDirectory, { bigint: true })
  mutationIdentity = { dev: stat.dev, ino: stat.ino }
  writeFileSync(mutationFile, original, { flag: 'wx', mode: 0o600 })
} catch {
  try {
    rmSync(mutationDirectory, { recursive: true, force: true })
  } catch {
    safeDiagnostic('FATAL: topology mutation setup and cleanup both failed\n')
    process.exit(1)
  }
  safeDiagnostic('FATAL: could not create the topology mutation fixture\n')
  process.exit(1)
}

let mutationDirectoryRemoved = false
const cleanupMutationDirectory = () => {
  if (mutationDirectoryRemoved) return
  const observed = lstatSync(mutationDirectory, { bigint: true })
  if (observed.dev !== mutationIdentity.dev || observed.ino !== mutationIdentity.ino) {
    throw new Error('topology mutation directory ownership drifted')
  }
  rmSync(mutationDirectory, { recursive: true, force: false })
  mutationDirectoryRemoved = true
}

const abort = (message) => {
  try {
    cleanupMutationDirectory()
  } catch {
    safeDiagnostic('FATAL: could not remove the owned topology mutation directory\n')
  }
  safeDiagnostic(`${message}\n`)
  process.exit(1)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    try {
      cleanupMutationDirectory()
    } catch {
      safeDiagnostic('FATAL: topology mutation signal cleanup failed\n')
      process.exit(1)
    }
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
  })
}

// 每一项：把 `from` 替换成 `to`，并要求门禁以 `expect` 为理由失败。
// `from` 必须在源文件中**恰好出现一次**，否则变异本身就不确定。
const mutations = [
  {
    name: 'the fixed Compose project name is changed',
    from: 'name: meal-agent-local-test\n',
    to: 'name: meal-agent-local-test-mutated\n',
    expect: /Compose project name drifted from the registered fixed value/
  },
  {
    name: 'the internal network gains driver options',
    from: '  internal:\n    driver: bridge\n    internal: true\n',
    to:
      '  internal:\n' +
      '    driver: bridge\n' +
      '    driver_opts:\n' +
      '      com.docker.network.bridge.enable_icc: "true"\n' +
      '    internal: true\n',
    expect: /a registered network capability shape drifted/
  },
  {
    name: 'the database volume becomes external',
    from: '  postgres-data: {}\n',
    to: '  postgres-data:\n    external: true\n',
    expect: /a registered volume capability shape drifted/
  },
  {
    name: 'an unused top-level config capability is declared',
    from: '\n# --------------------------------------------------------------------------\n# 网络\n',
    to:
      '\nconfigs:\n' +
      '  foreign-config: {}\n' +
      '\n# --------------------------------------------------------------------------\n# 网络\n',
    expect: /top-level capability set drifted from its registered closed schema/
  },
  {
    name: 'a privileged service is hidden behind another profile',
    from: '\n# --------------------------------------------------------------------------\n# 网络\n',
    to:
      '\n  hidden-profile-service:\n' +
      '    image: docker.io/library/alpine@sha256:' + '0'.repeat(64) + '\n' +
      '    profiles: [hidden-audit]\n' +
      '    privileged: true\n' +
      '\n# --------------------------------------------------------------------------\n# 网络\n',
    expect: /unexpected service set/
  },
  {
    name: 'security_opt gains an unregistered confinement control',
    from: '  security_opt:\n    - no-new-privileges:true\n',
    to:
      '  security_opt:\n' +
      '    - no-new-privileges:true\n' +
      '    - label=disable\n',
    expect: /security_opt must match the registered fixed set/
  },
  {
    name: 'the API published port switches to ingress mode',
    from: '        mode: host\n',
    to: '        mode: ingress\n',
    expect: /published port mode must be host/
  },
  {
    name: 'the API published port gains an unknown capability field',
    from: '        mode: host\n',
    to: '        mode: host\n        app_protocol: http\n',
    expect: /published port capability shape drifted/
  },
  {
    name: 'the shared log size bound is relaxed',
    from: '      max-size: "10m"\n',
    to: '      max-size: "100m"\n',
    expect: /logging must match the registered bounded local rotation policy/
  },
  {
    name: 'the API healthcheck gains a start interval',
    from: '      start_period: 15s\n',
    to: '      start_period: 15s\n      start_interval: 1s\n',
    expect: /api: healthcheck drifted from the registered fixed semantics/
  },
  {
    name: 'the API network attachment gains priority metadata',
    from:
      '    networks:\n' +
      '      # edge 只承载上面这个 loopback publish；数据库流量仍走 internal。\n' +
      '      - internal\n' +
      '      - edge\n',
    to:
      '    networks:\n' +
      '      # edge 只承载上面这个 loopback publish；数据库流量仍走 internal。\n' +
      '      internal:\n' +
      '        priority: 100\n' +
      '      edge: {}\n',
    expect: /api: resolved nested capability evidence has an unsupported shape/
  },
  {
    name: 'DEPLOYMENT_STAGE removed',
    from: '      DEPLOYMENT_STAGE: local-test\n',
    to: '',
    expect: /DEPLOYMENT_STAGE must be declared explicitly/
  },
  {
    name: 'DEPLOYMENT_EXPOSURE removed',
    from: '      DEPLOYMENT_EXPOSURE: loopback\n',
    to: '',
    expect: /DEPLOYMENT_EXPOSURE must be declared explicitly/
  },
  {
    name: 'DEPLOYMENT_STAGE promoted to staging',
    from: '      DEPLOYMENT_STAGE: local-test\n',
    to: '      DEPLOYMENT_STAGE: staging\n',
    expect: /DEPLOYMENT_STAGE must use its registered local-test value/
  },
  {
    name: 'DEPLOYMENT_STAGE promoted to production',
    from: '      DEPLOYMENT_STAGE: local-test\n',
    to: '      DEPLOYMENT_STAGE: production\n',
    expect: /DEPLOYMENT_STAGE must use its registered local-test value/
  },
  {
    name: 'DEPLOYMENT_EXPOSURE widened to private-network',
    from: '      DEPLOYMENT_EXPOSURE: loopback\n',
    to: '      DEPLOYMENT_EXPOSURE: private-network\n',
    expect: /DEPLOYMENT_EXPOSURE must use its registered local-test value/
  },
  {
    name: 'DEPLOYMENT_EXPOSURE widened to public',
    from: '      DEPLOYMENT_EXPOSURE: loopback\n',
    to: '      DEPLOYMENT_EXPOSURE: public\n',
    expect: /DEPLOYMENT_EXPOSURE must use its registered local-test value/
  },
  {
    name: 'NODE_ENV switched to production while the adapter stays fake',
    from: '      NODE_ENV: development\n',
    to: '      NODE_ENV: production\n',
    expect: /api: environment drifted from the registered fixed set/
  },
  {
    name: 'the adapter switched to real',
    from: '      WECHAT_ADAPTER: fake\n',
    to: '      WECHAT_ADAPTER: real\n',
    expect: /api: environment drifted from the registered fixed set/
  },
  {
    name: 'a real WeChat AppID is injected',
    from: '      WECHAT_ADAPTER: fake\n',
    to: '      WECHAT_ADAPTER: fake\n      WECHAT_APP_ID: wx-real-app-id\n',
    expect: /WECHAT_APP_ID must not appear in the local-test topology/
  },
  {
    name: 'a real WeChat AppSecret is injected',
    from: '      WECHAT_ADAPTER: fake\n',
    to:
      '      WECHAT_ADAPTER: fake\n' +
      '      WECHAT_APP_SECRET: TOPOLOGY-DIAGNOSTIC-SENTINEL\n',
    expect: /must not carry a value in Compose|WECHAT_APP_SECRET must not appear/,
    forbidEcho: 'TOPOLOGY-DIAGNOSTIC-SENTINEL'
  },
  {
    name: 'the deployment identity is duplicated onto migrate',
    from: '      DATABASE_URL_FILE: /run/secrets/meal_agent_migration_database_url/value\n',
    to:
      '      DATABASE_URL_FILE: /run/secrets/meal_agent_migration_database_url/value\n' +
      '      DEPLOYMENT_STAGE: production\n',
    expect: /migrate: must not declare DEPLOYMENT_STAGE/
  },
  {
    name: 'the runtime secret file is swapped for the admin one',
    from: '      DATABASE_URL_FILE: /run/secrets/meal_agent_runtime_database_url/value\n',
    to: '      DATABASE_URL_FILE: /run/secrets/meal_agent_admin_database_url/value\n',
    expect: /DATABASE_URL_FILE must point at|read-only materialized volume/
  },
  {
    name: 'the runtime connection string is inlined as an environment value',
    from: '      DATABASE_URL_FILE: /run/secrets/meal_agent_runtime_database_url/value\n',
    to: '      DATABASE_URL: postgresql://meal_agent_runtime_login:pw@postgres/meal_agent\n',
    expect: /api: environment drifted from the registered fixed set/
  },
  {
    name: 'a bootstrap password is inlined as an environment value',
    from: '      MEAL_AGENT_BACKUP_PASSWORD_FILE: /run/secrets/meal_agent_backup_password/value\n',
    to: '      MEAL_AGENT_BACKUP_PASSWORD: inlined-password\n',
    expect: /bootstrap-logins: environment drifted from the registered fixed set/
  },
  {
    name: 'the API host publish address is unqualified',
    from: '      - host_ip: 127.0.0.1\n',
    to: '      - host_ip: 0.0.0.0\n',
    expect: /host publish address must be exactly 127\.0\.0\.1/
  },
  {
    name: 'the materializer loses DAC_READ_SEARCH',
    from: '      - DAC_READ_SEARCH\n',
    to: '',
    expect: /secret-materializer: cap_add drifted/
  },
  {
    name: 'the transfer volume loses its UID 999 initialization',
    from: '        chmod 0700 /transfer\n        chown 999:999 /transfer\n',
    to: '',
    expect: /secret-materializer: command drifted from the registered fixed value/
  },
  {
    name: 'postgres bypasses successful materialization',
    from:
      '    depends_on:\n' +
      '      secret-materializer:\n' +
      '        condition: service_completed_successfully\n',
    to: '',
    expect: /postgres: depends_on drifted/
  },
  {
    name: 'the materializer stops receiving one raw source secret',
    from:
      '      - source: meal_agent_runtime_database_url\n' +
      '        target: /run/source-secrets/meal_agent_runtime_database_url\n',
    to: '',
    expect: /secret-materializer: raw Compose secret set drifted/
  },
  {
    name: 'the API receives the admin credential volume',
    from: '      - runtime-url-secret:/run/secrets/meal_agent_runtime_database_url:ro\n',
    to: '      - admin-url-secret:/run/secrets/meal_agent_admin_database_url:ro\n',
    expect: /api: mount set drifted|runtime must never receive/
  },
  {
    name: 'backup receives the migration password volume',
    from:
      '    entrypoint:\n' +
      '      - bash\n' +
      '    volumes:\n' +
      '      - backup-password-secret:/run/secrets/meal_agent_backup_password:ro\n' +
      '      - backup-transfer:/transfer\n',
    to:
      '    entrypoint:\n' +
      '      - bash\n' +
      '    volumes:\n' +
      '      - migration-password-secret:/run/secrets/meal_agent_migration_password:ro\n' +
      '      - backup-transfer:/transfer\n',
    expect: /backup: mount set drifted/
  },
  {
    name: 'restore receives the backup login password',
    from: '      - backup-transfer:/transfer:ro\n',
    to:
      '      - backup-transfer:/transfer:ro\n' +
      '      - backup-password-secret:/run/secrets/meal_agent_backup_password:ro\n',
    expect: /restore: mount set drifted/
  },
  {
    name: 'the API gains an unregistered post-start executable hook',
    from: '    healthcheck:\n      # 只用镜像已有的 node（Node 24 自带 fetch），不临时安装 curl/wget。\n',
    to:
      '    post_start:\n' +
      '      - command: ["sh", "-c", "printf hook"]\n' +
      '    healthcheck:\n' +
      '      # 只用镜像已有的 node（Node 24 自带 fetch），不临时安装 curl/wget。\n',
    expect: /api: resolved service contains unsupported capability fields/
  },
  {
    name: 'the shared API build gains host-network execution capability',
    from: '    dockerfile: services/api/Dockerfile\n',
    to:
      '    dockerfile: services/api/Dockerfile\n' +
      '    network: host\n',
    expect: /build contains unsupported execution capability fields/
  },
  {
    name: 'postgres gains an unregistered host-network build capability',
    from: '  postgres:\n    <<: *hardening\n',
    to:
      '  postgres:\n' +
      '    <<: *hardening\n' +
      '    build:\n' +
      '      context: ../..\n' +
      '      dockerfile: services/api/Dockerfile\n' +
      '      network: host\n',
    expect: /postgres: must not declare a build stanza/
  },
  {
    name: 'migrate gains an unconditional healthcheck capability',
    from:
      '  migrate:\n' +
      '    <<: [*hardening, *api-image]\n' +
      '    command:\n',
    to:
      '  migrate:\n' +
      '    <<: [*hardening, *api-image]\n' +
      '    healthcheck:\n' +
      '      test: ["CMD", "node", "-e", "process.exit(0)"]\n' +
      '    command:\n',
    expect: /migrate: must not declare a healthcheck/
  },
  {
    name: 'the API healthcheck becomes an unconditional success',
    from:
      '        - "fetch(\'http://127.0.0.1:3000/healthz\').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"\n',
    to: '        - "process.exit(0)"\n',
    expect: /api: healthcheck drifted from the registered fixed semantics/
  },
  {
    name: 'an untrusted resolved healthcheck value is never echoed',
    from:
      '        - "fetch(\'http://127.0.0.1:3000/healthz\').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"\n',
    to: '        - "TOPOLOGY-RESOLVED-SENTINEL"\n',
    expect: /api: healthcheck drifted from the registered fixed semantics/,
    forbidEcho: 'TOPOLOGY-RESOLVED-SENTINEL'
  },
  {
    name: 'the API healthcheck cadence is relaxed',
    from: '      interval: 10s\n',
    to: '      interval: 11s\n',
    expect: /api: healthcheck drifted from the registered fixed semantics/
  },
  {
    name: 'the API healthcheck is disabled',
    from:
      '      test:\n' +
      '        - CMD\n' +
      '        - node\n' +
      '        - -e\n' +
      '        - "fetch(\'http://127.0.0.1:3000/healthz\').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"\n',
    to:
      '      disable: true\n' +
      '      test:\n' +
      '        - NONE\n',
    expect: /api: healthcheck drifted from the registered fixed semantics/
  },
  {
    name: 'an API dependency is made optional',
    from:
      '    depends_on:\n' +
      '      postgres:\n' +
      '        condition: service_healthy\n' +
      '      migrate:\n' +
      '        condition: service_completed_successfully\n',
    to:
      '    depends_on:\n' +
      '      postgres:\n' +
      '        condition: service_healthy\n' +
      '      migrate:\n' +
      '        condition: service_completed_successfully\n' +
      '        required: false\n',
    expect: /api: depends_on metadata drifted from the registered fixed semantics/
  },
  {
    name: 'an API dependency gains restart propagation',
    from:
      '      postgres:\n' +
      '        condition: service_healthy\n' +
      '      migrate:\n',
    to:
      '      postgres:\n' +
      '        condition: service_healthy\n' +
      '        restart: true\n' +
      '      migrate:\n',
    expect: /api: depends_on metadata drifted from the registered fixed semantics/
  },
  {
    name: 'a noncanonical top-level declaration never echoes its source line',
    from: '  edge:\n',
    to: '  "TOPOLOGY-SOURCE-SENTINEL": {}\n',
    expect: /declared top-level networks uses a non-canonical declaration/,
    forbidEcho: 'TOPOLOGY-SOURCE-SENTINEL'
  },
  {
    name: 'an explicit raw Secret name is shared across Compose projects',
    from:
      '  postgres_superuser_password:\n' +
      '    file: ${MEAL_AGENT_SECRETS_DIR:-./secrets}/postgres_superuser_password\n',
    to:
      '  postgres_superuser_password:\n' +
      '    name: meal-agent-local-test_postgres_superuser_password\n' +
      '    file: ${MEAL_AGENT_SECRETS_DIR:-./secrets}/postgres_superuser_password\n',
    expect: /a network, volume, or secret is shared across project names/
  }
]

const failures = []
let checked = 0

const runChecker = () => {
  const result = spawnSync(process.execPath, [checker, '--compose-file', mutationFile], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`
  }
}

try {
  const baseline = runChecker()
  if (baseline.status !== 0) {
    abort(
      'the unmutated topology must pass before any mutation is meaningful; ' +
        `${String(baseline.output.trim().split('\n').length)} output line(s) not echoed`
    )
  }

  const source = original.toString('utf8')
  for (const mutation of mutations) {
    const occurrences = source.split(mutation.from).length - 1
    if (occurrences !== 1) {
      failures.push(
        `${mutation.name}: anchor appears ${String(occurrences)} times in the ` +
          `compose source (expected exactly 1); the mutation is not well defined`
      )
      continue
    }

    try {
      writeFileSync(mutationFile, source.replace(mutation.from, mutation.to))
      const result = runChecker()
      checked += 1
      if (result.status === 0) {
        failures.push(`${mutation.name}: NOT CAUGHT — the checker still passed`)
        continue
      }
      if (!mutation.expect.test(result.output)) {
        // **固定类别**：checker 的输出会逐字回显它观察到的取值，而此刻 tracked
        // compose 文件正带着变异（其中几条内嵌合成 DSN 与 AppSecret）。这里
        // 只报期望判据与输出行数，绝不回显输出本身。
        failures.push(
          `${mutation.name}: caught, but for the wrong reason (expected ` +
            `${String(mutation.expect)}); ${String(result.output.trim().split('\n').length)} ` +
            'output line(s) deliberately not echoed'
        )
        continue
      }
      if (
        mutation.forbidEcho !== undefined &&
        result.output.includes(mutation.forbidEcho)
      ) {
        failures.push(`${mutation.name}: checker output echoed the injected sentinel`)
        continue
      }
      process.stdout.write(`  caught: ${mutation.name}\n`)
    } finally {
      writeFileSync(mutationFile, original)
    }
  }
} finally {
  try {
    cleanupMutationDirectory()
  } catch (error) {
    abort(
      `FATAL: could not remove the owned topology mutation directory ` +
        `(${typeof error === 'object' && error !== null && 'code' in error ? error.code : 'unknown'})`
    )
  }
}

// **变异条数的硬门禁**：此前通过消息里的分母直接取自数组长度，删掉一条变异
// 照样报 PASS，而文档把「15 项」当事实写着。其余三个套件都用字面量兜底，这里
// 补齐。
const expectedMutationCount = 45
if (mutations.length !== expectedMutationCount) {
  failures.push(
    `expected ${String(expectedMutationCount)} mutations, the file defines ${String(mutations.length)}`
  )
}

if (failures.length > 0) {
  safeDiagnostic('Compose topology mutation check FAIL\n')
  for (const message of failures) {
    safeDiagnostic(`  - ${message}\n`)
  }
  process.exit(1)
}

process.stdout.write(
  `Compose topology mutation check PASS ` +
    `(${String(checked)}/${String(mutations.length)} mutations caught with the ` +
    `named reason, 0 escapes, tracked compose file was never modified)\n`
)
