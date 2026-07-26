#!/usr/bin/env bash
#
# 阶段 09A / M2A：PostgreSQL 18 bootstrap orchestrator。
#
# 以 cluster admin 身份建立数据库身份边界。它只做角色与归属，不执行业务
# migration，也不写 migration ledger。
#
# 用法：
#   bootstrap.sh roles    --dbname <db>   # 角色基线（可在冻结 0000 之前执行）
#   bootstrap.sh logins   --dbname <db>   # 为三个 login 设置口令
#   bootstrap.sh handoff  --dbname <db>   # 0000 之后、0001 之前
#   bootstrap.sh grants   --dbname <db>   # 0001—最新 migration 之后
#
# 完整的执行顺序（M2A 验证的路径）：
#   1. admin      createdb
#   2. admin      bootstrap.sh roles          （六个项目角色的属性与 membership 基线）
#   3. admin      bootstrap.sh logins         （SCRAM 口令）
#   4. admin      db:migrate -- --bootstrap-0000
#   5. admin      bootstrap.sh handoff        （owner 交接 + 数据库级 ACL）
#   6. migration  db:migrate                  （显式 SET ROLE meal_agent_migrator）
#   7. admin      bootstrap.sh grants         （备份角色只读补授）
#   8. runtime    readiness                   （事务内 SET LOCAL ROLE meal_agent_app）
#
# `roles` 阶段刻意可在 `0000` 之前独立执行，M4 的恢复流程将复用同一阶段来预建
# dump 引用的角色。本轮不实现任何恢复流程。
#
# 连接参数走标准 PG* 环境变量（PGHOST/PGPORT/PGUSER/PGPASSWORD 等）。
# `logins` 阶段需要三个密码环境变量，只通过环境传入，不进入命令行、仓库或
# psql 历史，并且以客户端生成的 SCRAM verifier 形式发送，原始口令不进入 SQL：
#   MEAL_AGENT_MIGRATION_PASSWORD
#   MEAL_AGENT_RUNTIME_PASSWORD
#   MEAL_AGENT_BACKUP_PASSWORD

set -euo pipefail

phase="${1:-}"
shift || true

dbname=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dbname)
      dbname="${2:-}"
      shift 2
      ;;
    *)
      echo "bootstrap: unexpected argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$phase" in
  roles|logins|handoff|grants) ;;
  *)
    echo "bootstrap: usage: bootstrap.sh {roles|logins|handoff|grants} --dbname <db>" >&2
    exit 2
    ;;
esac

# --dbname 只接受严格的项目数据库标识符：拒绝 URI、conninfo key=value、引号、
# 空格、大写和任何 psql 会当作连接串解释的形式。
if ! printf '%s' "$dbname" | grep -Eq '^meal_agent(_[a-z0-9_]+)?$'; then
  echo "bootstrap: --dbname must be 'meal_agent' or 'meal_agent_<suffix>'" >&2
  echo "bootstrap: URIs, conninfo strings and quoted identifiers are rejected" >&2
  exit 2
fi
if [ "${#dbname}" -gt 63 ]; then
  echo "bootstrap: --dbname exceeds the PostgreSQL identifier length limit" >&2
  exit 2
fi

script_directory="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
sql_directory="${script_directory}/sql"
psql_binary="${PSQL:-psql}"

run_sql() {
  # --no-psqlrc 忽略 ~/.psqlrc；ON_ERROR_STOP 由 SQL 内部设置并在此重申。
  # expected_db 让 SQL 侧再核对一次 current_database()，避免 PGDATABASE、
  # service 文件或连接串把我们悄悄接到别的库上。
  "$psql_binary" \
    --no-psqlrc \
    --quiet \
    --set ON_ERROR_STOP=on \
    --set expected_db="$dbname" \
    --dbname "$dbname" \
    --file "$1"
}

require_password() {
  # 只检查是否为空，绝不打印取值。
  if [ -z "${!1:-}" ]; then
    echo "bootstrap: environment variable $1 must be set and non-empty" >&2
    exit 2
  fi
}

# 每个阶段执行前的通用预检：确认真的连到了 --dbname 指定的库，并且当前身份
# 具备 cluster admin 能力。指向错误数据库时 fail closed。
run_sql "${sql_directory}/00-preflight-common.sql"

case "$phase" in
  roles)
    run_sql "${sql_directory}/01-role-baseline.sql"
    ;;
  logins)
    require_password MEAL_AGENT_MIGRATION_PASSWORD
    require_password MEAL_AGENT_RUNTIME_PASSWORD
    require_password MEAL_AGENT_BACKUP_PASSWORD
    run_sql "${sql_directory}/02-login-preflight.sql"

    # psql 的 \password 在客户端生成 SCRAM-SHA-256 verifier，只把 verifier 放进
    # ALTER USER；原始口令不进入 SQL 文本、命令行、仓库或服务端日志。
    #
    # 但 \password 的提示走 simple_prompt()，它**先尝试打开 /dev/tty**，只有在
    # 打开失败时才回落到 stdin。因此在有控制终端的交互式 shell 里，管道喂口令会
    # 永久阻塞且没有任何错误输出。容器与 CI 没有控制终端，是正常路径；这里对有
    # 控制终端的情况显式处理：优先用 setsid 脱离，否则明确失败而不是挂死。
    detach=""
    if ( exec 3< /dev/tty ) 2> /dev/null; then
      if command -v setsid > /dev/null 2>&1; then
        detach="setsid"
      else
        echo "bootstrap: refusing to set passwords from a controlling terminal" >&2
        echo "bootstrap: psql's \\password would block on /dev/tty instead of" >&2
        echo "bootstrap: reading stdin, and no 'setsid' is available to detach." >&2
        echo "bootstrap: run this phase without a controlling terminal" >&2
        echo "bootstrap: (container, CI, or 'setsid bootstrap.sh logins ...')." >&2
        exit 2
      fi
    fi

    for entry in \
      "meal_agent_migration_login:MEAL_AGENT_MIGRATION_PASSWORD" \
      "meal_agent_runtime_login:MEAL_AGENT_RUNTIME_PASSWORD" \
      "meal_agent_backup_login:MEAL_AGENT_BACKUP_PASSWORD"
    do
      role_name="${entry%%:*}"
      password_variable="${entry##*:}"
      printf '%s\n%s\n' "${!password_variable}" "${!password_variable}" \
        | ${detach} "$psql_binary" \
            --no-psqlrc \
            --quiet \
            --set ON_ERROR_STOP=on \
            --dbname "$dbname" \
            --command "SET password_encryption = 'scram-sha-256';" \
            --command "\\password \"${role_name}\""
    done

    # 强制后置校验：\password 在口令为空时会让服务端**清空**口令并且仍然退出 0，
    # 因此必须回查 pg_authid 确认三个角色都真的持有 SCRAM verifier。
    run_sql "${sql_directory}/05-login-verify.sql"
    ;;
  handoff)
    run_sql "${sql_directory}/03-owner-handoff.sql"
    ;;
  grants)
    run_sql "${sql_directory}/04-backup-grants.sql"
    ;;
esac
