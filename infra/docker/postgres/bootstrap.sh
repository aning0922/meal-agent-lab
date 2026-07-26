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
#   1. admin      bootstrap.sh cluster
#   2. admin      bootstrap.sh logins
#   3. admin      createdb meal_agent
#   4. admin      pnpm --filter @meal-agent/api db:bootstrap     （应用冻结的 0000）
#   5. admin      bootstrap.sh handoff --dbname meal_agent
#   6. admin      bootstrap.sh acl     --dbname meal_agent
#   7. migration  pnpm --filter @meal-agent/api db:migrate       （SET ROLE migrator）
#   8. admin      bootstrap.sh grants  --dbname meal_agent
#   9. runtime    readiness
#
# 恢复顺序（M4 实现，本轮只登记约束）：cluster → createdb --owner=meal_agent_migrator
#   → pg_restore → acl → grants。恢复路径**不**运行 0000，也**不**运行 handoff。
#
# 连接参数走标准 PG* 环境变量。`logins` 阶段需要三个非空密码环境变量，
# 它们只经环境与 stdin 传递，并由 psql 的 \password 在客户端生成 SCRAM verifier：
#   MEAL_AGENT_MIGRATION_PASSWORD
#   MEAL_AGENT_RUNTIME_PASSWORD
#   MEAL_AGENT_BACKUP_PASSWORD

set -euo pipefail

phase="${1:-}"
shift || true

dbname=""
maintenance_db="${PGDATABASE:-postgres}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dbname)
      dbname="${2:-}"
      shift 2
      ;;
    --maintenance-db)
      maintenance_db="${2:-}"
      shift 2
      ;;
    *)
      echo "bootstrap: unexpected argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$phase" in
  cluster|logins|handoff|acl|grants) ;;
  *)
    echo "bootstrap: usage: bootstrap.sh {cluster|logins|handoff|acl|grants}" >&2
    echo "bootstrap:   cluster|logins  [--maintenance-db <db>]" >&2
    echo "bootstrap:   handoff|acl|grants --dbname <db>" >&2
    exit 2
    ;;
esac

script_directory="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
sql_directory="${script_directory}/sql"
psql_binary="${PSQL:-psql}"

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

require_password() {
  # 只检查是否为空，绝不打印取值。
  if [ -z "${!1:-}" ]; then
    echo "bootstrap: environment variable $1 must be set and non-empty" >&2
    exit 2
  fi
}

case "$phase" in
  cluster)
    run_sql "${sql_directory}/cluster/00-preflight.sql"
    run_sql "${sql_directory}/cluster/01-roles.sql"
    ;;

  logins)
    require_password MEAL_AGENT_MIGRATION_PASSWORD
    require_password MEAL_AGENT_RUNTIME_PASSWORD
    require_password MEAL_AGENT_BACKUP_PASSWORD
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

    previous_options="$-"
    set +x
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
    # 用完立即清除进程环境中的口令，并恢复原来的 xtrace 设置。
    unset MEAL_AGENT_MIGRATION_PASSWORD
    unset MEAL_AGENT_RUNTIME_PASSWORD
    unset MEAL_AGENT_BACKUP_PASSWORD
    case "$previous_options" in *x*) set -x ;; esac

    # 强制后置校验：\password 在口令为空时会让服务端**清空**口令并且仍然退出 0。
    run_sql "${sql_directory}/cluster/03-login-verify.sql"
    ;;

  handoff)
    run_sql "${sql_directory}/database/00-preflight.sql"
    run_sql "${sql_directory}/database/01-owner-handoff.sql"
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
