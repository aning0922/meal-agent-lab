# local-test 备份目录（阶段 09A / M4）

`node infra/docker/backup-local-test.mjs` 的默认输出目录。内容是
`pg_dump --format=custom` 的 `*.dump` 与同名 `*.dump.sha256` sidecar，全部被
本目录的 `.gitignore` 排除——备份可能包含真实家庭数据，绝不进入 Git。

恢复入口在调用 `pg_restore` 之前必须先通过 sidecar 校验；流程与顺序见
[runbook](../../../docs/operations/stage-09a-local-test-lifecycle.md)。
