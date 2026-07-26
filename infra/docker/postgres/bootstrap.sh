#!/usr/bin/env bash
#
# 阶段 09A / M2A：PostgreSQL 18 bootstrap orchestrator。
#
# 以 cluster admin 身份建立数据库身份边界。它只做角色与归属，不执行业务
# migration，也不写 migration ledger。
#
# 用法：
#   bootstrap.sh handoff --dbname <db>   # 0000 之后、0001 之前
#   bootstrap.sh logins  --dbname <db>   # owner 交接之后
#   bootstrap.sh grants  --dbname <db>   # 0001—最新 migration 之后
#   bootstrap.sh all     --dbname <db>   # handoff + logins
#
# 连接参数走标准 PG* 环境变量（PGHOST/PGPORT/PGUSER/PGPASSWORD 等）。
# `logins` 阶段需要三个密码环境变量，它们只通过环境传入，不进入命令行、
# 仓库或 psql 历史：
#   MEAL_AGENT_MIGRATION_PASSWORD
#   MEAL_AGENT_RUNTIME_PASSWORD
#   MEAL_AGENT_BACKUP_PASSWORD
#
# 完整的执行顺序（M2A 验证的路径）：
#   1. admin      createdb
#   2. admin      apply 0000（migration runner，不切换 role）
#   3. admin      bootstrap.sh handoff
#   4. admin      bootstrap.sh logins
#   5. migration  login apply 0001—最新（显式 SET ROLE meal_agent_migrator）
#   6. admin      bootstrap.sh grants
#   7. runtime    login readiness（显式 SET LOCAL ROLE meal_agent_app）

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
  handoff|logins|grants|all) ;;
  *)
    echo "bootstrap: usage: bootstrap.sh {handoff|logins|grants|all} --dbname <db>" >&2
    exit 2
    ;;
esac

if [ -z "$dbname" ]; then
  echo "bootstrap: --dbname is required" >&2
  exit 2
fi

script_directory="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
sql_directory="${script_directory}/sql"
psql_binary="${PSQL:-psql}"

run_sql() {
  # -X 忽略 ~/.psqlrc，-q 安静，ON_ERROR_STOP 由 SQL 内部设置并在此重申。
  "$psql_binary" \
    --no-psqlrc \
    --quiet \
    --set ON_ERROR_STOP=on \
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

if [ "$phase" = "handoff" ] || [ "$phase" = "all" ]; then
  run_sql "${sql_directory}/01-owner-handoff.sql"
fi

if [ "$phase" = "logins" ] || [ "$phase" = "all" ]; then
  require_password MEAL_AGENT_MIGRATION_PASSWORD
  require_password MEAL_AGENT_RUNTIME_PASSWORD
  require_password MEAL_AGENT_BACKUP_PASSWORD
  run_sql "${sql_directory}/02-login-roles.sql"
fi

if [ "$phase" = "grants" ]; then
  run_sql "${sql_directory}/03-backup-grants.sql"
fi
