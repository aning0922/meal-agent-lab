#!/usr/bin/env bash
#
# 阶段 09A / M3A：bootstrap 的 Secret 来源解析器。
#
# 本文件只被 `source` 引入，不单独执行。它是 `services/api/src/config-source.ts`
# 的 shell 对应物：同一套互斥语义、同一套内容判据、同一套错误措辞，因此
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
# | 非空 | 未设置 | 采用进程环境 |
# | 空 | 未设置 | 拒绝 |
# | 未设置 | 非空 | 采用文件 |
# | 未设置 | 空 | 拒绝 |
# | 已出现 | 已出现 | 拒绝：冲突，**不比较内容** |
#
# 「已出现」只看变量是否被设置，空字符串同样算已出现——否则
# `MEAL_AGENT_RUNTIME_PASSWORD=` 会被当成没设置，于是一个歧义配置被静默降级成
# 合法的 file-only 注入。
#
# ## 两条来源的内容判据完全一致
#
# direct 与 file 的取值都会被写进**同一份私有快照**，再由同一个检查器判定：
# 非空、≤4096 字节、无 NUL、合法 UTF-8、无 BOM、无 CR、不 trim。唯一的差别是
# 末尾 LF：file 允许**一个**（文件格式惯例），direct **一个都不允许**。
#
# 多行 direct 尤其危险：`foo\nfoo` 喂给 psql 的 `\password` 会被读成两次相同
# 输入，于是口令被**静默**设置成 `foo`——部署以为自己设了一个更长的口令，实际
# 生效的只是它的第一行。
#
# ## 文件来源不存在 TOCTOU 窗口
#
# 「先 stat 路径、再按路径 open/读取」会让 metadata 与内容来自不同的 inode。
# 这里改成：**只 open 一次**，随后
#
#   1. 用 `/dev/fd/N` 取该描述符的 inode，与路径 stat 的 inode 逐项绑定；
#   2. 把内容从**这个描述符**复制到一份私有快照（`umask 077` 的 `mktemp -d`
#      目录，Compose 拓扑里 `/tmp` 是 tmpfs）；
#   3. 之后的全部检查与最终读取只针对快照，**再也不碰原路径**。
#
# 因此「检查过的 inode」与「消费掉的字节」必然是同一个。`/dev/fd/N` 的权限位
# 在 macOS 上不可信（devfs 实测报 0400），所以属主与权限仍取自路径 stat——它由
# inode 相等绑定到同一个 inode 上。
#
# 读取是**有界**的。shell 没有 `O_NONBLOCK`，所以 `open()`（无写端 FIFO）与复制
# 阶段（被拖住的 `head`）都可能永久阻塞；整段因此跑在一个独立进程组的后台子
# 进程里，由父进程做 5 秒有界等待，超时对**整个进程组** TERM 再 KILL。外部信号
# （TERM/INT/HUP）共用同一段清理，见下面的 worker-group 小节。
#
# ## Secret 保密边界
#
#   - 取值只经 `$(< …)`、`printf -v`、`printf '%s' >` 与 fd 重定向流转，
#     从不进入任何命令的 argv；
#   - 解析后立即 `export -n`，因此 psql 子进程的 environ 里没有口令；
#   - 每次间接展开之前都先关闭 `xtrace`，`bash -x` 下也不会打印取值；
#   - 快照目录 `umask 077`，用后立即删除，并由 EXIT trap 兜底；
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
# `open()` + 校验 + 复制的有界上限。超时后对**整个 worker 进程组** TERM 再 KILL，
# 因此受控子树（worker、复制阶段的 head、它派生的 sleep）不会被留成孤儿。
# 这条保证只覆盖**本脚本自己拉起的**进程；它不声称清理 bootstrap 之外的任何东西。
meal_agent_secret_open_deadline_seconds=5
meal_agent_secret_open_deadline_ticks=100
meal_agent_stat_flavor=""
meal_agent_secret_value=""
meal_agent_secret_origin=""
meal_agent_snapshot_dir=""

meal_agent_discard_snapshot() {
  if [ -n "$meal_agent_snapshot_dir" ]; then
    rm -rf -- "$meal_agent_snapshot_dir"
    meal_agent_snapshot_dir=""
  fi
}

# failure-safe：无论正常退出、失败退出还是被信号打断，快照都不会留在磁盘上。
trap 'meal_agent_discard_snapshot' EXIT

# ---------------------------------------------------------------------------
# worker 进程组的统一清理
# ---------------------------------------------------------------------------
# 内部 5 秒超时与**外部信号**（TERM/INT/HUP）共用同一段清理逻辑：只 kill worker
# 这一个 PID 会把被拖住的后代（复制阶段的 head、它派生的 sleep）留成孤儿，继续
# 持有描述符。worker 由 `set -m` 放进独立进程组，因此这里对**整个进程组**动手。
meal_agent_worker_pid=""
meal_agent_saved_signal_traps=""

meal_agent_terminate_worker_group() {
  if [ -z "$meal_agent_worker_pid" ]; then
    return 0
  fi
  local worker="$meal_agent_worker_pid"
  meal_agent_worker_pid=""
  # 整段包在 stderr 重定向里：被杀死的后台作业会让 shell 打印一行 "Terminated"
  # 通知，那不是 bootstrap 的诊断信息。
  {
    kill -TERM -- "-$worker" 2> /dev/null ||
      kill -TERM "$worker" 2> /dev/null || true
    sleep 0.2
    kill -KILL -- "-$worker" 2> /dev/null ||
      kill -KILL "$worker" 2> /dev/null || true
    wait "$worker" || true
  } 2> /dev/null
}

# 外部信号：先收干净受控子树与快照，再以**正确的信号退出语义**结束——恢复默认
# 处置后用同一个信号自杀，调用方看到的是 128+signo，而不是一个普通退出码。
meal_agent_handle_signal() {
  local signal="$1"
  meal_agent_terminate_worker_group
  meal_agent_discard_snapshot
  trap - "$signal"
  kill -"$signal" $$
}

# 只在 worker 活跃期间接管这三个信号，并保存调用方原有的 trap。bootstrap.sh 自身
# 目前没有设置它们，但这里不能假设——覆盖必须是**临时**的。
meal_agent_install_signal_traps() {
  meal_agent_saved_signal_traps="$(trap -p TERM INT HUP)"
  trap 'meal_agent_handle_signal TERM' TERM
  trap 'meal_agent_handle_signal INT' INT
  trap 'meal_agent_handle_signal HUP' HUP
}

meal_agent_restore_signal_traps() {
  trap - TERM INT HUP
  if [ -n "$meal_agent_saved_signal_traps" ]; then
    eval "$meal_agent_saved_signal_traps"
  fi
  meal_agent_saved_signal_traps=""
}

meal_agent_secret_fail() {
  # $1 = 变量名；$2 = 原因。绝不打印取值。
  meal_agent_discard_snapshot
  echo "bootstrap: $1: $2" >&2
  exit 2
}

# 子进程版本：快照目录归**父进程**所有（状态文件也在里面），因此子进程失败时
# 只报告并退出，绝不删除目录。
meal_agent_secret_child_fail() {
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

# 输出 "<dev> <ino> <uid> <八进制含类型的 mode> <nlink> <size>"。
meal_agent_stat_path() {
  if [ "$meal_agent_stat_flavor" = "gnu" ]; then
    # GNU 的 %f 是十六进制的完整 mode；统一换算成八进制。
    set -- $(stat -c '%d %i %u %f %h %s' -- "$1") || return 1
    printf '%s %s %s %s %s %s\n' \
      "$1" "$2" "$3" "$(printf '%o' "$((16#$4))")" "$5" "$6"
  else
    stat -f '%d %i %u %p %l %z' -- "$1" || return 1
  fi
}

# 输出 "<ino> <八进制含类型的 mode> <nlink> <size>"，取自**文件描述符**。
#
# GNU：`/dev/fd/N` 是指向 `/proc/self/fd/N` 的符号链接，而 GNU `stat` 默认 lstat，
# 因此必须显式 `-L` 才能拿到真实文件。
# BSD：`/dev/fd/N` 是 devfs 节点，inode / 类型 / 链接数 / 大小可信，**权限位不可信**
# （实测把 0600 报成 0400），因此调用方只使用前四项里的 inode、类型与大小。
meal_agent_stat_fd() {
  if [ "$meal_agent_stat_flavor" = "gnu" ]; then
    set -- $(stat -L -c '%i %f %h %s' "/dev/fd/$1") || return 1
    printf '%s %s %s %s\n' \
      "$1" "$(printf '%o' "$((16#$2))")" "$3" "$4"
  else
    stat -f '%i %p %l %z' "/dev/fd/$1" || return 1
  fi
}

# 建立一份 owner-only 的私有快照目录，并把快照路径写入 meal_agent_snapshot_path。
meal_agent_open_snapshot() {
  local name="$1"
  local previous_umask
  meal_agent_discard_snapshot
  previous_umask="$(umask)"
  umask 077
  meal_agent_snapshot_dir="$(
    mktemp -d "${TMPDIR:-/tmp}/meal-agent-secret.XXXXXX"
  )" || {
    umask "$previous_umask"
    meal_agent_secret_fail "$name" "could not create a private snapshot directory"
  }
  umask "$previous_umask"
  meal_agent_snapshot_path="${meal_agent_snapshot_dir}/value"
}

# 内容判据。direct 与 file **共用**这一个检查器，唯一差别是末尾 LF 是否允许。
#   $1 = 变量名（错误前缀）  $2 = 错误里指代的对象  $3 = yes|no 允许一个末尾 LF
# 成功时把取值写入 meal_agent_secret_value。
meal_agent_assert_snapshot_content() {
  local name="$1"
  local subject="$2"
  local allow_trailing_newline="$3"
  local snapshot="$meal_agent_snapshot_path"
  local size newline_count cr_count trailing_newline hex

  size=$(($(wc -c < "$snapshot")))
  if [ "$size" -eq 0 ]; then
    meal_agent_secret_fail "$name" "$subject is empty"
  fi
  if [ "$size" -gt "$meal_agent_secret_max_bytes" ]; then
    meal_agent_secret_fail "$name" \
      "$subject is $size bytes; the limit is $meal_agent_secret_max_bytes"
  fi

  # NUL：命令替换会静默丢弃 NUL 字节，因此必须按**字节数**判定，不能靠读取。
  if [ $(($(tr -d '\000' < "$snapshot" | wc -c))) -ne "$size" ]; then
    meal_agent_secret_fail "$name" "$subject contains a NUL byte"
  fi

  if command -v iconv > /dev/null 2>&1; then
    if ! iconv -f UTF-8 -t UTF-8 < "$snapshot" > /dev/null 2>&1; then
      meal_agent_secret_fail "$name" "$subject is not valid UTF-8"
    fi
  else
    meal_agent_secret_fail "$name" \
      "iconv is required to validate that $subject is UTF-8"
  fi

  # U+FEFF 出现在**任何位置**都拒绝，与 Node 侧的判据一致（只查开头会让
  # 「中间藏一个 BOM」在两条实现之间产生分歧）。内容已通过 UTF-8 校验，因此
  # 字节序列 EF BB BF 必然就是 U+FEFF；逐字节比较，不会跨字节边界误报。
  hex=" $(od -An -v -tx1 < "$snapshot" | tr '\n' ' ' | tr -s ' ')"
  case "$hex" in
    *" ef bb bf "*)
      meal_agent_secret_fail "$name" "$subject contains a byte order mark"
      ;;
  esac

  cr_count=$(($(tr -cd '\r' < "$snapshot" | wc -c)))
  if [ "$cr_count" -ne 0 ]; then
    meal_agent_secret_fail "$name" \
      "$subject contains a carriage return (CRLF line endings are rejected)"
  fi

  # `$(< …)` 会剥掉**全部**末尾换行，因此换行必须先按字节判定。
  newline_count=$(($(tr -cd '\n' < "$snapshot" | wc -c)))
  if [ "$allow_trailing_newline" != "yes" ]; then
    if [ "$newline_count" -ne 0 ]; then
      meal_agent_secret_fail "$name" "$subject must contain a single line"
    fi
  else
    if [ "$newline_count" -gt 1 ]; then
      meal_agent_secret_fail "$name" \
        "$subject must contain a single line with at most one trailing newline"
    fi
    if [ "$newline_count" -eq 1 ]; then
      trailing_newline=$(($(tail -c 1 -- "$snapshot" | tr -cd '\n' | wc -c)))
      if [ "$trailing_newline" -ne 1 ]; then
        meal_agent_secret_fail "$name" "$subject must contain a single line"
      fi
      if [ "$size" -le 1 ]; then
        meal_agent_secret_fail "$name" "$subject is empty"
      fi
    fi
  fi

  # 只有到这里才真正读取取值。除末尾那一个 LF 之外不做任何 trim：前后空格与
  # `:`/`\\`/`@`/`/`/`#`/`%` 全部原样保留。
  meal_agent_secret_value="$(< "$meal_agent_snapshot_path")"
}

# open + 校验 + 有界复制。**在后台子进程里执行**，理由见下面的调用方注释。
# 它只报告问题并以非零退出，绝不删除快照目录。
meal_agent_copy_validated_secret() {
  local name="$1"
  local path="$2"
  local raw uid mode nlink size perm current_uid
  local dev1 ino1
  local fd_ino fd_mode fd_nlink fd_size fd_kind

  # 这一步可能永久阻塞（无写端的 FIFO），因此整个函数都跑在有界的子进程里。
  exec 9< "$path" ||
    meal_agent_secret_child_fail "$name" "$path could not be opened"

  raw="$(meal_agent_stat_fd 9)" ||
    meal_agent_secret_child_fail "$name" "$path could not be inspected"
  set -- $raw
  fd_ino="$1"
  fd_mode="$2"
  fd_nlink="$3"
  fd_size="$4"

  # 路径 stat 在**持有描述符期间**执行：inode 因此被钉住，不会被回收再利用。
  raw="$(meal_agent_stat_path "$path")" ||
    meal_agent_secret_child_fail "$name" "$path could not be inspected"
  set -- $raw
  dev1="$1"
  ino1="$2"
  uid="$3"
  mode="$4"
  nlink="$5"
  size="$6"

  if [ "$fd_ino" != "$ino1" ]; then
    meal_agent_secret_child_fail "$name" \
      "$path was replaced while it was being validated"
  fi

  fd_kind=$((8#$fd_mode & 8#170000))
  if [ "$fd_kind" -ne $((8#100000)) ]; then
    meal_agent_secret_child_fail "$name" "$path is not a regular file"
  fi
  if [ "$fd_nlink" -ne 1 ]; then
    meal_agent_secret_child_fail "$name" \
      "$path has $fd_nlink hard links; a secret file must have exactly one name"
  fi
  if [ "$fd_size" -gt "$meal_agent_secret_max_bytes" ]; then
    meal_agent_secret_child_fail "$name" \
      "$path is $fd_size bytes; the limit is $meal_agent_secret_max_bytes"
  fi

  current_uid="${EUID:-}"
  if [ -z "$current_uid" ]; then
    current_uid="$(id -u)"
  fi
  if [ "$uid" -ne "$current_uid" ]; then
    meal_agent_secret_child_fail "$name" \
      "$path is owned by uid $uid but this process runs as uid $current_uid"
  fi
  perm=$((8#$mode & 8#7777))
  if [ $((perm & 8#7177)) -ne 0 ]; then
    meal_agent_secret_child_fail "$name" \
      "$path has mode $(printf '%04o' "$perm"); only owner-only 0400 or 0600 is accepted"
  fi
  if [ $((perm & 8#400)) -eq 0 ]; then
    meal_agent_secret_child_fail "$name" "$path is not readable by its owner"
  fi

  # 有界读取：最多 max+1 字节。多出来的那一个字节让「fstat 之后文件被撑大」
  # 变成一次确定的拒绝，而不是先用无界的 `cat` 把任意大小读进磁盘。
  head -c $((meal_agent_secret_max_bytes + 1)) <&9 > "$meal_agent_snapshot_path" ||
    meal_agent_secret_child_fail "$name" "$path could not be read"
  exec 9<&-

  printf '%s' "$fd_size" > "${meal_agent_snapshot_dir}/fd-size"
}

meal_agent_read_secret_file() {
  # $1 = 变量名（只用于错误信息）；$2 = 绝对路径。
  local name="$1"
  local path="$2"
  local worker status_file status waited snapshot_size fd_size
  local previous_options

  case "$path" in
    /*) ;;
    *) meal_agent_secret_fail "$name" "$path is not an absolute path" ;;
  esac
  # 以下四条是 open 之前的**粗筛**，不是最终判据：真正的判据在 open 之后按
  # 文件描述符执行。-L 必须先于 -f，因为 -f 会跟随 symlink。
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
  meal_agent_open_snapshot "$name"
  status_file="${meal_agent_snapshot_dir}/status"

  # 为什么要开子进程：粗筛与 `open()` 之间路径仍可能被换成**无写端的 FIFO**，
  # 而 shell 没有 `O_NONBLOCK` 可用，`exec 9<` 会永久阻塞；复制阶段的
  # `head` 同样可能被拖住。把 open 连同全部校验与复制放进后台子进程，父进程做
  # 有界等待，超时就 TERM→KILL。
  # EXIT trap 保证「失败也写状态」，因此父进程能区分「失败了」与「还卡着」。
  #
  # `set -m` 让这个后台作业成为**独立进程组的组长**（pgid == worker pid）。
  # 没有它的话，超时只能 kill worker 这一个 PID，而 `head` 这类后代会被留下来
  # 继续持有描述符（实测：worker gone、被阻塞的 head 仍 ALIVE）。有了进程组，
  # 下面的 `kill -- -$worker` 才能把**整棵**受控子树一起收掉。
  previous_options="$-"
  set -m
  (
    trap 'meal_agent_child_status=$?; printf "%s" "$meal_agent_child_status" > "${status_file}.partial"; mv -f "${status_file}.partial" "$status_file"' EXIT
    meal_agent_copy_validated_secret "$name" "$path"
  ) &
  worker=$!
  case "$previous_options" in *m*) ;; *) set +m ;; esac

  # worker 活跃期间接管 TERM/INT/HUP：内部超时与外部信号共用同一段清理。
  meal_agent_worker_pid="$worker"
  meal_agent_install_signal_traps

  waited=0
  while [ ! -e "$status_file" ]; do
    if [ "$waited" -ge "$meal_agent_secret_open_deadline_ticks" ]; then
      meal_agent_terminate_worker_group
      meal_agent_restore_signal_traps
      meal_agent_secret_fail "$name" \
        "$path could not be opened and read within ${meal_agent_secret_open_deadline_seconds}s; open() on a non-regular file such as a FIFO, or a stalled read, would otherwise block without a bound"
    fi
    sleep 0.05
    waited=$((waited + 1))
  done
  wait "$worker" 2> /dev/null || true
  meal_agent_worker_pid=""
  meal_agent_restore_signal_traps

  status="$(cat "$status_file")"
  if [ "$status" != "0" ]; then
    # 具体理由已由子进程打印到 stderr。
    meal_agent_secret_fail "$name" "$path failed validation"
  fi

  fd_size=$(($(cat "${meal_agent_snapshot_dir}/fd-size")))
  snapshot_size=$(($(wc -c < "$meal_agent_snapshot_path")))
  if [ "$snapshot_size" -gt "$meal_agent_secret_max_bytes" ]; then
    meal_agent_secret_fail "$name" \
      "$path grew past $meal_agent_secret_max_bytes bytes while it was being read"
  fi
  if [ "$snapshot_size" -ne "$fd_size" ]; then
    meal_agent_secret_fail "$name" "$path changed size while it was being read"
  fi

  meal_agent_assert_snapshot_content "$name" "$path" yes
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
    if [ -z "${!name}" ]; then
      meal_agent_secret_fail "$name" \
        "$name is set but empty; an empty value is never a valid credential and must not fall back to $file_name"
    fi
    # direct 的内容判据与 file 完全一致，只是一个末尾 LF 都不允许。取值经
    # `printf` 内建写进私有快照，不进入 argv。
    meal_agent_open_snapshot "$name"
    printf '%s' "${!name}" > "$meal_agent_snapshot_path"
    meal_agent_assert_snapshot_content "$name" "$name" no
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
  meal_agent_discard_snapshot

  case "$previous_options" in *x*) set -x ;; esac
}
