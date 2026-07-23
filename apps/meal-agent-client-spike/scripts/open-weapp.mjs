import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultCli =
  '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const cli = process.env.WECHAT_DEVTOOLS_CLI || defaultCli

if (!existsSync(cli)) {
  console.error(
    `未找到微信开发者工具 CLI：${cli}\n` +
      '请安装微信开发者工具，或设置 WECHAT_DEVTOOLS_CLI。'
  )
  process.exit(1)
}

const result = spawnSync(
  cli,
  ['open', '--project', spikeRoot, '--lang', 'zh'],
  { stdio: 'inherit' }
)

if (result.error) {
  throw result.error
}

process.exit(result.status ?? 1)
