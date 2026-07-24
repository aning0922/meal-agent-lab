import { z } from 'zod'

/**
 * 微信小程序运行时禁用动态代码执行（`new Function`/`eval`），而 Zod v4 的
 * 对象校验默认走 JIT 快路径——用动态编译生成解析器。该路径在小程序沙箱里
 * 失效，任何对象 schema 的 `safeParse` 会抛 "a is not a function"。
 *
 * 关闭 JIT（jitless）后回退到解释执行路径，结果完全一致、仅略慢。JIT 开关在
 * schema **构造时**被捕获，因此本配置必须在任何 `@meal-agent/contracts`
 * schema 构造之前执行——本模块被 `app.tsx` 作为首个副作用 import 引入，而
 * 小程序保证 `app.js` 早于所有页面（契约在页面首次 import 时才构造）。
 */
z.config({ jitless: true })
