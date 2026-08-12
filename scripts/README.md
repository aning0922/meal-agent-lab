# Scripts

存放可重复执行、适合本地开发或持续集成的脚本，例如：

- 初始化开发环境；
- 校验数据来源和 schema；
- 导入种子数据；
- 运行安全回归集；
- 生成 API 或领域契约；
- 渲染和检查文档。

脚本应支持重复执行，避免依赖个人目录和隐式全局环境。

阶段 09A 的单一聚合入口是 [`run-stage09a-check.mjs`](run-stage09a-check.mjs)，根命令
为 `pnpm stage09a:check`。它固定串联 14 个既有门禁/演练，前置探针与步骤统一按
独立进程组管理；信号、超时或步骤退出后残留后代都会 fail closed。对应的不依赖
Docker 回归位于 [`tests/stage09a-check.test.mjs`](tests/stage09a-check.test.mjs)。
