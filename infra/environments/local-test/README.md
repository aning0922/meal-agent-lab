# local-test 环境（阶段 09A / M3B）

单机 Docker Compose 的本地/私有测试环境。拓扑与安全边界由
[`infra/docker/compose.local-test.yaml`](../../docker/compose.local-test.yaml)
（M2B Accepted）定义：API 只发布到宿主 `127.0.0.1`，PostgreSQL 不发布任何宿主
端口，凭据一律走未跟踪的 secret file。它是可重复交付与私有测试的载体，
**不是 staging，也不是 production**。

## 配置

[`local-test.env.example`](local-test.env.example) 是唯一的配置模板，只含非敏感
配置与空占位：

| 键 | 含义 |
| --- | --- |
| `COMPOSE_PROJECT_NAME` | Compose project name；并行 worktree 必须互不相同 |
| `MEAL_AGENT_API_HOST_PORT` | API 的宿主端口（地址固定 `127.0.0.1`，不可配置） |
| `MEAL_AGENT_SECRETS_DIR` | Secret 目录；留空回落到 `infra/docker/secrets/` |
| `DEPLOYMENT_STAGE` / `DEPLOYMENT_EXPOSURE` / `WECHAT_ADAPTER` | 固定为 `local-test` / `loopback` / `fake`（声明性；Compose 里已钉死） |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | **必须保持为空**；非空会被 API 启动前校验与 secret 预检双双拒绝 |

使用：

```bash
cp infra/environments/local-test/local-test.env.example \
   infra/environments/local-test/local-test.env
```

`local-test.env` 未被跟踪（见本目录 `.gitignore`），随后把它交给
`docker compose --env-file …`。

## 八份 Secret

生成（只产生四个原始 CSPRNG 口令，派生八个固定文件；口令不进入
stdout/argv/环境变量/Git）：

```bash
node infra/docker/generate-local-test-secrets.mjs
```

部署前预检（任何数据库容器启动之前必须通过）：

```bash
node infra/docker/preflight-local-test-secrets.mjs
```

两条命令都接受 `--directory <绝对路径>` 指向仓库之外的 bundle 目录。文件清单、
角色与固定部署 identity 的唯一事实源是
[`infra/docker/local-test-secrets-contract.mjs`](../../docker/local-test-secrets-contract.mjs)。

## 完整链与验证

从空 volume 开始的完整 bootstrap 链、运行证据、Secret containment 扫描与动态
网络隔离由 M3B smoke 一条命令完成（临时合成 Secret、唯一 project name、失败也
做 scoped cleanup）：

```bash
node infra/docker/run-local-test-smoke.mjs
```

Compose Secret 在容器内的 UID/mode 行为证据（宿主 stat 不作数）：

```bash
node infra/docker/probe-compose-secret-identity.mjs
```

## 边界

- fake 微信 adapter + 合成身份；不调用任何真实微信服务；
- 只有宿主 IPv4 loopback 一个入口；不开公网、不加域名/TLS/反向代理；
- 备份与恢复命令属于 M4，本环境当前不声明；
- staging 与 production 环境不存在，本目录的任何内容不得如此表述。
