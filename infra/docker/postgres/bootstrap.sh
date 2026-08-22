#!/usr/bin/env bash
#
# 阶段 09A / M2A：PostgreSQL 18 bootstrap orchestrator。
#
# 以 cluster admin 身份建立数据库身份边界。它只做角色、口令与归属/权限，
# 不执行业务 migration，也不写 migration ledger。
#
# 分成两个**作用域**：
#
#   cluster scope —— 连接明确的 maintenance/control 数据库（默认 postgres），
#     只创建并规范化六个 cluster role、role config、membership 与口令。
#     不要求目标 meal_agent 数据库存在，也不修改任何目标数据库 ACL。
#     因此它可以在 createdb 之前运行，M4 的恢复流程将复用它：
#       cluster → createdb --owner=meal_agent_migrator → pg_restore → database
#
#   database scope —— 只在目标 meal_agent* 数据库存在后运行，处理数据库 ACL、
#     schema ACL、owner 交接和对象权限。
#
# 用法：
#   bootstrap.sh cluster  [--maintenance-db postgres]   # 角色 + membership
#   bootstrap.sh logins   [--maintenance-db postgres]   # SCRAM 口令
#   bootstrap.sh handoff  --dbname <db>                 # 仅全新安装：owner 交接
#   bootstrap.sh acl      --dbname <db>                 # ACL 基线（全新安装与恢复后均可复用）
#   bootstrap.sh grants   --dbname <db>                 # migration 之后的备份补授
#
# 全新安装顺序：
#   1. admin      bootstrap.sh cluster                            角色 + membership
#   2. admin      bootstrap.sh logins                             SCRAM 口令
#   3. admin      createdb meal_agent
#   4. admin      pnpm --filter @meal-agent/api db:bootstrap      原子应用冻结的 0000
#   5. admin      bootstrap.sh handoff --dbname meal_agent        owner 交接（0000-only）
#   6. admin      bootstrap.sh acl     --dbname meal_agent        ACL 基线
#   7. migration  pnpm --filter @meal-agent/api db:migrate        SET ROLE 应用 0001—最新
#   8. admin      bootstrap.sh grants  --dbname meal_agent        备份只读基线
#   9. runtime    readiness
#
# 恢复顺序（M4 实现，本轮只登记契约）：
#   1. admin      bootstrap.sh cluster
#   2. admin      bootstrap.sh logins
#   3. admin      createdb --owner=meal_agent_migrator meal_agent
#   4. operator   pg_restore
#   5. admin      bootstrap.sh acl     --dbname meal_agent
#   6. migration  pnpm db:migrate                                 备份之后新增的 migration
#   7. admin      bootstrap.sh grants  --dbname meal_agent
#   8. 验证       readiness / owner / GRANT / RLS / checksum
# 恢复路径**不**运行 0000，也**不**运行 handoff。
#
# 连接参数走标准 PG* 环境变量。`logins` 阶段需要三个口令，每个都由一对**互斥**
# 的来源提供（阶段 09A / M3A，判据见 secret-source.sh）：
#   MEAL_AGENT_MIGRATION_PASSWORD / MEAL_AGENT_MIGRATION_PASSWORD_FILE
#   MEAL_AGENT_RUNTIME_PASSWORD   / MEAL_AGENT_RUNTIME_PASSWORD_FILE
#   MEAL_AGENT_BACKUP_PASSWORD    / MEAL_AGENT_BACKUP_PASSWORD_FILE
#
# Compose 只提供 `*_FILE`；直接的环境变量形式保留给非 Compose 的本地测试。
# 三份口令**全部**在任何 psql 调用之前解析完毕：任意一份不合格就 exit 2，
# 因此该阶段的 psql 调用次数恒为 0。取值只经 stdin 传给 psql 的 \password，
# 由它在客户端生成 SCRAM verifier，绝不进入 argv、SQL 文本或日志。

set -euo pipefail

phase="${1:-}"
shift || true

case "$phase" in
  cluster|logins|handoff|acl|grants) ;;
  *)
    echo "bootstrap: usage: bootstrap.sh {cluster|logins|handoff|acl|grants}" >&2
    echo "bootstrap:   cluster|logins  [--maintenance-db <db>]" >&2
    echo "bootstrap:   handoff|acl|grants --dbname <db>" >&2
    exit 2
    ;;
esac

# 每个 phase 只接受它自己的 option：不相关的 option、重复 option、缺 value 和
# 多余位置参数一律拒绝，不静默忽略，也不「最后一个覆盖」。
case "$phase" in
  cluster|logins) allowed_option="--maintenance-db" ;;
  *)              allowed_option="--dbname" ;;
esac

option_value=""
option_seen="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --maintenance-db|--dbname)
      if [ "$1" != "$allowed_option" ]; then
        echo "bootstrap: $phase does not accept $1 (use $allowed_option)" >&2
        exit 2
      fi
      if [ "$option_seen" = "yes" ]; then
        echo "bootstrap: $1 given more than once" >&2
        exit 2
      fi
      if [ $# -lt 2 ]; then
        echo "bootstrap: $1 requires a value" >&2
        exit 2
      fi
      option_value="$2"
      option_seen="yes"
      shift 2
      ;;
    -*)
      echo "bootstrap: unknown option: $1" >&2
      exit 2
      ;;
    *)
      echo "bootstrap: unexpected argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$phase" in
  cluster|logins)
    if [ "$option_seen" = "yes" ]; then
      maintenance_db="$option_value"
    else
      maintenance_db="${PGDATABASE:-postgres}"
    fi
    dbname=""
    ;;
  *)
    if [ "$option_seen" != "yes" ]; then
      echo "bootstrap: $phase requires --dbname <db>" >&2
      exit 2
    fi
    dbname="$option_value"
    maintenance_db=""
    ;;
esac

script_directory="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
sql_directory="${script_directory}/sql"
psql_binary="${PSQL:-psql}"

# Secret 来源解析器（`<NAME>` 与 `<NAME>_FILE` 互斥）。缺失即失败，不降级。
if [ ! -f "${script_directory}/secret-source.sh" ]; then
  echo "bootstrap: cannot find secret-source.sh next to bootstrap.sh" >&2
  exit 2
fi
# shellcheck source=./secret-source.sh
. "${script_directory}/secret-source.sh"

# cluster scope 连 maintenance DB；database scope 连目标库。
case "$phase" in
  cluster|logins)
    target_db="$maintenance_db"
    if [ -z "$target_db" ]; then
      echo "bootstrap: --maintenance-db must not be empty" >&2
      exit 2
    fi
    # maintenance DB 只需是一个普通标识符；它不是项目库。
    if ! printf '%s' "$target_db" | grep -Eq '^[a-z_][a-z0-9_]*$'; then
      echo "bootstrap: --maintenance-db must be a plain identifier" >&2
      exit 2
    fi
    ;;
  *)
    target_db="$dbname"
    # --dbname 只接受严格的项目数据库标识符：拒绝 URI、conninfo key=value、
    # 引号、空格、大写和任何 psql 会当作连接串解释的形式。
    if ! printf '%s' "$target_db" | grep -Eq '^meal_agent(_[a-z0-9_]+)?$'; then
      echo "bootstrap: --dbname must be 'meal_agent' or 'meal_agent_<suffix>'" >&2
      echo "bootstrap: URIs, conninfo strings and quoted identifiers are rejected" >&2
      exit 2
    fi
    ;;
esac
if [ "${#target_db}" -gt 63 ]; then
  echo "bootstrap: database name exceeds the identifier length limit" >&2
  exit 2
fi

run_sql() {
  # --no-psqlrc 忽略 ~/.psqlrc；-w 拒绝任何交互式口令提示，缺少 admin 凭据时
  # 立即失败而不是挂起等待输入；expected_db 让 SQL 侧再核对 current_database()。
  "$psql_binary" \
    --no-psqlrc \
    --quiet \
    --no-password \
    --set ON_ERROR_STOP=on \
    --set expected_db="$target_db" \
    --dbname "$target_db" \
    --file "$1"
}

case "$phase" in
  cluster)
    run_sql "${sql_directory}/cluster/00-preflight.sql"
    run_sql "${sql_directory}/cluster/01-roles.sql"
    ;;

  logins)
    # xtrace 必须在**第一次间接展开 Secret 之前**关闭：解析器用 ${!name} 读取
    # 口令变量，开着 set -x 时会把取值打进 stderr。
    previous_options="$-"
    set +x
    # 三份口令全部在任何 psql 调用之前解析：任一来源缺失、冲突、文件权限不对
    # 或内容不合法都会在这里 exit 2，此时 psql 调用次数为 0。
    meal_agent_resolve_secret MEAL_AGENT_MIGRATION_PASSWORD
    meal_agent_resolve_secret MEAL_AGENT_RUNTIME_PASSWORD
    meal_agent_resolve_secret MEAL_AGENT_BACKUP_PASSWORD
    run_sql "${sql_directory}/cluster/00-preflight.sql"
    run_sql "${sql_directory}/cluster/02-login-preflight.sql"

    # psql 的 \password 在客户端生成 SCRAM-SHA-256 verifier，只把 verifier 放进
    # ALTER USER；原始口令不进入 SQL 文本、命令行、仓库或服务端日志。
    #
    # 但它的提示走 simple_prompt()，**先尝试打开 /dev/tty**，只有失败才回落到
    # stdin。因此在有控制终端的终端里直接用管道喂口令会永久阻塞且没有任何错误。
    # 这里统一在「无控制终端」的会话里执行：优先用 util-linux 的 setsid，
    # 否则用仓库内的 no-ctty.mjs（Node 标准库，spawn detached 即 setsid(2)）。
    # bash 3.2（macOS 自带）在 `set -u` 下展开空数组会报 unbound variable，
    # 因此用一个标量策略变量而不是数组。
    detach_mode="none"
    if ( exec 3< /dev/tty ) 2> /dev/null; then
      if command -v setsid > /dev/null 2>&1; then
        detach_mode="setsid"
      elif command -v node > /dev/null 2>&1; then
        detach_mode="node"
      else
        echo "bootstrap: a controlling terminal is present, but neither" >&2
        echo "bootstrap: 'setsid' nor 'node' is available to detach from it." >&2
        echo "bootstrap: psql's \\password would block on /dev/tty instead of" >&2
        echo "bootstrap: reading stdin. Run this phase without a controlling" >&2
        echo "bootstrap: terminal (container/CI), or install one of them." >&2
        exit 2
      fi
    fi

    # 展开 Secret 之前关闭 xtrace，避免口令进入 stderr 的调试输出。
    set_password() {
      # $1 = 角色名；口令从 stdin 读入，绝不进入命令行或 SQL 文本。
      case "$detach_mode" in
        setsid)
          setsid "$psql_binary" --no-psqlrc --quiet --no-password \
            --set ON_ERROR_STOP=on --dbname "$target_db" \
            --command "SET password_encryption = 'scram-sha-256';" \
            --command "\\password \"$1\""
          ;;
        node)
          node "${script_directory}/no-ctty.mjs" \
            "$psql_binary" --no-psqlrc --quiet --no-password \
            --set ON_ERROR_STOP=on --dbname "$target_db" \
            --command "SET password_encryption = 'scram-sha-256';" \
            --command "\\password \"$1\""
          ;;
        *)
          "$psql_binary" --no-psqlrc --quiet --no-password \
            --set ON_ERROR_STOP=on --dbname "$target_db" \
            --command "SET password_encryption = 'scram-sha-256';" \
            --command "\\password \"$1\""
          ;;
      esac
    }

    for entry in \
      "meal_agent_migration_login:MEAL_AGENT_MIGRATION_PASSWORD" \
      "meal_agent_runtime_login:MEAL_AGENT_RUNTIME_PASSWORD" \
      "meal_agent_backup_login:MEAL_AGENT_BACKUP_PASSWORD"
    do
      role_name="${entry%%:*}"
      password_variable="${entry##*:}"
      printf '%s\n%s\n' "${!password_variable}" "${!password_variable}" \
        | set_password "$role_name"
    done
    # 用完立即清除口令与它们的来源变量，并恢复原来的 xtrace 设置。
    # 解析器已经 unset 过 `*_FILE`，这里再写一遍是为了让「用完即清」在阅读
    # bootstrap.sh 时是自证的，而不必回到 secret-source.sh 才能确认。
    unset MEAL_AGENT_MIGRATION_PASSWORD
    unset MEAL_AGENT_RUNTIME_PASSWORD
    unset MEAL_AGENT_BACKUP_PASSWORD
    unset MEAL_AGENT_MIGRATION_PASSWORD_FILE || true
    unset MEAL_AGENT_RUNTIME_PASSWORD_FILE || true
    unset MEAL_AGENT_BACKUP_PASSWORD_FILE || true
    case "$previous_options" in *x*) set -x ;; esac

    # 强制后置校验：\password 在口令为空时会让服务端**清空**口令并且仍然退出 0。
    run_sql "${sql_directory}/cluster/03-login-verify.sql"
    ;;

  handoff)
    # handoff 只接受 checksum 正确的 0000，因此需要磁盘上 0000 的实际 sha256。
    stage06_file="${script_directory}/../../../services/api/migrations/0000_stage_06.sql"
    if [ ! -f "$stage06_file" ]; then
      echo "bootstrap: cannot find 0000_stage_06.sql at $stage06_file" >&2
      exit 2
    fi
    if command -v sha256sum > /dev/null 2>&1; then
      stage06_hash="$(sha256sum "$stage06_file" | cut -d' ' -f1)"
    elif command -v shasum > /dev/null 2>&1; then
      stage06_hash="$(shasum -a 256 "$stage06_file" | cut -d' ' -f1)"
    else
      echo "bootstrap: neither sha256sum nor shasum is available" >&2
      exit 2
    fi
    run_sql "${sql_directory}/database/00-preflight.sql"
    "$psql_binary" \
      --no-psqlrc --quiet --no-password \
      --set ON_ERROR_STOP=on \
      --set expected_db="$target_db" \
      --set stage06_hash="$stage06_hash" \
      --dbname "$target_db" \
      --file "${sql_directory}/database/01-owner-handoff.sql"
    ;;

  acl)
    run_sql "${sql_directory}/database/00-preflight.sql"
    run_sql "${sql_directory}/database/02-acl-baseline.sql"
    ;;

  grants)
    run_sql "${sql_directory}/database/00-preflight.sql"
    run_sql "${sql_directory}/database/03-backup-grants.sql"
    ;;
esac
