// 阶段 09A / M3B：门禁自身的**输出边界**。
//
// 反例套件与 smoke/probe 会把「实际发生了什么」写进失败消息，而那些文本的来源
// 大多是**不可信的**：checkSecretBundle 的 problems（可能含被变异过的取值）、
// cleanupRun 的 residue（内嵌 docker 原始 stderr）、子进程 stdout/stderr、目录
// 条目名（条目名本身可能就是一段口令）。第三轮阻断整改因此定下两条硬规矩：
//
//   1. 任何要输出的文本先过 `scrub`；
//   2. 「抓到了，但理由不对」这类分支**只输出固定类别与计数**，绝不拼接原始
//      problems / residue。
//
// 打码有两层：
//
//   - **按取值**（`scrub`）：调用方登记的已知敏感取值（口令、URL、pgpass 行、
//     URL 编码形态……）逐个替换掉。本仓自己写的证据行走这一条，因为 image ID
//     之类的证据必须保持可读；
//   - **按取值 + 按形状**（`scrubUntrusted`）：外来文本再加一层形状判据——口令
//     形态的长串、任何 `scheme://…`、pgpass 行的**口令段**一律打码。形状层不
//     需要事先知道取值，因此在「取值尚未生成 / 已被删除 / 根本不在本进程内」
//     的时刻仍然有效，而按取值那一层在这些时刻是空的。形状规则刻意只吃它能
//     确指的那一段，绝不整行抹掉——失败信息必须保住它的指定理由。
//
// 本模块自身不产生任何 Secret，也不保留输入文本。
export const REDACTED_VALUE = '[redacted-secret]'
export const REDACTED_TOKEN = '[redacted-token]'
export const REDACTED_URI = '[redacted-uri]'
export const REDACTED_PGPASS = '[redacted-pgpass-secret]'

/**
 * 按**形状**打码：与是否知道具体取值无关。
 *
 *   - pgpass 行：`host:port:database:user:secret`。**只替换最后一段**（口令），
 *     前四段原样保留。此前这条规则替换整行，而且四段之间不要求任何形状，于是
 *     `ts=2026-07-31T23:10:05Z:step:migrate:exit=1 …` 与
 *     `MEAL_AGENT_API=http://[::1]:3000/readyz` 这类**完全无害的诊断**被整行
 *     抹成一个占位符——失败信息因此丢掉了它的指定理由，正是本轮要消灭的形态。
 *     现在 port 必须是数字、口令段必须无空白且直到行尾，两个反例都不再命中；
 *   - `scheme://…`：任何连接串（含 userinfo 与查询参数）；
 *   - `[A-Za-z0-9]{32,}`：生成口令是 48 位 base62，这条覆盖它以及任何同形状的
 *     长串（顺带覆盖 sha256 摘要与容器 ID——在失败消息里打掉它们没有损失）。
 */
export const redactByShape = (text) =>
  String(text)
    .replace(/^([^\s:]+:\d{1,5}:[^\s:]*:[^\s:]+:)(\S+)$/gm, `$1${REDACTED_PGPASS}`)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, REDACTED_URI)
    .replace(/[A-Za-z0-9]{32,}/g, REDACTED_TOKEN)

/**
 * 敏感取值登记器。`register` **累加**（不是替换）：晚到的一批取值不会把早先
 * 登记的那批挤掉。替换按长度降序，避免短值先把长值切碎。
 */
export const createSecretScrubber = () => {
  let values = []
  const register = (incoming) => {
    values = [
      ...new Set([
        ...values,
        ...[...incoming].filter((value) => typeof value === 'string' && value.length > 0)
      ])
    ].sort((left, right) => right.length - left.length)
  }
  /** 按取值打码。用于**本仓自己写的**证据行（image ID 之类要保持可读）。 */
  const scrub = (text) => {
    let output = String(text)
    for (const value of values) {
      output = output.split(value).join(REDACTED_VALUE)
    }
    return output
  }
  /**
   * 按取值 + 按形状打码。用于**外来文本**：子进程 stdout/stderr、docker 错误、
   * problems / residue、目录条目名。即使 values 还是空的（取值尚未生成或已被
   * 删除），形状层仍然拦得住口令形态的长串与连接串。
   */
  const scrubUntrusted = (text) => redactByShape(scrub(text))
  return { register, scrub, scrubUntrusted, size: () => values.length }
}

/**
 * 「抓到了，但理由不对」分支的**固定类别**消息。
 *
 * 刻意**不**回显 problems/residue 的任何一条：它们可能内嵌被变异的取值、docker
 * 原始 stderr 或目录条目名。输出里只有三样东西，全部是本仓源码里的常量或计数：
 * 期望的判据、实际条目数、以及固定说明。
 */
export const wrongReason = (expected, actualItems) => {
  // 非数组也要如实计数：此前一律记 0，于是「传错了参数」看起来像「一条都没
  // 有」——把调用方的失误说成了被测实现的结论。
  const count = Array.isArray(actualItems)
    ? actualItems.length
    : actualItems === null || actualItems === undefined
      ? 0
      : 1
  return (
    `caught, but for the wrong reason (expected ${String(expected)}); ` +
    `${String(count)} reported item(s) did not match and are deliberately not ` +
    'echoed (gate output never re-prints raw problem or residue text)'
  )
}
