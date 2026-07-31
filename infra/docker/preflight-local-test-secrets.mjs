#!/usr/bin/env node
// 阶段 09A / M3B：八份 local-test Secret 的部署前交叉一致性预检。
//
//   node infra/docker/preflight-local-test-secrets.mjs [--directory <绝对路径>]
//
// 它在**任何数据库 mutation 之前**运行（smoke 在启动任何数据库容器之前调用同
// 一段实现）。任何一条不满足都 fail closed：
//
//   - 文件缺失 / 未知条目 / symlink / hard link / 非普通文件；
//   - 弱权限（非 owner-only 0400/0600）、属主不等于预检进程 EUID、目录非 0700；
//   - 空文件、>4096 字节、多行、CR、NUL、BOM、非法 UTF-8；
//   - 四个原始口令必须是 [A-Za-z0-9] 且互不相同（URL/pgpass 双安全字母表）；
//   - 三条 URL 的 user/host/port/database 必须精确等于固定部署 identity，
//     不允许 query、fragment、userinfo 绕过或 unix socket，且口令必须与对应
//     口令文件逐字节一致（最后还有一道 canonical 全等兜底）；
//   - pgpass 恰好两个精确 endpoint（maintenance 库与目标库），不允许通配，
//     口令必须与 superuser 口令文件一致；
//   - Secret 文件被 Git 跟踪、或 tracked 模板出现非空敏感值/完整 DSN。
//
// 全部失败理由只含文件名、字段名与原因，**从不**包含 Secret 内容。
import { fileURLToPath } from 'node:url'

import {
  checkSecretBundle,
  defaultSecretsDirectory
} from './local-test-secrets-contract.mjs'

const usage = () => {
  process.stderr.write(
    'usage: preflight-local-test-secrets.mjs [--directory <absolute path>]\n' +
      `       (default: ${defaultSecretsDirectory})\n`
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  let directory = defaultSecretsDirectory
  if (args.length === 2 && args[0] === '--directory') {
    directory = args[1]
  } else if (args.length !== 0) {
    usage()
    process.exit(2)
  }

  const { problems } = checkSecretBundle(directory)
  if (problems.length > 0) {
    process.stderr.write('local-test secret preflight FAIL\n')
    for (const problem of problems) {
      process.stderr.write(`  - ${problem}\n`)
    }
    process.exit(1)
  }
  process.stdout.write(
    `local-test secret preflight PASS (${directory}: 8 files, ` +
      'cross-consistency, ownership and tracked-template scan)\n'
  )
}
