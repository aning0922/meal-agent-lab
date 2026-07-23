# ADR-0001：首发客户端平台与跨端框架

- 状态：Accepted
- 日期：2026-07-23
- 负责人：产品负责人、客户端工程
- 支撑材料：[首发客户端跨端技术验证](../cross-platform-technical-validation.md)

## 背景

Meal Agent 首发目标是微信小程序，后续需要适配 Android、iOS 和 HarmonyOS。Agent 是“今天”等业务页面中的上下文能力，不是独立 Tab。P0 不包含语音、条码或 OCR，本次也不建设家庭、库存、推荐等正式业务。

阶段 04 只验证跨端框架和微信最小纵切，不以正式主体、正式 AppID、真实登录闭环、正式合法域名、体验版、审核或发布为验收条件。

客户端技术路线需要在以下事实之间取舍：

- 微信小程序必须先达到可构建、可调试和可持续交付；
- 产品不同时维护四套独立客户端，但也不假定所有 UI 和平台 API 能 100% 复用；
- 登录、分享、通知、媒体、权限和分发天然具有平台语义；
- 食品安全、权限、库存一致性和确认机制必须留在确定性领域层/服务端，不能因跨端框架而绕过；
- Android、iOS、HarmonyOS 的支持目前只有官方资料依据，没有本项目实机证据。

## 决策

### 框架与版本

正式客户端采用 **Taro 4.2.1 + React 18.3.1 + TypeScript 5.9.3** 作为当前基线，首发构建目标为微信小程序。Taro 相关包使用相同的精确版本，升级由依赖更新变更单和本 ADR 的复审条件控制。

该决定是对“微信首发客户端基线”的正式接受，不等于提前接受 Taro React Native 或 Taro HarmonyOS 为无条件的最终实现。Android、iOS、HarmonyOS 必须在进入正式业务开发前分别通过最小 spike；失败时允许保留共享契约和领域逻辑，改用分端 UI 或平台运行时。

现有 [`apps/meal-agent-client-spike/`](../../../apps/meal-agent-client-spike/) 是一次性验证资产，不是正式 `apps/client/`，不得直接扩写为完整业务。

阶段 04 的验证结果只允许 `Pass`、`Fail`、`Deferred — 外部依赖` 和 `Not applicable`。外部依赖未满足时保留 `Deferred`，不得因为 ADR 已接受而推定平台能力通过。

### 预计代码复用边界

| 层 | 预计复用 | 说明 |
| --- | --- | --- |
| API 契约、领域类型、校验规则、设计令牌 | 高 | 放在 `packages/`；只用与运行时无关的 TypeScript，不依赖 Taro/React |
| API client、错误模型、幂等标识、状态 action/view-model | 高到中 | 通过端口访问存储、网络和平台状态；逐端测试 |
| React hooks 和简单展示组件 | 中，待验证 | 微信实现不能视为 RN/Harmony 自动兼容；以平台 spike 的渲染与性能结果为准 |
| 页面壳、导航、复杂布局和样式 | 低到中 | 允许按小程序、RN、HarmonyOS 建不同入口和样式实现 |
| 登录、分享、通知、媒体、权限、深链、文件、原生扩展 | 低 | 只共享语义化接口与结果类型，平台实现独立 |
| 签名、构建、上架和渠道配置 | 不复用 | 每个平台独立配置，不进入共享业务包 |

### 平台适配层

客户端按 Ports and Adapters 组织：

```text
页面 / view-model
       │
语义化平台端口
├─ AuthPort
├─ StoragePort
├─ NetworkPort
├─ SharePort
├─ NotificationPort
├─ MediaPort
└─ Navigation / DeepLink Port
       │
平台实现
├─ Taro WeApp（首发）
├─ Taro React Native Android（待 spike）
├─ Taro React Native iOS（待 spike）
└─ Taro Harmony / 分端实现（待 spike）
```

业务页面不得直接调用 `wx.*`、React Native Native Module、ArkTS/C++ 或厂商 SDK。阶段 04 先实现 `AuthPort`、`StoragePort`、`NetworkPort`；`AuthPort` 使用明确标识为 `mock` 的本地会话，不调用 `wx.login`。端口返回值要区分“不支持”“未授权”“用户取消”“暂时失败”和“成功”，不能用布尔值掩盖平台差异。不确定的 OCR、图片识别和自然语言写操作仍需用户确认；本 ADR 不改变领域与安全底线。

### 平台顺序

工程验证和落地顺序为：

1. 微信小程序；
2. Android；
3. iOS；
4. HarmonyOS。

Android 先于 iOS 是为了先验证 Taro React Native 与共享 React/TypeScript 层的可行性，再补齐 Xcode、CocoaPods 和 Apple 签名链。HarmonyOS 使用不同的 C-API/DevEco 路线，最后单独评估。该顺序不是市场发布承诺，可由用户规模、合作渠道或法规要求复审。

### 必需工具

| 阶段 | 工具与版本 |
| --- | --- |
| 当前小程序 | Git（本次为 2.50.1）、Node.js 22.13.0–24.x（本次为 24.14.0）、pnpm 11.9.0、Taro CLI 4.2.1、微信开发者工具（本次模拟器预览为 Stable 2.01.2510290）；测试号真机预览需测试 AppID、工具登录和手机 |
| Android spike | 在开始时按 Taro 4.2.1/RN 模板锁定 JDK、Android Studio、Android SDK、NDK/Gradle；当前不预装 |
| iOS spike | 完整 Xcode、CocoaPods；真机和分发时需要 Apple 开发者账号与签名资产 |
| HarmonyOS spike | DevEco Studio、HarmonyOS SDK；模拟器/真机和发布按届时官方要求准备账号与签名 |

HBuilderX 不是选定路线的必需工具，不安装。微信真实 AppID、Apple/华为开发者账号、签名证书和 CI 凭据都不能提交到仓库。

## 备选方案

### uni-app x 5.15：拒绝作为当前首发基线

优点是以 Vue 3、UTS/Vapor 面向 Android、iOS、HarmonyOS 和微信，原生 App 与 HarmonyOS 的统一叙事比 Taro RN 路线直接。

拒绝原因：

- 当前目标首先是微信小程序，而 uni-app x 的微信支持进入较晚，平台兼容差异仍需持续查表；
- 官方工程化说明仍不能用 CLI 创建 uni-app x 项目，需 HBuilderX 创建后再接 CLI，且没有 ESLint 插件支持；
- 为当前小程序验证引入 HBuilderX 和 DCloud 构建链，会增加本项目的工具锁定；
- 本项目团队和契约层计划采用 React/TypeScript，改用 Vue/UTS 会扩大首发阶段的语言与工程切换。

如果后续 HarmonyOS 成为与微信同等优先级，或 Taro RN/Harmony spike 失败，uni-app x 应重新进入候选。

### 分端实现：拒绝作为当前默认路线

微信原生 + Android 原生/React Native + iOS 原生 + HarmonyOS ArkUI 能获得最直接的平台能力、调试和性能边界。

当前拒绝原因是页面、导航、状态、测试和发布流水线会大范围重复，不符合首发阶段“不同时建设四套独立客户端”。它保留为薄适配层无法控制平台差异时的降级路线；即使改为分端 UI，`packages/contracts`、领域规则和 API 语义仍应共享。

## 影响

### 收益

- 微信小程序已有真实构建和 IDE 模拟器运行证据，不只依赖框架宣传；
- React/TypeScript、CLI、自动测试和锁文件适合代码审查与 CI；
- 平台端口把后续原生差异暴露在边界处，避免 `wx.*` 渗入页面和领域包；
- 不为尚未开始的原生平台提前安装大型 SDK 或建立空工程。

### 成本与风险

- Taro 4.2.1 的 RN 包元数据仍以 React Native 0.73.1、Expo 50 为 peer 基线，而当前 RN 主线更高；官方 Taro RN 文档中的兼容矩阵也较旧；
- Taro HarmonyOS 需要 DevEco 工程和 Harmony C-API 插件，官方说明不能用 Previewer 替代模拟器或真机；
- Taro API 的平台徽标不保证登录、相机、分享和通知具有相同语义；
- Taro 配置文件和页面/样式在 RN/Harmony 目标可能需要独立入口；
- Taro 4.2.1、微信开发者工具和各平台 SDK 会继续变化，精确版本能保证重现但需要受控升级；
- 若后续 UI 复用率低，实际形态可能演变为“共享领域与契约 + 分端页面”，而不是单一 UI 代码库。

## 阶段 04 验证结果

2026-07-23 在 macOS Apple Silicon 上完成：

- `Pass`：固定依赖安装、peer dependency 检查、TypeScript 静态检查；
- `Pass`：5 个平台适配层自动测试；
- `Pass`：Taro 4.2.1 微信小程序生产构建；
- `Pass`：微信开发者工具游客模式中的“今天”“库存”页面与导航；
- `Pass`：`StoragePort` 本地状态、`NetworkPort` 模拟 HTTP API；
- `Pass`：`AuthPort` Mock 登录、恢复和退出，且明确没有调用 `wx.login`；
- `Pass`：Agent 位于业务页面上下文、没有新增一级入口；
- `Pass`：测试号本地预览目录可由环境变量重复生成；
- `Deferred — 外部依赖`：微信测试号真机预览、真实登录、合法域名和分享；
- `Not applicable`：阶段 04 的相机、语音、条码、OCR 和外部通知。

## 尚未验证

- 微信测试号真机扫码、真机本地存储和真机 Mock API；
- 真实微信登录、合法域名和邀请分享；
- 体验版上传、审核和发布；
- Android/iOS 的 Taro RN 构建、UI 复用率、原生模块、性能、权限、签名和商店包；
- HarmonyOS 的 DevEco 构建、C-API 插件、模拟器/真机、权限、签名和商店包；
- 外部通知、相机/媒体、深链、离线队列、幂等业务写入和跨设备恢复；
- 微信预览/上传 CI 与凭据管理；
- 正式客户端的状态管理、路由库、UI 组件策略和后端运行时。

上述项目均保持 `Deferred — 外部依赖` 或 `Not applicable`，不计入阶段 04 的 Pass。

## 后续阶段门禁

- 06 最小服务端完成后：验证 `wx.login` 服务端换码、内部用户会话、HTTPS 合法域名和网络错误路径；
- 家庭内测前：验证体验版上传、访问成员、二维码分发及多真机回归；
- 发布候选阶段：验证隐私与权限声明、审核提交/驳回处理、发布、监控和回退；
- 各原生平台正式开发前：分别完成 Android、iOS、HarmonyOS spike。

## 验证与复审

本 ADR 在以下任一条件出现时复审：

1. Android、iOS 或 HarmonyOS 开始正式业务开发之前；
2. 目标平台最小 spike 无法完成构建、调试、平台端口或签名链；
3. 共享 UI/状态层的实际复用率低于 60%，或条件编译开始侵入共享领域包；
4. Taro、React Native 或 HarmonyOS 插件发生 major 升级、停止维护或出现无法接受的安全问题；
5. 登录、分享、通知、媒体、深链或性能存在无法在薄适配层隔离的差异；
6. HarmonyOS 或原生 App 的业务优先级提升到与微信首发相同；
7. 测试号真机、06 登录/合法域名、家庭体验版或发布候选验证暴露框架级阻塞。

进入 Android spike 前优先确认 Taro 4.2.1/RN 的可用版本组合；进入 HarmonyOS spike 前优先确认当前 Taro Harmony 插件、DevEco 和目标 API level。复审结论使用新 ADR 替代本记录，不直接改写已发生的决策历史。
