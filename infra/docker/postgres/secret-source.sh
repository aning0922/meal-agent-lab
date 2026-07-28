#!/usr/bin/env bash
#
# 阶段 09A / M3A：bootstrap 的 Secret 来源解析器。
#
# 本文件只被 `source` 引入，不单独执行。它是 `services/api/src/config-source.ts`
# 的 shell 对应物：同一套互斥语义、同一套文件安全判据、同一套错误措辞，因此
# 「Compose 走 *_FILE、本地测试走进程环境」在 Node 侧与 psql 侧不会各说各话。
#
#   meal_agent_resolve_secret <VARNAME>
#
# 解析 `<VARNAME>` 与 `<VARNAME>_FILE` 这一对互斥来源，把结果写回名为
# `<VARNAME>` 的 **shell 变量**（不是环境变量），并 unset `<VARNAME>_FILE`。
#
# | `<NAME>` | `<NAME>_FILE` | 结果 |
# | --- | --- | --- |
# | 未设置 | 未设置 | 拒绝 |
# | 非空 | 未设置 | 采用进程环境（保留给非 Compose 的本地测试） |
# | 空 | 未设置 | 拒绝 |
# | 未设置 | 非空 | 采用文件 |
# | 未设置 | 空 | 拒绝 |
# | 已出现 | 已出现 | 拒绝：冲突，**不比较内容** |
#
# 「已出现」只看变量是否被设置，空字符串同样算已出现——否则
# `MEAL_AGENT_RUNTIME_PASSWORD=` 会被当成没设置，于是一个歧义配置被静默降级成
# 合法的 file-only 注入。
#
# Secret 保密边界：
#   - 取值只经 `$(< file)` 与 `printf -v` 流转，从不进入任何命令的 argv；
#   - 解析后立即 `export -n`，因此 psql 子进程的 environ 里没有口令；
#   - 每次间接展开之前都先关闭 `xtrace`，`bash -x` 下也不会打印取值；
#   - 错误信息只含变量名、路径与原因。
#
# 失败即 `exit 2`：本文件被 source 进 `bootstrap.sh`，因此这会终止整个 bootstrap
# 阶段——**在任何 psql 调用之前**。

if [ "${MEAL_AGENT_SECRET_SOURCE_LOADED:-}" = "yes" ]; then
  return 0 2> /dev/null || exit 0
fi
MEAL_AGENT_SECRET_SOURCE_LOADED="yes"

# 与 Node 侧 `maximumSecretFileBytes` 相同的上限。
meal_agent_secret_max_bytes=4096
meal_agent_stat_flavor=""
meal_agent_secret_value=""
meal_agent_secret_origin=""

meal_agent_secret_fail() {
  # $1 = 变量名；$2 = 原因。绝不打印取值。
  echo "bootstrap: $1: $2" >&2
  exit 2
}

# GNU coreutils（Debian 容器）与 BSD（macOS 本地测试）的 stat 语法不同，且没有
# 可移植的公共写法。这里显式探测一次；两者都不可用时判定为「无法验证」而拒绝，
# 不降级成「跳过属主与权限检查」。
meal_agent_detect_stat() {
  if [ -n "$meal_agent_stat_flavor" ]; then
    return 0
  fi
  if stat -c '%u' . > /dev/null 2>&1; then
    meal_agent_stat_flavor="gnu"
  elif stat -f '%u' . > /dev/null 2>&1; then
    meal_agent_stat_flavor="bsd"
  else
    echo "bootstrap: neither GNU nor BSD 'stat' is available; secret file" >&2
    echo "bootstrap: ownership and mode cannot be verified" >&2
    exit 2
  fi
}

meal_agent_read_secret_file() {
  # $1 = 变量名（只用于错误信息）；$2 = 绝对路径。
  # 成功时把内容写入全局 meal_agent_secret_value。
  local name="$1"
  local path="$2"
  local raw uid mode nlink size perm kind current_uid
  local newline_count cr_count trailing_newline

  case "$path" in
    /*) ;;
    *) meal_agent_secret_fail "$name" "$path is not an absolute path" ;;
  esac
  # -L 必须先于 -f：-f 会跟随 symlink，先判 -f 就永远看不见「它是个链接」。
  if [ -L "$path" ]; then
    meal_agent_secret_fail "$name" "$path is a symbolic link"
  fi
  if [ ! -e "$path" ]; then
    meal_agent_secret_fail "$name" "$path does not exist"
  fi
  if [ ! -f "$path" ]; then
    meal_agent_secret_fail "$name" "$path is not a regular file"
  fi
  if [ ! -r "$path" ]; then
    meal_agent_secret_fail "$name" "$path is not readable"
  fi

  meal_agent_detect_stat
  if [ "$meal_agent_stat_flavor" = "gnu" ]; then
    raw="$(stat -c '%u %f %h %s' -- "$path")" ||
      meal_agent_secret_fail "$name" "$path could not be inspected"
    set -- $raw
    uid="$1"
    # GNU 的 %f 是十六进制的完整 mode；统一换算成八进制。
    mode="$(printf '%o' "$((16#$2))")"
    nlink="$3"
    size="$4"
  else
    raw="$(stat -f '%u %p %l %z' -- "$path")" ||
      meal_agent_secret_fail "$name" "$path could not be inspected"
    set -- $raw
    uid="$1"
    mode="$2"
    nlink="$3"
    size="$4"
  fi

  kind=$((8#$mode & 8#170000))
  perm=$((8#$mode & 8#7777))
  if [ "$kind" -ne $((8#100000)) ]; then
    meal_agent_secret_fail "$name" "$path is not a regular file"
  fi
  if [ "$nlink" -ne 1 ]; then
    meal_agent_secret_fail "$name" \
      "$path has $nlink hard links; a secret file must have exactly one name"
  fi

  current_uid="${EUID:-}"
  if [ -z "$current_uid" ]; then
    current_uid="$(id -u)"
  fi
  if [ "$uid" -ne "$current_uid" ]; then
    meal_agent_secret_fail "$name" \
      "$path is owned by uid $uid but this process runs as uid $current_uid"
  fi

  # 允许的位只有 owner 的读与写（0600）：group/world 的任何位、owner 的执行位，
  # 以及 setuid/setgid/sticky 都会被拒绝。
  if [ $((perm & 8#7177)) -ne 0 ]; then
    meal_agent_secret_fail "$name" \
      "$path has mode $(printf '%04o' "$perm"); only owner read/write (0600) is accepted"
  fi
  if [ $((perm & 8#400)) -eq 0 ]; then
    meal_agent_secret_fail "$name" "$path is not readable by its owner"
  fi
  if [ "$size" -gt "$meal_agent_secret_max_bytes" ]; then
    meal_agent_secret_fail "$name" \
      "$path is $size bytes; the limit is $meal_agent_secret_max_bytes"
  fi
  if [ "$size" -eq 0 ]; then
    meal_agent_secret_fail "$name" "$path is empty"
  fi

  # NUL：命令替换会静默丢弃 NUL 字节，因此必须在读取之前按**字节数**判定。
  if [ $(($(tr -d '\000' < "$path" | wc -c))) -ne "$size" ]; then
    meal_agent_secret_fail "$name" "$path contains a NUL byte"
  fi

  if command -v iconv > /dev/null 2>&1; then
    if ! iconv -f UTF-8 -t UTF-8 < "$path" > /dev/null 2>&1; then
      meal_agent_secret_fail "$name" "$path is not valid UTF-8"
    fi
  else
    meal_agent_secret_fail "$name" \
      "iconv is required to validate that $path is UTF-8"
  fi

  if [ "$(head -c 3 -- "$path" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ]; then
    meal_agent_secret_fail "$name" "$path starts with a byte order mark"
  fi

  cr_count=$(($(tr -cd '\r' < "$path" | wc -c)))
  if [ "$cr_count" -ne 0 ]; then
    meal_agent_secret_fail "$name" \
      "$path contains a carriage return (CRLF line endings are rejected)"
  fi

  # `$(< file)` 会剥掉**全部**末尾换行，因此「恰好一个末尾 LF」必须先按字节
  # 判定，否则 `secret\n\n` 会被静默接受成 `secret`。
  newline_count=$(($(tr -cd '\n' < "$path" | wc -c)))
  if [ "$newline_count" -gt 1 ]; then
    meal_agent_secret_fail "$name" \
      "$path must contain a single line with at most one trailing newline"
  fi
  if [ "$newline_count" -eq 1 ]; then
    trailing_newline=$(($(tail -c 1 -- "$path" | tr -cd '\n' | wc -c)))
    if [ "$trailing_newline" -ne 1 ]; then
      meal_agent_secret_fail "$name" "$path must contain a single line"
    fi
    if [ "$size" -le 1 ]; then
      meal_agent_secret_fail "$name" "$path is empty"
    fi
  fi

  # 只有到这里才真正读取取值。`$(< …)` 是 bash 内建重定向，不 fork `cat`，
  # 因此取值既不进入 argv 也不进入任何子进程；除末尾那一个 LF 之外不做 trim，
  # 前后空格与 `:`/`\`/`@`/`/`/`#`/`%` 全部原样保留。
  meal_agent_secret_value="$(< "$path")"
}

meal_agent_resolve_secret() {
  local name="$1"
  local previous_options="$-"
  # 第一次间接展开之前关闭 xtrace：`${!name}` 在 `set -x` 下会把取值打进 stderr。
  set +x

  local file_name="${name}_FILE"
  local direct_set="no"
  local file_set="no"
  local path

  if ! printf '%s' "$name" | grep -Eq '^[A-Z_][A-Z0-9_]*$'; then
    meal_agent_secret_fail "$name" "is not a valid environment variable name"
  fi

  # `${!name+x}` 区分「已设置」与「未设置」，空字符串算已设置。
  if [ -n "${!name+x}" ]; then
    direct_set="yes"
  fi
  if [ -n "${!file_name+x}" ]; then
    file_set="yes"
  fi

  if [ "$direct_set" = "yes" ] && [ "$file_set" = "yes" ]; then
    meal_agent_secret_fail "$name" \
      "$name and $file_name are mutually exclusive; exactly one must be set (their values are never compared)"
  fi
  if [ "$direct_set" = "no" ] && [ "$file_set" = "no" ]; then
    meal_agent_secret_fail "$name" "either $name or $file_name is required"
  fi

  if [ "$direct_set" = "yes" ]; then
    meal_agent_secret_value="${!name}"
    if [ -z "$meal_agent_secret_value" ]; then
      meal_agent_secret_fail "$name" \
        "$name is set but empty; an empty value is never a valid credential and must not fall back to $file_name"
    fi
    meal_agent_secret_origin="environment"
  else
    path="${!file_name}"
    if [ -z "$path" ]; then
      meal_agent_secret_fail "$name" "$file_name is set but empty"
    fi
    # 选中文件之后**不再**回落到进程环境：文件不合格就是失败。
    meal_agent_read_secret_file "$file_name" "$path"
    meal_agent_secret_origin="file"
  fi

  printf -v "$name" '%s' "$meal_agent_secret_value"
  # 取消导出：即使取值原本来自进程环境，psql 子进程的 environ 里也不再有它。
  export -n "$name" 2> /dev/null || true
  unset "$file_name"
  meal_agent_secret_value=""

  case "$previous_options" in *x*) set -x ;; esac
}
