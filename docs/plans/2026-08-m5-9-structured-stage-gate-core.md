# M5.9 结构化阶段门禁核心与显式命令面整改任务书

## 状态

- 日期：2026-08-20
- 基线：`e986b28`
- 范围：M5 聚合门禁、动态 Audit-B 证据、生产 guard 命令面、备份输出所有权与 runtime image `ONBUILD` 边界
- 当前：Implementation complete — pending independent A/B review；M5 未 Accepted；阶段 09A 仍为 In Progress

## 一、为什么不再修补旧 wrapper

M5.8 的两路独立审计证明，旧结构把同一次阶段门禁拆成了三个相互竞争的事实源：

1. 人类 CLI 打印的 stdout transcript；
2. Audit-B wrapper 对 transcript 的再次解析；
3. wrapper 自己维护的 invocation、signal、PGID 与报告发布生命周期。

在这种结构下，哪怕每个局部 parser 都继续加反例，仍会出现“真实门禁已执行、报告却由另一份文本状态机解释”的双事实源。静态 guard 同时用有限 AST 形状推断“哪些文件算入口”，会把可信代码审查范围和不可信运行时输入边界混在一起。

M5.9 因此停止增加 transcript/parser 分支，改成一个进程内、单次调用、闭合结构的阶段门禁核心。

## 二、唯一机器事实源

`scripts/run-stage09a-check.mjs` 导出 `runStage09aCheck()`。它仍按登记顺序执行 14 个真实门禁，但机器结果只从内存返回：

```text
{
  gate: {
    status,
    reason,
    exitCode,
    signal,
    completedSteps,
    failedStep
  },
  requestedSignal
}
```

约束如下：

- 一进程只允许一次真实调用；调用计数由模块在调用边界递增，Audit-B 不得硬编码；
- PASS 必须是 14 个登记 step 的完整、精确、有序列表；空列表、乱序、重复、未知 step、额外字段都不能成为 PASS；
- 普通失败、signal 与完整成功各有互斥形状；
- stdout 只供人阅读，不再参与任何机器验收或报告生成；
- `process.exitCode` 与最终同名 signal 重投只存在于最外层 CLI main guard，核心本身不结束进程。

## 三、Audit-B 是同一核心的结构化消费者

`scripts/run-stage09a-audit-b.mjs` 不再 spawn 第二个 aggregate，也不解析 transcript。它在同一进程直接调用一次 `runStage09aCheck()`，并从真实模块计数器取得 `invocationCount` / `retryCount`。

报告使用闭合 schema：

- expected / before / after candidate HEAD；
- before / after clean；
- required / actual Node version；
- 实际 invocation / retry；
- 结构化 gate；
- `remoteCiVerified=false`；
- `verdict=evidence-only-not-acceptance`。

外部异常文本、stdout/stderr、Git 或 runner 的原始字段不得进入报告。无效输入只折叠成固定原因。

### 报告发布的原子边界

报告通过 exclusive + durable publication 写成后，即是本次本地证据的**终端提交点**：

- 发布前发生的 INT/TERM/HUP 必须由结构化核心收敛，不得发布 PASS；
- 发布后不再有 await、子进程、PGID、cleanup 或报告改写；
- 发布后的新 signal 属于“已提交证据之后的调用方进程处置”，不会追溯篡改已完成的报告；
- CLI 若需保留同名 signal 语义，只能在报告提交之后由最外层 main guard 重投。

这一定义取代 M5.8 的“wrapper 全生命周期 transcript + signal”模型。

## 四、显式命令面，不再把任意 tracked 文件当潜在 CLI

`m5CliEntrypoints` 是受代码评审的闭合命令面：

- 五个使用共享 signal settlement 的 infra CLI；
- `stage09a:check` 的结构化核心入口；
- `stage09a:audit-b` 的结构化审计入口。

门禁继续要求所有 `stage09a:*` package script 必须落在该 manifest，且每个 manifest 项满足自己的 settlement 形状。任意新建但未被 manifest、package script 或生产导入图引用的 tracked `.mjs` 不自动取得“生产 CLI”身份。

这是工程 guard，不是对可信源码作者的形式化隔离。能够修改已审查代码、manifest、Git 工作树或在运行中以同一 EUID 改写仓库的主体属于受信开发环境；本阶段不把恶意同 EUID 并发写者当作威胁模型。运行前后仍必须使用 canonical Git view，拒绝 replace refs / alternate index 等已登记环境改写，并核对同一 HEAD 与 clean 状态。

## 五、真实调用边界与 runtime image 补口

- 备份的 pre-fork 输出登记直接位于 `performBackup()` 的真实 fork 边界，不再靠一个可被同名 decoy 满足的 wrapper；mutation 直接弱化共享 evidence protocol，再执行真实备份路径。
- runtime Dockerfile 明确拒绝 `ONBUILD`；镜像 Config 同时要求 `OnBuild` 缺席。
- mutation suite 新增一个真实 built `ONBUILD` 反例，因此当前精确计数变为 **1 baseline + 18 built + 2 static-only**。

## 六、验收与停止条件

提交候选前必须串行取得：

1. 固定 Node.js `v24.18.0` 的 `node --test scripts/tests/*.test.mjs`；
2. `pnpm stage09a:check` 从步骤 1 跑完 14/14；
3. `pnpm docs:links:check`；
4. `git diff --check`；
5. scoped container/network/volume/image/temp/override/PGID 零残留；
6. 工作树 clean 后，由两个全新、互相独立的只读 A/B 会话审计同一精确候选。

本任务不推送、不合并、不创建或更新 PR，不把 workflow 配置写成远端 CI PASS，也不自行标记 M5 Accepted 或阶段 09A Pass。

## 七、本地实现证据

- 固定 Node.js `v24.18.0`：scripts tests **188/188**；
- runtime image mutation：**1 baseline + 18 built + 2 static-only**，新增 `ONBUILD` 反例按指定理由转红；
- `pnpm stage09a:check` 从步骤 1 串行执行并 **14/14 PASS**，包含 fresh smoke、八份 Secret identity、生命周期与 same-ledger 备份恢复；
- 文档门禁：**72 files / 302 local links PASS**；
- 本轮仍未取得独立 A/B CLEAN，也没有真实远端 GitHub Actions run，因此只能写 Implementation complete，不能写 Accepted 或 09A Pass。
