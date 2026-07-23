# 系统概览

## 状态

客户端平台决策已由 [ADR-0001](decisions/0001-client-platform-and-cross-platform-framework.md) 接受：微信小程序首发，使用 Taro 4.2.1、React 18.3.1 和 TypeScript 5.9.3。Android、iOS、HarmonyOS 仍需逐端 spike；后端运行时、部署和模型供应商仍是候选。

当前只有 [`apps/meal-agent-client-spike/`](../../apps/meal-agent-client-spike/) 技术实验，正式 `apps/client/` 尚未建立，也未实现业务功能。

## 逻辑边界

```text
客户端页面 / view-model ── 上下文 Agent 入口
          │
    语义化平台端口
          │
微信 Taro Runtime / 后续原生 Runtime
          │
       统一 API 契约
          │
账号与家庭 ─ 库存与批次 ─ 菜谱与菜单 ─ 购物清单 ─ 通知
          │               │
      关系数据库      规则与约束引擎
                          │
                    Agent 编排层
                     │         │
                  模型服务   P1 OCR/识别服务
```

## 初始架构原则

- 客户端共享领域契约，通过平台适配器处理登录、分享、相机、通知、本地存储、网络和深链差异；业务页面不直接调用 `wx.*` 或原生 SDK。
- 服务端从模块化单体开始，保证领域边界清晰但不提前拆分部署。
- 关系数据库是家庭、库存、权限和菜单事实的权威来源。
- 多端写操作具有幂等标识；库存使用事件流水和服务端版本处理并发。
- Agent 通过受限工具读取或修改业务状态，不能直接连接数据库。
- Agent 是“今天”等业务页面中的上下文能力，不建立独立一级导航。
- 常规筛选、日期计算和硬约束不依赖模型。
- P1 的图片、小票和导入任务通过异步任务处理，并保留原始来源与审核状态。

## 平台策略

按照“共享领域与契约 + 平台薄适配层 + 可替换页面实现”组织：

1. 微信小程序使用 Taro 构建首发客户端；
2. Android 和 iOS 先验证 Taro React Native，再决定 React 页面可复用范围；
3. HarmonyOS 单独验证 Taro Harmony C-API/DevEco 路线；
4. 若平台 spike 失败，保留 API 契约、领域规则、设计令牌和端口语义，允许该平台使用分端 UI/运行时。

预计高复用的是 `packages/contracts`、纯 TypeScript 领域规则、API client 语义和状态 action；页面、导航、样式、登录、分享、通知、媒体、权限、深链、签名与上架不能预设高复用。

工程验证顺序为微信小程序 → Android → iOS → HarmonyOS。这是技术落地顺序，不是市场发布承诺。

## 当前验证证据

- `Pass`：Taro 4.2.1 微信小程序固定依赖构建；
- `Pass`：微信开发者工具模拟器中的“今天”“库存”页面、Tab 导航、本地写入和本机模拟 API；
- `Pass`：`AuthPort`、`StoragePort`、`NetworkPort` 已建立，平台端口自动测试 5/5；
- Mock 登录、恢复和退出为 `Pass`，没有调用 `wx.login`；
- 微信测试号真机预览、真实登录、合法域名和分享为 `Deferred — 外部依赖`；
- 相机、语音、条码、OCR 和外部通知在阶段 04 为 `Not applicable`；
- 体验版、审核、发布、CI 上传和三个原生平台均未验证。

详细环境、候选比较和限制见[首发客户端跨端技术验证](cross-platform-technical-validation.md)。

## 后续架构验证

- 阶段 04 外部补证：微信测试号真机预览、真机存储和局域网 Mock API；
- 06 最小服务端完成后：真实微信登录、内部会话、HTTPS 合法域名和网络错误路径；
- 家庭内测前：体验版上传、成员访问权限、二维码分发和多真机回归；
- 发布候选阶段：隐私/权限声明、审核、发布、监控和回退；
- Android/iOS：Taro RN 版本组合、原生模块、权限、性能、签名和商店构建；
- HarmonyOS：DevEco 工程、C-API 插件、模拟器/真机、签名和商店构建；
- 跨端通用：离线提交、幂等写入、深链、恢复和 CI 凭据隔离。
