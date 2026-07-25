# 阶段 08 微信开发者工具走查证据

- 日期：2026-07-25
- 分支：`codex/stage-08-audit-closeout`
- 构建目录：`apps/client/dist`
- 微信开发者工具：RC `2.02.2607171`
- 后端：本机 fake WeChat adapter + 临时 PostgreSQL 18，仅使用合成家庭、成员和约束数据
- 结论：本地模拟器 happy path 通过；不代表真实微信登录、合法域名、真机、体验版或发布通过

## 实际页面路径

1. [登录页](01-login.jpg)：从实际小程序入口执行 fake 登录。
2. [创建家庭](02-household-created.jpg)：创建并进入合成家庭。
3. [成员页 owner/self](03-members-owner-self.jpg)：实际渲染 MembersPage，owner 行正确显示“我”，没有落入移除他人的错误路径。
4. [完整硬约束和映射状态](04-hard-constraint-mapping.jpg)：创建 structured allergy/peanut，并创建尚无正式词表的 religious hard constraint；页面显示“待结构化；推荐必须阻断”。
5. [归档](05-archive.jpg)：从实际 ProfilePage 归档 dining-only profile。
6. [同 ID 恢复](06-restore-same-profile.jpg)：从 archived 列表恢复同一 profile，不复制创建。
7. [未知事实修复后复跑](07-household-unknown-defaults-fixed.jpg)：走查发现家庭创建仍猜测饭量、默认参与和厨艺后，修正为 `unknown/null`，重新构建并从实际家庭页确认。

走查还覆盖 profile 编辑入口、active/archived 过滤和恢复后的详情读取。同动作重试、双用户关联确认、跨家庭隔离与数据库并发由自动化门禁覆盖；本记录不把单模拟器会话夸大为真实双设备 GUI。

## 数据与密钥边界

导入开发者工具时只使用本机 gitignored 的临时 private config；仓库配置保持 `touristappid`。证据文件不包含真实 AppID、AppSecret、token、邀请码、真实用户或健康数据。走查完成后临时 private config 从源码工作区移除；后续构建产物也不得提交该文件。

## 文件校验

| 文件 | SHA-256 |
| --- | --- |
| `01-login.jpg` | `97735bbc48c8696766786a49059a1b518f9674afb9db6a447037f456d5f8ba06` |
| `02-household-created.jpg` | `90e5aa91f77346aaa2f186565db2ad7c516905c5ac7ed572d8fc26e712e4f407` |
| `03-members-owner-self.jpg` | `779a353d40d40233928686563c51c21b6a60bb9a6c57ab4cefdabf8797d14ef4` |
| `04-hard-constraint-mapping.jpg` | `69950b7d67abeb3d9a0fe8f88624d71ceb5df4141be58721b4e067f02baaa431` |
| `05-archive.jpg` | `8cd2c486e22e6b7fd9bce1f8862db92abddd739e8a0b8269e0e8eebfbcbe6abb` |
| `06-restore-same-profile.jpg` | `11c59b95a8a78b4629fc03512378a97f16394486c3537b00aa7da3c97c7a6571` |
| `07-household-unknown-defaults-fixed.jpg` | `fabc68fecc417adb80a4bc15acf862faf35be7deaa5543bda870a69c68096cc7` |
