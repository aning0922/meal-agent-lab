import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  spawn,
  type ChildProcess
} from 'node:child_process'

import { applyMigrations } from '../../../../../services/api/src/database/migrate'
import {
  assertStageNodeVersion,
  findPostgres18Bin
} from '../../../../../services/api/scripts/stage-environment'

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const apiDirectory = join(repoRoot, 'services', 'api')

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate a free port'))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error === undefined) {
          resolve(port)
        } else {
          reject(error)
        }
      })
    })
  })

const run = async (
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: environment,
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(
            `${command} failed with ${signal ?? `exit code ${String(code)}`}`
          )
        )
      }
    })
  })

const waitForReadiness = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 30_000
  let lastError = 'no readiness attempt completed'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/readyz`)
      if (response.status === 200) {
        return
      }
      lastError = `GET /readyz returned ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`API server did not become ready: ${lastError}`)
}

export interface E2eStack {
  readonly baseUrl: string
  stop(): Promise<void>
}

export interface E2eStackOptions {
  /** 固定 API 端口（本地联调用）；缺省自动分配空闲端口。 */
  readonly apiPort?: number
}

/**
 * 启动一套一次性验证栈：临时 PostgreSQL 18 集群 + 迁移 + 真实
 * services/api（fake 微信适配器）。与 services/api 的测试数据库
 * 脚本保持同一套 initdb/pg_ctl 约定。
 */
export const startE2eStack = async (
  options: E2eStackOptions = {}
): Promise<E2eStack> => {
  assertStageNodeVersion()
  const { binDirectory: postgresBin } = await findPostgres18Bin()

  const clusterRoot = await mkdtemp(
    join(tmpdir(), 'meal-agent-stage-07-e2e-')
  )
  const dataDirectory = join(clusterRoot, 'data')
  const socketDirectory = join(clusterRoot, 'socket')
  const databasePort = await freePort()
  const apiPort = options.apiPort ?? (await freePort())
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    // macOS 上 LC_ALL 缺失会让 postmaster 启动即崩溃，与阶段 06 保持一致。
    LC_ALL: process.env['LC_ALL'] ?? 'C',
    PGHOST: '127.0.0.1',
    PGPORT: String(databasePort),
    PGUSER: 'postgres'
  }

  let postgresStarted = false
  let apiProcess: ChildProcess | undefined

  const stop = async (): Promise<void> => {
    if (apiProcess !== undefined && apiProcess.exitCode === null) {
      const exited = new Promise<void>((resolve) => {
        apiProcess?.once('exit', () => resolve())
      })
      apiProcess.kill('SIGTERM')
      let graceTimer: NodeJS.Timeout | undefined
      await Promise.race([
        exited,
        new Promise((resolve) => {
          graceTimer = setTimeout(resolve, 5_000)
        })
      ])
      clearTimeout(graceTimer)
      if (apiProcess.exitCode === null) {
        apiProcess.kill('SIGKILL')
        await exited
      }
    }
    if (postgresStarted) {
      try {
        await run(
          join(postgresBin, 'pg_ctl'),
          ['-D', dataDirectory, '-m', 'immediate', '-w', 'stop'],
          environment
        )
      } catch (error) {
        // 停库失败时保留数据目录现场，避免删除仍在运行的 postmaster 的
        // 数据文件；泄漏的进程与目录留给人工诊断。
        console.error(
          `[stage-07 e2e] pg_ctl stop failed, keeping ${clusterRoot} for diagnosis:`,
          error instanceof Error ? error.message : error
        )
        return
      }
    }
    await rm(clusterRoot, { recursive: true, force: true })
  }

  try {
    await mkdir(socketDirectory)
    await run(
      join(postgresBin, 'initdb'),
      [
        '-D',
        dataDirectory,
        '--auth-local=trust',
        '--auth-host=trust',
        '--username=postgres',
        '--encoding=UTF8',
        '--no-instructions'
      ],
      environment
    )
    await run(
      join(postgresBin, 'pg_ctl'),
      [
        '-D',
        dataDirectory,
        '-o',
        `-F -p ${databasePort} -h 127.0.0.1 -k ${socketDirectory}`,
        '-w',
        'start'
      ],
      environment
    )
    postgresStarted = true
    await run(
      join(postgresBin, 'createdb'),
      ['meal_agent_stage07_e2e'],
      environment
    )

    // 这个一次性集群用 trust 认证，口令不会被校验；补一个**合成**口令是为了让
    // 连接串写明全部五个核心字段，从而不依赖宿主的 PG* 环境变量。
    const databaseUrl =
      `postgresql://postgres:synthetic-trust-cluster-password@127.0.0.1:${databasePort}` +
      `/meal_agent_stage07_e2e`
    // 端到端栈沿用单账号 bootstrap/admin 路径：这个一次性库没有做 owner 交接，
    // 冻结的 0000 还要自己 CREATE ROLE 并设置 BYPASSRLS，因此迁移必须由 cluster
    // admin 执行，不能先切换到 meal_agent_migrator。真实的 migration login
    // 路径由 services/api/tests/database/stage09a.roles.database.test.ts 覆盖。
    await applyMigrations(databaseUrl, { role: null })

    apiProcess = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts'],
      {
        cwd: apiDirectory,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          // M3A：部署阶段与暴露级别没有默认值，栈必须显式声明它是
          // loopback 上的 local-test，fake adapter 才被允许。
          DEPLOYMENT_STAGE: 'local-test',
          DEPLOYMENT_EXPOSURE: 'loopback',
          HOST: '127.0.0.1',
          PORT: String(apiPort),
          LOG_LEVEL: 'silent',
          DATABASE_URL: databaseUrl,
          WECHAT_ADAPTER: 'fake'
        },
        stdio: 'inherit'
      }
    )
    apiProcess.once('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(
          `[stage-07 e2e] API server exited early: code ${String(code)} signal ${String(signal)}`
        )
      }
    })

    const baseUrl = `http://127.0.0.1:${apiPort}`
    await waitForReadiness(baseUrl)
    return { baseUrl, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
