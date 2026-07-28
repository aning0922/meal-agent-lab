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
// 做法是**临时改写 tracked 的 compose 文件**再运行门禁——门禁断言的是
// `docker compose config` 解析后的配置，因此没有别的办法让它看见一个被篡改的
// 拓扑。安全边界：
//   - 起手要求该文件在 Git 里是干净的，否则拒绝运行，绝不覆盖真实改动；
//   - 每次变异后立刻在 `finally` 里写回原始字节；
//   - 结束时再逐字节复核一次，没还原成功就以非零退出并明确报告。
//
// 每一项都必须**以指定理由**失败：只要求「失败了」不够——一条完全无关的报错
// 也能让脚本变绿，那样证明不了断言本身存在。
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const repositoryRoot = resolve(composeDirectory, '..', '..')
const composeFile = resolve(composeDirectory, 'compose.local-test.yaml')
const checker = resolve(composeDirectory, 'check-compose-topology.mjs')

const abort = (message) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const dirty = spawnSync(
  'git',
  ['status', '--porcelain', '--', composeFile],
  { cwd: repositoryRoot, encoding: 'utf8' }
)
if (dirty.error !== undefined || dirty.status !== 0) {
  abort(
    `mutation harness is missing a prerequisite tool: git status failed ` +
      `(${dirty.error?.message ?? `exit ${String(dirty.status)}`})`
  )
}
if (dirty.stdout.trim() !== '') {
  abort(
    `refusing to run: ${composeFile} has uncommitted changes.\n` +
      `This harness rewrites that file in place and restores it afterwards; ` +
      `it will not risk clobbering work in progress.`
  )
}

const original = readFileSync(composeFile)

// 每一项：把 `from` 替换成 `to`，并要求门禁以 `expect` 为理由失败。
// `from` 必须在源文件中**恰好出现一次**，否则变异本身就不确定。
const mutations = [
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
    expect: /DEPLOYMENT_STAGE must be local-test/
  },
  {
    name: 'DEPLOYMENT_STAGE promoted to production',
    from: '      DEPLOYMENT_STAGE: local-test\n',
    to: '      DEPLOYMENT_STAGE: production\n',
    expect: /DEPLOYMENT_STAGE must be local-test/
  },
  {
    name: 'DEPLOYMENT_EXPOSURE widened to private-network',
    from: '      DEPLOYMENT_EXPOSURE: loopback\n',
    to: '      DEPLOYMENT_EXPOSURE: private-network\n',
    expect: /DEPLOYMENT_EXPOSURE must be loopback/
  },
  {
    name: 'DEPLOYMENT_EXPOSURE widened to public',
    from: '      DEPLOYMENT_EXPOSURE: loopback\n',
    to: '      DEPLOYMENT_EXPOSURE: public\n',
    expect: /DEPLOYMENT_EXPOSURE must be loopback/
  },
  {
    name: 'NODE_ENV switched to production while the adapter stays fake',
    from: '      NODE_ENV: development\n',
    to: '      NODE_ENV: production\n',
    expect: /NODE_ENV must be development/
  },
  {
    name: 'the adapter switched to real',
    from: '      WECHAT_ADAPTER: fake\n',
    to: '      WECHAT_ADAPTER: real\n',
    expect: /WECHAT_ADAPTER must be fake/
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
    to: '      WECHAT_ADAPTER: fake\n      WECHAT_APP_SECRET: real-app-secret\n',
    expect: /must not carry a value in Compose|WECHAT_APP_SECRET must not appear/
  },
  {
    name: 'the deployment identity is duplicated onto migrate',
    from: '      DATABASE_URL_FILE: /run/secrets/meal_agent_migration_database_url\n',
    to:
      '      DATABASE_URL_FILE: /run/secrets/meal_agent_migration_database_url\n' +
      '      DEPLOYMENT_STAGE: production\n',
    expect: /migrate: must not declare DEPLOYMENT_STAGE/
  },
  {
    name: 'the runtime secret file is swapped for the admin one',
    from: '      DATABASE_URL_FILE: /run/secrets/meal_agent_runtime_database_url\n',
    to: '      DATABASE_URL_FILE: /run/secrets/meal_agent_admin_database_url\n',
    expect: /api: runtime must never receive the meal_agent_admin_database_url credential|DATABASE_URL_FILE must point at/
  },
  {
    name: 'the runtime connection string is inlined as an environment value',
    from: '      DATABASE_URL_FILE: /run/secrets/meal_agent_runtime_database_url\n',
    to: '      DATABASE_URL: postgresql://meal_agent_runtime_login:pw@postgres/meal_agent\n',
    expect: /DATABASE_URL must not appear in Compose; use a secret file/
  },
  {
    name: 'a bootstrap password is inlined as an environment value',
    from: '      MEAL_AGENT_BACKUP_PASSWORD_FILE: /run/secrets/meal_agent_backup_password\n',
    to: '      MEAL_AGENT_BACKUP_PASSWORD: inlined-password\n',
    expect: /MEAL_AGENT_BACKUP_PASSWORD must not carry a value in Compose/
  },
  {
    name: 'the API host publish address is unqualified',
    from: '      - host_ip: 127.0.0.1\n',
    to: '      - host_ip: 0.0.0.0\n',
    expect: /host publish address must be exactly 127\.0\.0\.1/
  }
]

const failures = []
let checked = 0

const runChecker = () => {
  const result = spawnSync(process.execPath, [checker], {
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
      `the unmutated topology must pass before any mutation is meaningful:\n` +
        baseline.output
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
      writeFileSync(composeFile, source.replace(mutation.from, mutation.to))
      const result = runChecker()
      checked += 1
      if (result.status === 0) {
        failures.push(`${mutation.name}: NOT CAUGHT — the checker still passed`)
        continue
      }
      if (!mutation.expect.test(result.output)) {
        failures.push(
          `${mutation.name}: caught, but for the wrong reason (expected ` +
            `${String(mutation.expect)}):\n${result.output.trim()}`
        )
        continue
      }
      process.stdout.write(`  caught: ${mutation.name}\n`)
    } finally {
      writeFileSync(composeFile, original)
    }
  }
} finally {
  writeFileSync(composeFile, original)
}

if (!readFileSync(composeFile).equals(original)) {
  abort(
    `FATAL: ${composeFile} was not restored to its original bytes. ` +
      `Run: git restore -- ${composeFile}`
  )
}

if (failures.length > 0) {
  process.stderr.write('Compose topology mutation check FAIL\n')
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}

process.stdout.write(
  `Compose topology mutation check PASS ` +
    `(${String(checked)}/${String(mutations.length)} mutations caught with the ` +
    `named reason, 0 escapes, compose file restored byte-for-byte)\n`
)
