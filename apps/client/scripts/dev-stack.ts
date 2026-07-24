import { startE2eStack } from '../tests/e2e/support/stack'

/**
 * 本地联调栈：临时 PostgreSQL 18 + 迁移 + services/api（fake 微信适配器）。
 * 供微信开发者工具模拟器手工验证使用：
 *
 *   MEAL_AGENT_DEV_API_PORT=3000 pnpm --filter @meal-agent/client dev:stack
 *
 * 客户端构建默认指向 http://127.0.0.1:3000（见 config/index.ts）。
 * Ctrl-C 退出时自动清理临时数据库集群。
 */
const requestedPort = process.env['MEAL_AGENT_DEV_API_PORT']

const stack = await startE2eStack(
  requestedPort === undefined ? {} : { apiPort: Number(requestedPort) }
)

console.info(`[dev-stack] API ready at ${stack.baseUrl} (WECHAT_ADAPTER=fake)`)
console.info('[dev-stack] 按 Ctrl-C 结束并清理临时数据库。')

const shutdown = async (): Promise<void> => {
  console.info('\n[dev-stack] shutting down…')
  await stack.stop()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

await new Promise(() => undefined)
