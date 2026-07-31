#!/usr/bin/env node
// 阶段 09A / M3B：preflight 信号窗口回归的**测试 fixture**——不是生产入口，
// 任何部署流程都不得调用它。
//
//   node infra/docker/fixtures/preflight-signal-window.mjs \
//     --directory <绝对路径> [--hold-ms <毫秒>]
//
// 为什么需要它：要证明「SIGINT 落在**同步** preflight 期间时，生成器不留下
// 任何 Secret、不打印成功、并按原信号语义退出」，就必须有一段**确定性的**
// 同步 preflight 窗口。此前这段窗口由生产 generator 里的
// `MEAL_AGENT_M3B_PREFLIGHT_DELAY_MS` 制造——那等于让生产二进制带着一个可被
// 环境变量打开的忙等分支出厂，任何人都能用它改变生产时序。该分支已被删除。
//
// 现在窗口只由本 fixture 通过**库级注入 seam** 制造：
//
//   - 运行的是**真实**的 `runGeneratorCli`（生产 CLI 入口调的同一个函数），
//     因此 `installSignalHandlers` 的真实处置、生成前的让位 tick、真实的
//     `generateAndPreflightInterruptible`、真实的成功/中断判定全部照原样执行；
//   - 唯一的差别是传给它的 `preflight`：先打一行窗口标记，再**同步忙等**，
//     最后调用**真实**的 `checkSecretBundle`。判据本身没有被替换。
//
// fixture 不打印任何 Secret：它的输出只有窗口标记，其余全部来自生产代码。
import { isAbsolute } from 'node:path'

import { runGeneratorCli } from '../generate-local-test-secrets.mjs'
import { checkSecretBundle } from '../local-test-secrets-contract.mjs'

/** 进入同步 preflight 窗口的标记行（供反例定位发信号的时刻）。 */
export const preflightWindowMarker = 'fixture: entered the synchronous preflight window'

const usage = () => {
  process.stderr.write(
    'usage: fixtures/preflight-signal-window.mjs --directory <absolute path> ' +
      '[--hold-ms <milliseconds>]\n'
  )
}

const args = process.argv.slice(2)
let directory = null
let holdMs = 900
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index]
  const value = args[index + 1]
  if (value === undefined) {
    usage()
    process.exit(2)
  }
  if (flag === '--directory') {
    directory = value
  } else if (flag === '--hold-ms') {
    holdMs = Number(value)
  } else {
    usage()
    process.exit(2)
  }
}
if (directory === null || !isAbsolute(directory)) {
  usage()
  process.exit(2)
}
if (!Number.isInteger(holdMs) || holdMs <= 0 || holdMs > 30_000) {
  usage()
  process.exit(2)
}

await runGeneratorCli(directory, {
  preflight: (bundleDirectory) => {
    process.stderr.write(`${preflightWindowMarker}\n`)
    const until = Date.now() + holdMs
    while (Date.now() < until) {
      // 刻意的同步忙等：这一段**不让出事件循环**，因此期间到达的
      // SIGINT/SIGTERM 只能排队，必须等它结束才被分发——正是要回归的窗口。
    }
    // 判据本身不被替换：真实的部署前预检。
    return checkSecretBundle(bundleDirectory)
  }
})
