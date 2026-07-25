# 阶段 08 微信开发者工具走查证据

- 日期：2026-07-25
- 分支：`codex/stage-08-audit-closeout`
- 构建目录：`apps/client/dist`
- 微信开发者工具：RC `2.02.2607171`
- 后端：本机 fake WeChat adapter + 临时 PostgreSQL 18，仅使用合成家庭、成员和约束数据
- 结论：本地模拟器入口与二次整改页面复跑通过；不代表真实微信登录、合法域名、真机、体验版、外部测试或发布通过

## 实现与构建绑定

首轮 7 张流程截图来自 commit `3c52a35c5b9d98eb3a156527a01b82a54daa1748`、tree `aa3e3d46719143be4daaec17fea6ea2ed1c57daa`。它们只保留阶段 08 首轮 happy path 的历史证据；其中旧 hard mapping 展示已被二次整改取代，不能作为当前 `structured` 语义的证据。

二次整改 4 张截图来自 commit `c68217ed5771252f54cb62e8b8e37d5f67d57269` 的已提交实现子树，并使用以下构建：

| 项 | 值 |
| --- | --- |
| `apps/client` tree | `ddc358742332e73cdbe1ed9347d6246f69b1c865` |
| `packages/contracts` tree | `f88fc137f6576277712d5c875df0225324e336a5` |
| `services/api` tree | `ea611cc7446e2cf73bbfed3caccf801b982618e0` |
| Node.js / pnpm | `24.14.0` / `11.9.0` |
| Taro / React | `4.2.1` / `18.3.1` |
| weapp 文件数 / 字节数 | `30` / `525770` |
| weapp artifact SHA-256 | `f82bea53be6edb1020575029bd77eb96e2f4a6b3912b00e99bbb5506a2ead0fb` |
| audit 产物扫描 | 截图构建时 0 条禁止签名；[机器证据](../stage-08-audit/weapp-advisory-scan.json) 已更新为 0004 最终构建，不能反向冒充截图构建 |

这三个子树不包含本目录，避免“证据文件引用包含自身的 tree”循环。本轮 0004 最终收口改变了结果未知状态机、关联披露和 TOCTOU 行为；这些增量由真实页面渲染、API 与 PostgreSQL 门禁验证，没有把上述旧截图伪装成新实现 tree 的 GUI Pass。

## 实际页面路径

首轮流程：

1. [登录页](01-login.png)：从实际小程序入口执行 fake 登录。
2. [创建家庭](02-household-created.png)：创建并进入合成家庭。
3. [成员页 owner/self](03-members-owner-self.png)：owner 行正确显示“我”。
4. [首轮 hard constraint 行为](04-hard-constraint-mapping.png)：历史截图；二次整改已禁止把仅有形状校验的标识写为 `structured`。
5. [归档](05-archive.png)：从实际 ProfilePage 归档 profile。
6. [同 ID 恢复](06-restore-same-profile.png)：恢复原 profile，不复制创建。
7. [未知事实修复后复跑](07-household-unknown-defaults-fixed.png)：家庭创建显示饭量、默认参与和厨艺为 unknown/null。

二次整改复跑：

1. [owner/self 与约束计数](stage08-members-secondary.png)：`c68217ed` 的实际 MembersPage，owner 行正确显示“我”，最后 owner 保护仍生效。
2. [未经权威映射的 hard constraint](stage08-hard-secondary.png)：合成宗教硬约束固定显示“待权威结构化映射；推荐必须阻断”。
3. [归档原档案](stage08-archive-secondary.png)：`c68217ed` 实现归档同一 linked profile。
4. [恢复原档案](stage08-restore-secondary.png)：同一档案从 version 2 恢复为 active/version 3，没有复制身份。

二次复跑还从页面确认五类 hard constraint 入口、unknown 用户事实和 active/archived 切换。同动作冻结、关联安全披露、退出/移除后果、不可恢复原因、双用户确认、跨家庭隔离和数据库竞态由真实页面测试或 PostgreSQL/E2E 门禁覆盖；本记录不把单模拟器会话夸大为真实双设备 GUI。

## 隐私与元数据

所有证据都裁剪为 `282×610` 的模拟器区域，不包含开发者工具账号头像、编辑器、源码树或桌面。文件统一转为 PNG；嵌入式 creation、camera make/model 和 GPS latitude/longitude 均为空。证据不包含真实 AppID、AppSecret、token、邀请码、真实用户或健康数据。

导入开发者工具时使用仓库 `touristappid` 配置；本地生成的 `project.private.config.json` 保持 gitignored。没有执行预览、真机调试或上传。

## 文件校验

| 文件 | SHA-256 |
| --- | --- |
| `01-login.png` | `ce38ed40e9eec200a84a7198e6bf8b08c1a0956280d8d8c6cd62084c093ab2c9` |
| `02-household-created.png` | `7e48b0da134cc74d4b6eefe86af6319c09ceaf19b43ebd3f2f505ed05230a055` |
| `03-members-owner-self.png` | `1228b25411358161cfdccde3c5877c785f45db47ae2873e22db686ac276d59d6` |
| `04-hard-constraint-mapping.png` | `e9ee412df933cd98ef8acb120ea98cd2e19c3594b90a5bd45ce33395eba746af` |
| `05-archive.png` | `1624f9e39af7510cfaa076f7ed91122adc47798898f38d6e571320674e14a89c` |
| `06-restore-same-profile.png` | `10020e7119a1b5077806088d0090c618cb948d3671c917f2dbc79a59f0e8411b` |
| `07-household-unknown-defaults-fixed.png` | `afad2ece73b66c2c66c21ac29ef43a3d4840deb1384eb2042a929df2a9f5c0ce` |
| `stage08-members-secondary.png` | `b1b652e95ef7c9686be9e6d6703848d25ba1885b1c8aea8c5fa19bb88f4f5e9d` |
| `stage08-hard-secondary.png` | `b7fe40a05f52e4fa3970ff717aa21c0358b139999dab7cbcf841825367609a84` |
| `stage08-archive-secondary.png` | `cc1d1c544a3e81bee39499e9c9445c73d599fc5da7558aebcda0cce2d9a69762` |
| `stage08-restore-secondary.png` | `63a65bfab8f3d131d406128b57fb7c6aa943187f20a6d51b0e8ff39a295a10ef` |
