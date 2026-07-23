# 阶段 04：首发客户端跨端技术验证

- 验证日期：2026-07-23
- 结论状态：框架决策 `Accepted`；微信构建和开发者工具模拟器纵切为 `Pass`；测试号真机预览为 `Deferred — 外部依赖`
- 正式决策：[ADR-0001](decisions/0001-client-platform-and-cross-platform-framework.md)
- 实验代码：[`apps/meal-agent-client-spike/`](../../apps/meal-agent-client-spike/)

## 1. 范围与判定标准

本轮只回答“微信小程序优先时，哪条客户端路线最适合进入正式工程准备”，不实现家庭、库存、推荐、Agent 对话、语音、条码或 OCR。Agent 只作为业务页面中的上下文能力保留边界。

阶段 04 的验收范围是：

1. 能以固定依赖构建微信小程序并在微信开发者工具中运行；
2. 通过开发者工具模拟器验证页面导航、本地存储和 Mock API；
3. 先建立 `AuthPort`、`StoragePort`、`NetworkPort`，真实登录使用可持久化的 Mock 实现；
4. 提供微信测试号真机预览的可复现准备命令；只有实际扫码运行后才能标记为 `Pass`；
5. 不把 Android、iOS、HarmonyOS 的文档声明误写为实机验证；
6. 把共享领域逻辑与平台 API、页面渲染和原生工程分开；
7. 具备可脚本化的构建、静态检查和测试入口。

以下内容明确不作为阶段 04 的 Pass 条件：正式主体、正式 AppID、真实微信登录闭环、正式合法域名、体验版上传、审核和发布。

所有验证项只使用以下四种结果：

| 结果 | 含义 |
| --- | --- |
| `Pass` | 本项目已产生可复现的执行证据 |
| `Fail` | 已执行且未满足成功条件 |
| `Deferred — 外部依赖` | 受账号、服务端、设备、平台阶段或其他外部条件限制，当前没有 Pass 证据 |
| `Not applicable` | 明确不属于阶段 04 产品或技术范围 |

`Deferred — 外部依赖` 不降低框架 ADR 的 `Accepted` 状态，但不得写成“已验证通过”。

## 2. 环境审计

### 2.1 审计结果

| 项目 | 审计时状态 | 本次处理 | 结论 |
| --- | --- | --- | --- |
| macOS | 26.5.2，Apple Silicon | 无 | 可进行小程序构建和预览 |
| Git | Apple Git 2.50.1 | 无 | 满足验证 |
| Node.js | 普通 shell 未配置；Codex 工作区运行时提供 24.14.0 | 固定 `.node-version` 和 engine 范围 | 正式开发机需安装 22.13.0–24.x |
| pnpm | Codex 工作区运行时提供 11.9.0 | 固定 `packageManager` 和锁文件 | 满足验证 |
| 微信开发者工具 | 未安装 | 通过 Homebrew 安装 | Stable 2.01.2510290 完成模拟器人工预览；测试号真机预览待外部条件 |
| HBuilderX | 未安装 | 未安装 | 仅 uni-app x 路线需要 |
| Xcode | 只有 Command Line Tools 和 Swift 6.2.4，无完整 Xcode/CocoaPods | 未安装 | 仅 iOS 原生构建阶段需要 |
| Android 工具链 | 无可用 JDK、Android Studio、SDK、adb 或 Gradle | 未安装 | 仅 Android spike 需要 |
| DevEco Studio | 未安装 | 未安装 | 仅 HarmonyOS spike 需要 |

本次唯一新增的重型 GUI 工具是微信开发者工具：

```bash
brew install --cask wechatwebdevtools
```

IDE 在验证完成后触发了自动更新；上表版本是实际完成人工预览时记录的产品版本。复验时应记录 IDE “关于”页面显示的版本，不应以 Electron 容器的 bundle 版本代替产品版本。

### 2.2 工具需求边界

| 工具 | 何时实际需要 | 影响 |
| --- | --- | --- |
| 微信开发者工具 | 现在：编译结果、模拟器和测试号真机预览 | 模拟器可用游客模式；真机需要微信测试号、开发者工具登录和手机扫码，阶段 04 不要求正式主体或正式 AppID |
| HBuilderX | 仅在复审或改选 uni-app x 时 | uni-app x 官方仍要求用 HBuilderX 创建项目；会增加 GUI 与厂商工具链依赖 |
| Android Studio、Android SDK、JDK | Android React Native spike 开始时 | 多 GB 下载、SDK 许可与环境变量；SDK 版本应由届时 Taro/RN 模板锁定，不提前安装 |
| Xcode、CocoaPods | iOS spike 开始时 | 完整 Xcode 体积大；真机签名和分发需要 Apple 开发者账号 |
| DevEco Studio、HarmonyOS SDK | HarmonyOS spike 开始时 | 独立 IDE/SDK；模拟器、真机、签名和服务发布可能需要华为账号 |

这样处理避免了为了候选方案比较同时安装三套原生 SDK。官方环境要求参考 [React Native 环境配置](https://reactnative.dev/docs/set-up-your-environment)、[DevEco Studio](https://developer.huawei.com/consumer/cn/deveco-studio/) 和 [Xcode](https://developer.apple.com/xcode/)。

## 3. 候选方案比较

对比依据为 2026-07-23 获取的官方文档和包元数据。平台标记只代表存在适配入口；涉及账号、权限、系统 UI 或分发的能力仍需逐端实测。

### 3.1 总体比较

| 维度 | Taro 4.2.1 | uni-app x 5.15 | 分端实现 |
| --- | --- | --- | --- |
| 微信小程序成熟度 | 长期核心目标；CLI、微信插件、测试工具和小程序 CI 路径清晰 | 已支持微信小程序，但 uni-app x 的微信支持晚于其 App 路线，仍有兼容性表和 HBuilderX 约束 | 微信原生能力最直接，但不能减少后续客户端数量 |
| Android / iOS | 通过 Taro React Native；当前 4.2.1 包的 peer 基线仍是 RN 0.73.1、Expo 50，需单独 spike | UTS 编译到 Kotlin/Swift，App 是核心目标；平台 API 差异仍存在 | 原生适配最完整，iOS/Android 各自维护 |
| HarmonyOS | 4.1+ 提供 Harmony C-API 插件；需 DevEco 项目，不能依赖 Previewer | 4.61 起进入 uni-app x 路线，UTS/ArkTS 方向更直接 | ArkUI/ArkTS 原生能力最直接，另建工程 |
| 语言与 UI 复用 | React + TypeScript；小程序复用高，RN/Harmony 页面复用是条件性的 | Vue 3 + UTS，Vapor 模式也支持 JS/TS；官方目标是多端统一 | 领域契约可共享，页面基本不共享 |
| CLI 与 CI | CLI 创建/构建；官方 Test Utils 与 mini-ci 插件 | 官方说明不能用 CLI 创建 uni-app x 项目；HBuilderX 创建后可 CLI 构建，暂不支持 ESLint 插件 | 每个平台各自有成熟工具，但流水线数量最多 |
| 原生扩展 | React Native 原生模块；Harmony C++/ArkTS 插件边界 | UTS 插件可落到 Kotlin、Swift、ArkTS/JS | 无跨框架限制，但重复实现 |
| 主要风险 | RN 版本滞后、Harmony 路线独立、API 徽标不等于行为一致 | 微信路线较新、HBuilderX 锁定、工具自动化和生态迁移成本 | 人员、构建、测试、发布和 UI 同步成本最高 |
| 与本项目匹配 | 最符合“微信首发 + React/TS 契约共享 + 后续逐端复审” | 更适合把 App/Harmony 统一性置于微信首发工具链之前 | 不符合当前阶段“不同时建设四套客户端” |

官方依据：

- Taro 的[起步与微信构建](https://docs.taro.zone/docs/GETTING-STARTED)、[API 支持说明](https://docs.taro.zone/docs/apis/about/desc)、[React Native 路线](https://docs.taro.zone/docs/react-native)、[HarmonyOS 路线](https://docs.taro.zone/en/docs/harmony/)和[小程序 CI 插件](https://docs.taro.zone/docs/plugin-mini-ci/)；
- uni-app x 的[产品说明](https://doc.dcloud.net.cn/uni-app-x/)、[版本记录](https://doc.dcloud.net.cn/uni-app-x/release.html)、[兼容性表](https://doc.dcloud.net.cn/uni-app-x/tutorial/compatibility.html)和[工程化限制](https://doc.dcloud.net.cn/uni-app-x/worktile/)；
- 分端方案按微信原生、React Native、iOS 和 HarmonyOS 各自官方工具链评估。

### 3.2 关键平台能力

| 能力 | Taro | uni-app x | 决策处理 |
| --- | --- | --- | --- |
| 登录 | 统一 API 外形，但微信、App 和 HarmonyOS 的认证提供方、凭据和回调不同 | `uni.login` 等接口按平台实现，仍需逐端账号配置 | 阶段 04 实现 `AuthPort` + Mock 会话；真实微信登录在 06 最小服务端完成后验证 |
| 相机/媒体 | `chooseMedia` 等 API 的平台支持不完全对称 | `chooseImage` 等 API 带平台兼容差异 | P0 不使用；P1 前验证权限、临时文件和隐私声明 |
| 分享 | 小程序分享菜单和 App 系统分享语义不同 | 各端能力同样有条件编译和兼容差异 | 阶段 04 记为 `Deferred — 外部依赖`；正式客户端使用独立 `SharePort` |
| 通知 | 微信订阅消息、App push、本地通知不是同一产品能力 | `uni-push` 覆盖 App/Harmony/小程序但引入云服务和账号配置 | P0 仅应用内提醒；外部通知逐端设计 |
| 本地存储 | 同步/异步 API 可用 | 同步/异步 API 可用 | 本次通过适配层和微信运行时验证 |
| 网络请求 | `Taro.request` 可用，合法域名和 TLS 受目标平台约束 | `uni.request` 可用，约束同样因平台而异 | 阶段 04 通过 `NetworkPort` 验证本机 Mock API；合法域名在 06 验证 |
| 原生扩展 | RN Native Module；Harmony C-API 插件 | UTS 插件 | 只在薄适配层引入，不进入共享领域规则 |

能力依据包括 Taro 的 [`request`](https://docs.taro.zone/docs/apis/network/request/)、[`setStorageSync`](https://docs.taro.zone/docs/apis/storage/setStorageSync)、[`chooseMedia`](https://docs.taro.zone/docs/apis/media/video/chooseMedia) 和 [`showShareMenu`](https://docs.taro.zone/docs/apis/share/showShareMenu)，以及 uni-app x 的 [`request`](https://doc.dcloud.net.cn/uni-app-x/api/request)、[storage](https://doc.dcloud.net.cn/uni-app-x/api/storage.html)、[`chooseImage`](https://doc.dcloud.net.cn/uni-app-x/api/choose-image) 和 [UTS 插件](https://uniapp.dcloud.net.cn/plugin/uts-plugin.html)。

## 4. 最小技术实验

### 4.1 组织方式

实验位于 `apps/meal-agent-client-spike/`，包名和页面均标明 `spike`，不占用预留的正式 `apps/client/`。核心边界为：

```text
Today / Inventory 页面壳
            │
      PlatformAdapter
       │      │       │
 AuthPort StoragePort NetworkPort
  (Mock)             (Mock API)
            │
       Taro Runtime
            │
      微信小程序构建
```

页面没有调用 `wx.*`。Mock 登录经过 `AuthPort` 写入和恢复会话；本地状态经过 `StoragePort`；模拟请求经过 `NetworkPort`。真实微信登录和分享标为 `Deferred — 外部依赖`，相机和外部通知标为 `Not applicable`，没有用空实现伪造成功。

### 4.2 验证结果

| 项目 | 结果 | 证据或限制 |
| --- | --- | --- |
| 固定依赖安装 | `Pass` | `pnpm install --frozen-lockfile` |
| TypeScript 静态检查 | `Pass` | `pnpm typecheck` |
| 适配层自动测试 | `Pass` | 5/5，覆盖存储、Mock API、导航、Mock 登录和四态结果 |
| 微信小程序构建 | `Pass` | `pnpm build:weapp`，Taro 4.2.1 / Webpack 5 |
| 开发者工具模拟器 | `Pass` | 游客模式运行“今天”“库存”页面 |
| 页面导航 | `Pass` | Tab 切换后页面与路由正确 |
| 本地存储 | `Pass` | IDE 中确认写入；非空状态往返由自动测试覆盖 |
| Mock API | `Pass` | 模拟器通过 `NetworkPort` 请求本机 `127.0.0.1:8787` |
| `AuthPort` / Mock 登录 | `Pass` | Mock 会话支持登录、恢复和退出；没有调用 `wx.login` |
| `StoragePort` / `NetworkPort` | `Pass` | 页面只通过语义化端口访问运行时 |
| Agent 上下文位置 | `Pass` | 入口说明位于“今天”业务页，不增加 Agent Tab；未调用模型 |
| 测试号预览目录生成 | `Pass` | `WECHAT_TEST_APP_ID=… pnpm prepare:test-account` 生成被忽略的独立目录 |
| 微信测试号真机预览 | `Deferred — 外部依赖` | 尚无本轮实际测试号、开发者登录、手机扫码运行证据 |
| 真机本地存储与 Mock API | `Deferred — 外部依赖` | 依赖上一项及同网设备；不能从模拟器结果推定 |
| 真实微信登录 | `Deferred — 外部依赖` | 06 最小服务端后验证 `wx.login`、换码和内部会话 |
| 正式合法域名 | `Deferred — 外部依赖` | 06 最小服务端后验证 HTTPS 域名、超时和错误处理 |
| 分享 | `Deferred — 外部依赖` | 待测试号/正式客户端的分享入口和落地参数验证 |
| 体验版上传 | `Deferred — 外部依赖` | 家庭内测前验证 |
| 审核和发布链 | `Deferred — 外部依赖` | 发布候选阶段验证 |
| Android、iOS、HarmonyOS | `Deferred — 外部依赖` | 各平台进入正式开发前单独 spike |
| 相机、语音、条码、OCR | `Not applicable` | 不属于 P0/阶段 04 |
| 外部通知 | `Not applicable` | P0 只做应用内提醒 |
| 依赖一致性 | `Pass` | 精确版本、锁文件、安装脚本白名单；`pnpm peers check` 无问题 |

本轮没有 `Fail` 项。游客模式控制台存在微信开发者工具自身的 `webapi_getwxaasyncsecinfo` / `wx.operateWXData` 账号能力告警，以及因 `touristappid` 和本地 HTTP 产生的开发态提示；未发现项目源代码问题。这些提示不能作为测试号、真实账号或真机通过的证据。

复现命令、IDE 导入步骤和安全限制见[实验 README](../../apps/meal-agent-client-spike/README.md)。

## 5. 结论与剩余风险

选择 Taro 4.2.1 作为首发客户端框架基线，首先交付微信小程序。理由不是其宣称“一套代码覆盖所有平台”，而是微信首发路径、React/TypeScript 工程化、CLI 和测试边界最符合当前约束，并已被本地实验实际支持。

在阶段 04 范围内，未发现会阻止 Taro 完成微信页面、导航、本地存储、Mock 登录或 Mock 网络纵切的已知技术阻断。该结论不等于真实 MVP 登录、生产网络、体验版或发布链已经通过。

`Deferred — 外部依赖` 风险包括：

- 微信测试号真机预览和真机 Mock API；
- 真实微信登录、合法域名和邀请分享；
- 体验版上传、审核和发布；
- Taro 4.2.1 与当前 React Native 生态的差距、Android/iOS 原生模块、性能、签名和商店构建；
- Harmony C-API 插件、DevEco 工程、模拟器/真机、签名和 ArkTS/C++ 边界；
- 离线队列、幂等业务写入、深链和跨端恢复；
- CI 中的微信预览和上传凭据管理。

后续平台顺序为微信小程序 → Android → iOS → HarmonyOS。这是技术验证和工程落地顺序，不代表市场发布优先级。每进入一个原生平台前都必须做独立 spike；如果 RN/Harmony 的维护、性能或 API 差异超过 ADR 的复审阈值，应保留共享契约与领域逻辑，改用分端 UI/运行时。

## 6. 后续验证清单

### 阶段 04 外部条件补证

- [ ] 使用微信测试号生成 `.wechat-test-preview/`；
- [ ] 在开发者工具登录后生成预览二维码；
- [ ] 真机扫码打开“今天”和“库存”，验证导航；
- [ ] 真机写入、关闭重开并读取本地状态；
- [ ] 在可信局域网中调用 Mock API，记录手机系统、微信版本和开发者工具版本；
- [ ] 只有以上实际完成后，才把对应项从 `Deferred — 外部依赖` 改为 `Pass`。

### 阶段 06：最小服务端完成后

- [ ] 验证 `wx.login` code 只在服务端换码，不向客户端暴露 AppSecret；
- [ ] 验证平台身份映射到内部用户 ID，支持会话过期、重试和恢复；
- [ ] 使用已配置的 HTTPS 合法域名验证 `NetworkPort`；
- [ ] 覆盖超时、非 2xx、无权限、会话失效和重复请求；
- [ ] 更新身份体系 ADR 和本报告，保留 Mock 登录作为测试实现。

### 家庭内测前

- [ ] 验证体验版上传、版本说明、成员访问权限和二维码分发；
- [ ] 在至少两台真机上回归登录、导航、存储、网络和邀请落地；
- [ ] 验证体验版环境与测试/生产数据隔离，不提交上传凭据。

### 发布候选阶段

- [ ] 验证隐私声明、用户信息和权限用途与实际行为一致；
- [ ] 完成审核材料、审核提交、驳回处理和重新提交演练；
- [ ] 完成发布、版本回退、监控和紧急停用链路；
- [ ] 审核和发布实际成功后，才把对应项改为 `Pass`。
