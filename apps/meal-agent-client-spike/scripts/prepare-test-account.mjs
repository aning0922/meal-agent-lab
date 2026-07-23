import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDist = resolve(spikeRoot, 'dist')
const previewRoot = resolve(spikeRoot, '.wechat-test-preview')
const testAppId = process.env.WECHAT_TEST_APP_ID?.trim()

if (!testAppId) {
  throw new Error('请通过 WECHAT_TEST_APP_ID 提供微信测试号 AppID')
}

if (!/^wx[0-9a-zA-Z]{16}$/.test(testAppId)) {
  throw new Error('WECHAT_TEST_APP_ID 格式不符合 wx + 16 位字符')
}

const sourceConfig = JSON.parse(
  await readFile(resolve(spikeRoot, 'project.config.json'), 'utf8')
)

await rm(previewRoot, { force: true, recursive: true })
await mkdir(previewRoot, { recursive: true })
await cp(sourceDist, resolve(previewRoot, 'dist'), { recursive: true })
await writeFile(
  resolve(previewRoot, 'project.config.json'),
  `${JSON.stringify(
    {
      ...sourceConfig,
      appid: testAppId,
      description: 'Meal Agent 阶段 04 微信测试号预览；非正式工程',
      projectname: 'meal-agent-stage-04-test-account'
    },
    null,
    2
  )}\n`
)

console.info('测试号预览目录已生成：.wechat-test-preview')
console.info('请在微信开发者工具中导入该目录；不要提交生成结果。')
