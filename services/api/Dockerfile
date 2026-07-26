# 阶段 09A / M1：@meal-agent/api 容器构建基线。
#
# 构建上下文必须是 monorepo 根目录：
#
#   docker build \
#     --file services/api/Dockerfile \
#     --tag meal-agent-api:stage09a-m1 \
#     .
#
# 本文件只负责镜像构建。Compose、数据库角色、Secret 注入、备份恢复和门禁脚本
# 属于阶段 09A 的 M2—M5，不在这里实现。

# 基础镜像固定为 Docker Official Image `docker.io/library/node`：
# Node.js 24.14.0 + Debian bookworm-slim，同时写出 exact patch tag 与不可变
# manifest digest。digest 由本机 `docker buildx imagetools inspect` 查得，
# 覆盖 linux/amd64、linux/arm64/v8、linux/ppc64le 和 linux/s390x。
# 不使用 latest、lts、node:24 等浮动标签；也不提供 ARG，避免外部参数覆盖基线。
FROM docker.io/library/node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS node-base

# --------------------------------------------------------------------------
# 1. 固定 Node/pnpm 工具链
# --------------------------------------------------------------------------
FROM node-base AS toolchain

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /workspace

# 先只复制根 manifests：pnpm 版本与依赖图未变时，后续构建可复用该层。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# pnpm 版本由根 package.json 的 `packageManager` 字段固定为 11.9.0，
# 由 Node 自带 corepack 激活；不使用 `curl | sh`，也不安装未固定版本的 pnpm。
RUN corepack enable pnpm \
 && pnpm --version

# --------------------------------------------------------------------------
# 2. 依赖安装
# --------------------------------------------------------------------------
FROM toolchain AS dependencies

# 只复制 API 与其 workspace 依赖 contracts 的 manifest；apps/client 不参与
# 服务端镜像，也不进入构建上下文（见根 `.dockerignore`）。
COPY packages/contracts/package.json ./packages/contracts/
COPY services/api/package.json ./services/api/

# frozen lockfile 强制使用仓库锁定的依赖图；`@meal-agent/api...` 只选中 API
# 及其依赖闭包，不安装客户端 workspace。构建期需要 devDependencies（TypeScript）。
RUN pnpm install --frozen-lockfile --filter "@meal-agent/api..."

# --------------------------------------------------------------------------
# 3. TypeScript 构建
# --------------------------------------------------------------------------
FROM dependencies AS build

# services/api/tsconfig.json extends packages/contracts/tsconfig.json，
# 因此两个包的 tsconfig 都必须存在。
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.build.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY services/api/tsconfig.json services/api/tsconfig.build.json ./services/api/
COPY services/api/src ./services/api/src

# 顺序固定：API 依赖 contracts 的 dist 与声明文件，必须先构建 contracts。
RUN pnpm --filter @meal-agent/contracts build \
 && pnpm --filter @meal-agent/api build

# --------------------------------------------------------------------------
# 4. production dependency closure
# --------------------------------------------------------------------------
FROM build AS runtime-closure

# 仓库未开启 `injectWorkspacePackages`，因此使用 legacy deploy 生成运行期闭包。
# 该命令只读取 lockfile，不写回 lockfile，也不修改 workspace 配置；
# 输出中的 @meal-agent/contracts 只包含其 `files` 声明的 dist 与 package.json。
RUN pnpm --filter @meal-agent/api deploy --prod --legacy /opt/meal-agent-api-runtime

# --------------------------------------------------------------------------
# 5. runtime
# --------------------------------------------------------------------------
# 从同一固定 digest 重新开始，因此不携带 pnpm、corepack 缓存、TypeScript
# 编译器、devDependencies 或任何 TypeScript 源码。
FROM node-base AS runtime

# 固定数字 UID/GID，避免依赖基础镜像自带的 node(1000) 用户。
RUN groupadd --gid 10001 meal-agent \
 && useradd --uid 10001 --gid 10001 \
      --home-dir /app --no-create-home \
      --shell /usr/sbin/nologin meal-agent

# 移除基础镜像自带的包管理器：runtime 只需要 `node`。
# corepack 会读取 /app/package.json 的 `packageManager` 字段并在运行期下载
# pnpm，因此它等价于把 pnpm 留在最终镜像里；npm/npx/yarn 同样能在运行期拉取
# 代码。这里不安装任何新包，只删除未使用的上游组件。
RUN rm -rf \
      /usr/local/bin/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
      /usr/local/lib/node_modules/corepack \
      /usr/local/lib/node_modules/npm \
      /opt/yarn-v1.22.22

WORKDIR /app

# 运行期负载显式归 root 所有：进程以 10001:10001 运行，只读不写自身代码。
# 只复制运行必需内容，不整体复制 deploy 输出目录（其中还有 src 与 tsconfig）。
COPY --from=runtime-closure --chown=0:0 /opt/meal-agent-api-runtime/node_modules ./node_modules
COPY --from=runtime-closure --chown=0:0 /opt/meal-agent-api-runtime/package.json ./package.json
COPY --from=build --chown=0:0 /workspace/services/api/dist ./dist
COPY --chown=0:0 services/api/migrations/*.sql ./migrations/

# 非敏感的 production 默认值。配置语义仍由 services/api/src/config.ts 决定：
# 此处不写入 DATABASE_URL、微信 AppID/AppSecret、token 或任何 Secret。
# NODE_ENV=production 时 config 拒绝 fake 微信 adapter，属于 fail closed 方向；
# local-test 拓扑需要显式覆盖 NODE_ENV 与 WECHAT_ADAPTER。
ENV NODE_ENV=production

# 刻意不声明 EXPOSE：监听地址与 host 发布边界属于 M2/M3 的 Compose 决策，
# 镜像不应暗示可被 `docker run -P` 发布。config.ts 的 HOST 默认值仍为 127.0.0.1。

USER 10001:10001

# 清空基础镜像继承的 `docker-entrypoint.sh`：启动命令必须只由下面的 CMD 决定，
# 不依赖上游包装脚本，`docker image inspect` 也因此没有歧义。
ENTRYPOINT []

# exec form：node 直接作为 PID 1 接收 SIGTERM，交给 src/index.ts 的优雅关闭。
# `dist/database/migrate.js` 通过 `../../migrations/` 解析到 /app/migrations。
CMD ["node", "/app/dist/index.js"]
