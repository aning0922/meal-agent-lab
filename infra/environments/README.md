# 环境配置（阶段 09A / M3B）

本目录存放各环境的**非敏感**配置模板与部署声明。当前只有一个环境：

- [`local-test/`](local-test/)：单机 Docker Compose 的本地/私有测试环境。
  它是可重复交付与私有测试的载体，**不是 staging，也不是 production**；没有
  真实微信配置时，禁止把它改名或表述为 staging/production
  （[ADR-0005](../../docs/architecture/decisions/0005-local-private-deployment-baseline.md) §1、§3）。

约束：八份真实 Secret 的生成、权限与交叉一致性由
[`../docker/preflight-local-test-secrets.mjs`](../docker/preflight-local-test-secrets.mjs)
和运行期 containment fail closed；tracked 模板扫描器只是尽力而为的第二层网，
已登记的未闭合族见阶段计划，不能把它表述为完整文法证明。

- 模板只允许非敏感配置或**空占位**；
- 任何 password、token、AppID、AppSecret、DSN 类键都不得携带非空值；
- 任何完整连接串都不得出现在 tracked 模板里；
- 口令与连接串一律走未跟踪的 secret file（见
  [`../docker/secrets/README.md`](../docker/secrets/README.md)）。

staging 与 production 环境**不存在**：它们需要真实微信配置、域名、TLS 与云
资源，全部属于后续阶段的显式决策。
