# 首发客户端跨端技术验证

- 验证日期：2026-07-23
- 结论状态：已完成微信小程序最小实验；Android、iOS、HarmonyOS 为条件性路线，尚未实机验证
- 正式决策：[ADR-0001](decisions/0001-client-platform-and-cross-platform-framework.md)
- 实验代码：[`apps/meal-agent-client-spike/`](../../apps/meal-agent-client-spike/)

## 1. 范围与判定标准

本次只回答“微信小程序优先时，哪条客户端路线最适合进入正式工程准备”，不实现家庭、库存、推荐、Agent 对话、语音、条码或 OCR。Agent 只作为业务页面中的上下文能力保留边界。

推荐方案必须：

1. 能以固定依赖构建微信小程序并在微信开发者工具中运行；
2. 能验证页面导航、本地状态、模拟网络请求和平台适配端口；
3. 不把 Android、iOS、HarmonyOS 的文档声明误写为实机验证；
4. 能把共享领域逻辑与平台 API、页面渲染和原生工程分开；
5. 具备可脚本化的构建、静态检查和测试入口。

## 2. 环境审计

### 2.1 审计结果

| 项目 | 审计时状态 | 本次处理 | 结论 |
| --- | --- | --- | --- |
| macOS | 26.5.2，Apple Silicon | 无 | 可进行小程序构建和预览 |
| Git | Apple Git 2.50.1 | 无 | 满足验证 |
| Node.js | 普通 shell 未配置；Codex 工作区运行时提供 24.14.0 | 固定 `.node-version` 和 engine 范围 | 正式开发机需安装 22.13.0–24.x |
| pnpm | Codex 工作区运行时提供 11.9.0 | 固定 `packageManager` 和锁文件 | 满足验证 |
| 微信开发者工具 | 未安装 | 通过 Homebrew 安装 | Stable 2.01.2510290 完成人工预览 |
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
| 微信开发者工具 | 现在：编译结果预览、调试、真机和上传 | 本地构建可无账号；真实登录、上传、订阅消息和真机需要可用的微信账号/AppID 及后台配置 |
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
| 登录 | 统一 API 外形，但微信、App 和 HarmonyOS 的认证提供方、凭据和回调不同 | `uni.login` 等接口按平台实现，仍需逐端账号配置 | 只定义 `AuthPort`；真实微信登录列入服务端身份 ADR 前置验证 |
| 相机/媒体 | `chooseMedia` 等 API 的平台支持不完全对称 | `chooseImage` 等 API 带平台兼容差异 | P0 不使用；P1 前验证权限、临时文件和隐私声明 |
| 分享 | 小程序分享菜单和 App 系统分享语义不同 | 各端能力同样有条件编译和兼容差异 | 独立 `SharePort`，不让页面依赖小程序事件形态 |
| 通知 | 微信订阅消息、App push、本地通知不是同一产品能力 | `uni-push` 覆盖 App/Harmony/小程序但引入云服务和账号配置 | P0 仅应用内提醒；外部通知逐端设计 |
| 本地存储 | 同步/异步 API 可用 | 同步/异步 API 可用 | 本次通过适配层和微信运行时验证 |
| 网络请求 | `Taro.request` 可用，合法域名和 TLS 受目标平台约束 | `uni.request` 可用，约束同样因平台而异 | 本次仅验证本机 mock；生产域名未验证 |
| 原生扩展 | RN Native Module；Harmony C-API 插件 | UTS 插件 | 只在薄适配层引入，不进入共享领域规则 |

能力依据包括 Taro 的 [`request`](https://docs.taro.zone/docs/apis/network/request/)、[`setStorageSync`](https://docs.taro.zone/docs/apis/storage/setStorageSync)、[`chooseMedia`](https://docs.taro.zone/docs/apis/media/video/chooseMedia) 和 [`showShareMenu`](https://docs.taro.zone/docs/apis/share/showShareMenu)，以及 uni-app x 的 [`request`](https://doc.dcloud.net.cn/uni-app-x/api/request)、[storage](https://doc.dcloud.net.cn/uni-app-x/api/storage.html)、[`chooseImage`](https://doc.dcloud.net.cn/uni-app-x/api/choose-image) 和 [UTS 插件](https://uniapp.dcloud.net.cn/plugin/uts-plugin.html)。

## 4. 最小技术实验

### 4.1 组织方式

实验位于 `apps/meal-agent-client-spike/`，包名和页面均标明 `spike`，不占用预留的正式 `apps/client/`。核心边界为：

```text
Today / Inventory 页面壳
            │
      PlatformAdapter
       │    │     │
  Storage Request Navigation
            │
       Taro Runtime
            │
      微信小程序构建
```

页面没有调用 `wx.*`。登录、相机、分享、通知当前只在能力表中标为 `boundary-only`，没有用空实现伪造成功。

### 4.2 验证结果

| 项目 | 结果 | 证据或限制 |
| --- | --- | --- |
| TypeScript 静态检查 | 通过 | `pnpm typecheck` |
| 适配层自动测试 | 4/4 通过 | 覆盖非空状态往返、mock URL/契约、双向路由和能力分级 |
| 微信小程序构建 | 通过 | `pnpm build:weapp`，Taro 4.2.1 / Webpack 5 |
| “今天”页面 | 通过 | 微信开发者工具游客模式人工检查 |
| “库存”页面和导航 | 通过 | Tab 切换后页面与路由均正确 |
| 本地状态 | 通过，有限 | IDE 中确认写入时间；非空值保存与重载由自动测试确认 |
| 模拟 API | 通过 | 本机 `127.0.0.1:8787` 返回并在页面显示成功 |
| Agent 上下文位置 | 通过结构检查 | 入口说明位于“今天”业务页，不增加 Agent Tab；未调用模型 |
| CLI 打开 IDE | 阻塞但非构建阻塞 | 微信开发者工具服务端口默认关闭；手工导入成功，未为自动化放宽本机安全设置 |
| 依赖一致性 | 通过 | 精确版本、锁文件、安装脚本白名单；`pnpm peers check` 无问题 |

游客模式控制台存在微信开发者工具自身的 `webapi_getwxaasyncsecinfo` / `wx.operateWXData` 账号能力告警，以及因 `touristappid` 和本地 HTTP 产生的开发态提示；未发现项目源代码问题。它们不能作为真实账号或真机通过的证据。

复现命令、IDE 导入步骤和安全限制见[实验 README](../../apps/meal-agent-client-spike/README.md)。

## 5. 结论与剩余风险

选择 Taro 4.2.1 作为首发客户端框架基线，首先交付微信小程序。理由不是其宣称“一套代码覆盖所有平台”，而是微信首发路径、React/TypeScript 工程化、CLI 和测试边界最符合当前约束，并已被本地实验实际支持。

尚未验证：

- 真实微信 AppID 的登录、合法域名、邀请分享、订阅消息、上传、真机和发布；
- Taro 4.2.1 与当前 React Native 生态的差距、Android/iOS 原生模块、性能、签名和商店构建；
- Harmony C-API 插件、DevEco 工程、模拟器/真机、签名和 ArkTS/C++ 边界；
- 离线队列、幂等业务写入、深链和跨端恢复；
- camera/share/notification API 的逐端语义；
- CI 中的微信预览和上传凭据管理。

后续平台顺序为微信小程序 → Android → iOS → HarmonyOS。这是技术验证和工程落地顺序，不代表市场发布优先级。每进入一个原生平台前都必须做独立 spike；如果 RN/Harmony 的维护、性能或 API 差异超过 ADR 的复审阈值，应保留共享契约与领域逻辑，改用分端 UI/运行时。
