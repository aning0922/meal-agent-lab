#!/usr/bin/env bash
#
# 阶段 09A / M3A：`secret-source.sh` 信号状态机的精简矩阵。
#
#   usage: signal-matrix.sh <path-to-secret-source.sh>
#
# 它是**门禁的载荷**，不是文档示例：`tests/unit/bootstrap-signal-matrix.test.ts`
# 会把它放进钉住 digest 的 `postgres:18.4-bookworm` 里以 uid 999 跑一遍，因此
# macOS/bash 3.2 与 Debian/bash 5.2 两侧用的是**同一份**断言。
#
# 覆盖的维度：
#
#   调用方处置   default（默认处置）、exit（handler 自杀）、return（handler 返回
#                但不退出）、ignore（`trap '' SIG`）
#   信号         TERM / INT / HUP
#   投递窗口     none（worker 运行中）、terminating（TERM 已发、KILL 未发）、
#                handler（winner 的调用方 handler 正在执行）、
#                storm（重投窗口里的同名信号风暴）、
#                postworker（worker 已结束，正在删除快照）
#   并发裁决     first-wins
#   EXIT trap    调用方原有的 EXIT trap 必须链式执行，并拿到**真实退出状态**
#
# ## 窗口是怎么被确定命中的（全部靠测试侧观察，生产代码里没有任何测试入口）
#
#   terminating  受控的 `head` 自己 trap 住 TERM 并写一个 marker（它仍然不退出）。
#                实现对**整个 worker 进程组**发 TERM 是一个真实的外部可观测事件，
#                harness 等到那个 marker 才发第二个信号。
#   postworker   PATH 影子 `rm` 在**第一次**被调用时写 marker 并等 release。
#                `meal_agent_discard_snapshot` 用的就是 `rm -rf`，因此这一刻
#                worker 早已结束、快照验证与取值复制都已完成，正处在「删除快照」
#                这一步中间。
#
# ## 关于 `starting` 窗口
#
# `starting`（trap 已装、`worker=$!` 还没赋值）之间没有任何外部可观测的副作用，
# 因此**无法**被真实、确定地命中。上一版是靠生产代码里的 marker 文件 + 阻塞等待
# 做出来的，那等于在生产路径上留了一个可写文件的测试入口，已经整条删除。
# 这个窗口现在**只由代码顺序**保证（先装 trap、后 fork），矩阵里不再声称它被证明过。
set -u

if [ "$#" -ne 1 ]; then
  echo "usage: signal-matrix.sh <path-to-secret-source.sh>" >&2
  exit 64
fi

meal_agent_source="$1"
if [ ! -r "$meal_agent_source" ]; then
  echo "signal-matrix: $meal_agent_source is not readable" >&2
  exit 66
fi

work="$(mktemp -d)"
umask 077

# 每个 case 拉起来的进程组都登记在这里；矩阵退出时无条件整组收掉。容器里同样
# 生效——EXIT trap 覆盖正常结束、断言失败与被信号打断三种情况。
meal_agent_matrix_groups=""

meal_agent_matrix_cleanup() {
  local pgid=""
  for pgid in $meal_agent_matrix_groups; do
    kill -KILL -- "-$pgid" 2> /dev/null || true
    kill -KILL "$pgid" 2> /dev/null || true
  done
  meal_agent_matrix_groups=""
  rm -rf -- "$work"
}
trap 'meal_agent_matrix_cleanup' EXIT
trap 'meal_agent_matrix_cleanup; exit 143' TERM
trap 'meal_agent_matrix_cleanup; exit 130' INT

failures=0
checks=0

pass() {
  checks=$((checks + 1))
  printf '  ok    %-46s %s\n' "$1" "${2-}"
}

fail() {
  checks=$((checks + 1))
  failures=$((failures + 1))
  printf '  FAIL  %-46s %s\n' "$1" "${2-}"
}

check() {
  # $1 = label, $2 = expected, $3 = actual
  if [ "$2" = "$3" ]; then
    pass "$1" "$3"
  else
    fail "$1" "expected [$2], got [$3]"
  fi
}

contains() {
  # $1 = label, $2 = file, $3 = needle
  if grep -q -- "$3" "$2" 2> /dev/null; then
    pass "$1" "$3"
  else
    fail "$1" "$3 missing"
  fi
}

absent() {
  # $1 = label, $2 = file, $3 = needle
  if grep -q -- "$3" "$2" 2> /dev/null; then
    fail "$1" "$3 must not appear"
  else
    pass "$1" "no $3"
  fi
}

# 受控的 stall wrapper：第一次调用时接管 `head`，派生一个孙进程，并持有一个真实
# FIFO 的读端。它把三个信号都接管成「记录下来但不退出」——效果与忽略相同，但
# TERM 的到达因此成为一个**测试侧可观测**的事件（terminating 窗口就靠它定位）。
# 孙进程在 trap 设好之后才 fork，因此继承同一套处置。
mkdir -p "$work/bin"
cat > "$work/bin/head" << 'WRAPPER'
#!/usr/bin/env bash
set -u
if [ ! -e "$MEAL_AGENT_MATRIX_MARKER" ]; then
  : > "$MEAL_AGENT_MATRIX_MARKER"
  trap ': > "$MEAL_AGENT_MATRIX_TERM"' TERM
  trap ': > "$MEAL_AGENT_MATRIX_TERM"' INT
  trap ': > "$MEAL_AGENT_MATRIX_TERM"' HUP
  printf '%s' "$$" > "$MEAL_AGENT_MATRIX_HEAD"
  printf '%s' "$PPID" > "$MEAL_AGENT_MATRIX_WORKER"
  # 交出 bootstrap 的 stdout/stderr：不这么做的话「受控子树还活着」与「管道还没
  # 关」就永远绑在一起，任何清理缺陷都只表现成 harness 超时，掩盖真正的事实。
  exec > /dev/null 2>&1
  exec 7<> "$MEAL_AGENT_MATRIX_FIFO"
  sleep 600 &
  printf '%s' "$!" > "$MEAL_AGENT_MATRIX_SLEEP"
  while :; do
    wait || true
  done
fi
exec /usr/bin/head "$@"
WRAPPER
chmod 755 "$work/bin/head"

# postworker 窗口用的影子 `rm`：`meal_agent_discard_snapshot` 用的就是 `rm -rf`。
# 只在第一次调用时暂停，之后原样放行（否则 EXIT trap 里的第二次删除会自锁）。
mkdir -p "$work/rmbin"
cat > "$work/rmbin/rm" << 'RMWRAPPER'
#!/usr/bin/env bash
set -u
real="/bin/rm"
[ -x "$real" ] || real="/usr/bin/rm"
if [ -n "${MEAL_AGENT_MATRIX_RM_MARKER:-}" ] && [ ! -e "$MEAL_AGENT_MATRIX_RM_MARKER" ]; then
  : > "$MEAL_AGENT_MATRIX_RM_MARKER"
  waited=0
  while [ ! -e "${MEAL_AGENT_MATRIX_RM_MARKER}.release" ]; do
    if [ "$waited" -ge 200 ]; then
      break
    fi
    sleep 0.05
    waited=$((waited + 1))
  done
fi
exec "$real" "$@"
RMWRAPPER
chmod 755 "$work/rmbin/rm"

# 调用方驱动脚本。`DISPOSITION` 决定它给 TERM/INT/HUP 装什么；EXIT trap 永远装，
# 因为「调用方的 EXIT trap 必须链式执行并拿到真实退出状态」是每个用例都要验的。
cat > "$work/driver.sh" << 'DRIVER'
#!/usr/bin/env bash
set -u
trap 'echo "CALLER-EXIT-MARKER rc=$?" >&2' EXIT
case "$DISPOSITION" in
  default) ;;
  exit)
    trap 'echo CALLER-TRAP-TERM >&2; exit 71' TERM
    trap 'echo CALLER-TRAP-INT >&2; exit 72' INT
    trap 'echo CALLER-TRAP-HUP >&2; exit 73' HUP
    ;;
  slow-exit)
    trap 'echo CALLER-TRAP-TERM >&2; sleep 0.6; echo CALLER-TRAP-TERM-DONE >&2; exit 71' TERM
    trap 'echo CALLER-TRAP-INT >&2; exit 72' INT
    trap 'echo CALLER-TRAP-HUP >&2; exit 73' HUP
    ;;
  return)
    trap 'echo CALLER-RETURN-TERM >&2' TERM
    trap 'echo CALLER-RETURN-INT >&2' INT
    trap 'echo CALLER-RETURN-HUP >&2' HUP
    ;;
  ignore)
    trap '' TERM INT HUP
    ;;
  *)
    echo "driver: unknown disposition $DISPOSITION" >&2
    exit 64
    ;;
esac
# shellcheck source=/dev/null
source "$MEAL_AGENT_MATRIX_SOURCE"
meal_agent_resolve_secret MEAL_AGENT_RUNTIME_PASSWORD
echo "RESOLVED ${#MEAL_AGENT_RUNTIME_PASSWORD}"
echo TRAPS-AFTER-BEGIN
trap -p TERM INT HUP
echo TRAPS-AFTER-END
echo EXIT-TRAP-AFTER-BEGIN
trap -p EXIT
echo EXIT-TRAP-AFTER-END
exit 0
DRIVER
chmod 755 "$work/driver.sh"

printf 'RUNTIME-PASSWORD-SENTINEL' > "$work/secret"
chmod 600 "$work/secret"

alive() { kill -0 "$1" 2> /dev/null; }

await_file() {
  # $1 = path, $2 = ticks (0.05s each)
  local waited=0
  while [ ! -e "$1" ]; do
    if [ "$waited" -ge "$2" ]; then
      return 1
    fi
    sleep 0.05
    waited=$((waited + 1))
  done
  return 0
}

await_gone() {
  # $1 = pid, $2 = ticks. 有界确认进程真的消失，而不是「刚发完信号就断言」。
  local waited=0
  while alive "$1"; do
    if [ "$waited" -ge "$2" ]; then
      return 1
    fi
    sleep 0.05
    waited=$((waited + 1))
  done
  return 0
}

# 每个 case 的看门狗：到点就把这个 case 的整个进程组收掉，让 `wait` 一定会返回。
# 没有它的话，一个不肯退出的实现会把整条门禁挂死，而不是变成一次确定的失败。
meal_agent_case_watchdog_seconds=25

case_status=""
run_case() {
  # run_case <slot> <disposition> <stall:yes|no>
  #          <window:none|terminating|handler|storm|postworker> <winner|-> <loser|->
  local slot="$1" disposition="$2" stall="$3" window="$4" winner="$5" loser="$6"
  local dir="$work/$slot"
  mkdir -p "$dir"
  local out="$dir/out"
  local fifo="$dir/fifo"
  mkfifo "$fifo"

  local path="$PATH"
  if [ "$stall" = "yes" ]; then
    path="$work/bin:$PATH"
  fi
  local rm_marker=""
  if [ "$window" = "postworker" ]; then
    path="$work/rmbin:$path"
    rm_marker="$dir/rm.marker"
  fi

  set -m
  env PATH="$path" TMPDIR="$dir" \
    DISPOSITION="$disposition" \
    MEAL_AGENT_MATRIX_SOURCE="$meal_agent_source" \
    MEAL_AGENT_MATRIX_MARKER="$dir/stall.marker" \
    MEAL_AGENT_MATRIX_TERM="$dir/term.marker" \
    MEAL_AGENT_MATRIX_HEAD="$dir/head.pid" \
    MEAL_AGENT_MATRIX_WORKER="$dir/worker.pid" \
    MEAL_AGENT_MATRIX_SLEEP="$dir/sleep.pid" \
    MEAL_AGENT_MATRIX_FIFO="$fifo" \
    MEAL_AGENT_MATRIX_RM_MARKER="$rm_marker" \
    MEAL_AGENT_RUNTIME_PASSWORD_FILE="$work/secret" \
    bash "$work/driver.sh" > "$out" 2>&1 &
  local driver=$!
  set +m
  meal_agent_matrix_groups="$meal_agent_matrix_groups $driver"

  # 看门狗。它自己也在后台，case 结束后立刻收掉。
  (
    sleep "$meal_agent_case_watchdog_seconds"
    if kill -0 "$driver" 2> /dev/null; then
      : > "$dir/watchdog.fired"
      kill -KILL -- "-$driver" 2> /dev/null || true
      kill -KILL "$driver" 2> /dev/null || true
    fi
  ) &
  local watchdog=$!

  case "$window" in
    terminating)
      # 先等 worker 真的跑起来（三层 PID 齐全），发 winner 触发清理；实现对整个
      # worker 进程组发 TERM 时，受控 head 会写下 term.marker——那是一个真实的
      # 外部可观测事件，不是生产代码里的测试钩子。
      if ! await_file "$dir/sleep.pid" 200; then
        fail "$slot / stall wrapper" "never reached the copy stage"
      fi
      kill -"$winner" "$driver" 2> /dev/null || true
      if ! await_file "$dir/term.marker" 200; then
        fail "$slot / terminating window" "the worker group never saw TERM"
      fi
      if [ "$loser" != "-" ]; then
        kill -"$loser" "$driver" 2> /dev/null || true
      fi
      ;;
    handler)
      if ! await_file "$dir/sleep.pid" 200; then
        fail "$slot / stall wrapper" "never reached the copy stage"
      fi
      kill -"$winner" "$driver" 2> /dev/null || true
      spins=0
      while ! grep -q CALLER-TRAP-TERM "$out" 2> /dev/null; do
        if [ "$spins" -ge 200 ]; then
          fail "$slot / winner handler" "never started"
          break
        fi
        sleep 0.05
        spins=$((spins + 1))
      done
      if [ "$loser" != "-" ]; then
        kill -"$loser" "$driver" 2> /dev/null || true
      fi
      ;;
    storm)
      if ! await_file "$dir/sleep.pid" 200; then
        fail "$slot / stall wrapper" "never reached the copy stage"
      fi
      kill -"$winner" "$driver" 2> /dev/null || true
      bursts=0
      while [ "$bursts" -lt 400 ]; do
        kill -"$loser" "$driver" 2> /dev/null || break
        bursts=$((bursts + 1))
      done
      ;;
    postworker)
      # worker 已经正常结束，快照验证与取值复制都做完了，实现正卡在删除快照的
      # `rm` 上。信号必须仍然由**实现**接管：否则它会按调用方的处置立刻退出，
      # 而快照还在磁盘上。
      if ! await_file "$rm_marker" 200; then
        fail "$slot / postworker window" "the snapshot removal never started"
      fi
      kill -"$winner" "$driver" 2> /dev/null || true
      sleep 0.2
      : > "${rm_marker}.release"
      ;;
    none)
      if [ "$stall" = "yes" ]; then
        if ! await_file "$dir/sleep.pid" 200; then
          fail "$slot / stall wrapper" "never reached the copy stage"
        fi
        if [ "$winner" != "-" ]; then
          kill -"$winner" "$driver" 2> /dev/null || true
        fi
      fi
      ;;
  esac

  wait "$driver" 2> /dev/null
  case_status=$?
  kill -KILL "$watchdog" 2> /dev/null || true
  wait "$watchdog" 2> /dev/null || true

  if [ -e "$dir/watchdog.fired" ]; then
    fail "$slot / watchdog" "the case had to be killed after ${meal_agent_case_watchdog_seconds}s"
  fi

  # --- 断言先做，清理后做 ---------------------------------------------------
  # 下面这一段读的是「实现留下的事实」。任何 kill 都必须排在它后面，否则断言通过
  # 只能证明**测试自己**把进程收掉了。
  local head worker sleeper leftover="" pid=""
  head="$(cat "$dir/head.pid" 2> /dev/null || echo 0)"
  worker="$(cat "$dir/worker.pid" 2> /dev/null || echo 0)"
  sleeper="$(cat "$dir/sleep.pid" 2> /dev/null || echo 0)"
  if [ "$stall" = "yes" ]; then
    for pid in "$worker" "$head" "$sleeper"; do
      if [ "$pid" != "0" ] && ! await_gone "$pid" 60; then
        leftover="$leftover $pid"
      fi
    done
    check "$slot / controlled subtree gone" "" "$leftover"
  fi
  local residue=""
  residue="$(ls -1 "$dir" 2> /dev/null | grep '^meal-agent-secret\.' || true)"
  check "$slot / no snapshot residue" "" "$residue"
  absent "$slot / no sentinel in output" "$out" "SENTINEL"
  contains "$slot / caller EXIT trap chained" "$out" "CALLER-EXIT-MARKER"

  # --- 兜底清理，只在断言之后 ----------------------------------------------
  kill -KILL -- "-$driver" 2> /dev/null || true
  if [ "$worker" != "0" ]; then
    kill -KILL -- "-$worker" 2> /dev/null || true
  fi
  for pid in "$head" "$sleeper"; do
    if [ "$pid" != "0" ]; then
      kill -KILL "$pid" 2> /dev/null || true
    fi
  done
}

echo "signal-matrix: $(bash --version | head -1), uid $(id -u), source $meal_agent_source"

# ---------------------------------------------------------------------------
# 1. 默认处置：以同一个信号死掉（128 + signo）
# ---------------------------------------------------------------------------
run_case default-term default yes none TERM -
check "default TERM / exit status" 143 "$case_status"
run_case default-int default yes none INT -
check "default INT / exit status" 130 "$case_status"
run_case default-hup default yes none HUP -
check "default HUP / exit status" 129 "$case_status"

# ---------------------------------------------------------------------------
# 2. 调用方 handler 自杀：它的退出码必须胜出
# ---------------------------------------------------------------------------
run_case exit-term exit yes none TERM -
check "caller-exit TERM / exit status" 71 "$case_status"
contains "caller-exit TERM / handler ran" "$work/exit-term/out" "CALLER-TRAP-TERM"
contains "caller-exit / chained EXIT sees rc" "$work/exit-term/out" "CALLER-EXIT-MARKER rc=71"
run_case exit-int exit yes none INT -
check "caller-exit INT / exit status" 72 "$case_status"
run_case exit-hup exit yes none HUP -
check "caller-exit HUP / exit status" 73 "$case_status"

# ---------------------------------------------------------------------------
# 3. 调用方 handler **返回**而不退出：实现必须 fail closed
# ---------------------------------------------------------------------------
run_case return-term return yes none TERM -
check "caller-return TERM / exit status" 2 "$case_status"
contains "caller-return TERM / handler ran" "$work/return-term/out" "CALLER-RETURN-TERM"
contains "caller-return TERM / fails closed" "$work/return-term/out" "interrupted by a signal"
absent "caller-return TERM / no RESOLVED" "$work/return-term/out" "RESOLVED"
contains "caller-return / chained EXIT sees rc" "$work/return-term/out" "CALLER-EXIT-MARKER rc=2"

# ---------------------------------------------------------------------------
# 4. 调用方 `trap '' SIG` 忽略：同样必须 fail closed
# ---------------------------------------------------------------------------
run_case ignore-term ignore yes none TERM -
check "caller-ignore TERM / exit status" 2 "$case_status"
contains "caller-ignore TERM / fails closed" "$work/ignore-term/out" "interrupted by a signal"
absent "caller-ignore TERM / no RESOLVED" "$work/ignore-term/out" "RESOLVED"

# ---------------------------------------------------------------------------
# 5. terminating 窗口 + first-wins。TERM 是 winner，HUP 在受控 head 确认收到 TERM
#    之后才发出，因此确定落在 TERM→KILL 之间
# ---------------------------------------------------------------------------
run_case first-wins-default default yes terminating TERM HUP
check "first-wins default / stays TERM" 143 "$case_status"
run_case first-wins-exit exit yes terminating TERM HUP
check "first-wins caller-exit / stays 71" 71 "$case_status"
contains "first-wins / winner handler ran" "$work/first-wins-exit/out" "CALLER-TRAP-TERM"
absent "first-wins / loser handler suppressed" "$work/first-wins-exit/out" "CALLER-TRAP-HUP"

# ---------------------------------------------------------------------------
# 6. loser 落在 winner 的调用方 handler 执行期间
# ---------------------------------------------------------------------------
run_case loser-during-handler slow-exit yes handler TERM HUP
check "loser during winner handler / stays 71" 71 "$case_status"
contains "loser during handler / winner finished" "$work/loser-during-handler/out" "CALLER-TRAP-TERM-DONE"
absent "loser during handler / loser suppressed" "$work/loser-during-handler/out" "CALLER-TRAP-HUP"

# ---------------------------------------------------------------------------
# 7. 重投窗口里的同名信号风暴：归还必须是原子的，中间不能出现 SIG_DFL
# ---------------------------------------------------------------------------
run_case redeliver-storm slow-exit yes storm TERM TERM
check "redelivery storm / caller handler still wins" 71 "$case_status"
contains "redelivery storm / winner finished" "$work/redeliver-storm/out" "CALLER-TRAP-TERM-DONE"

# ---------------------------------------------------------------------------
# 8. post-worker 窗口：worker 已结束、快照验证与取值复制已完成，正在删除快照。
#    信号 trap 必须一直保持到这一步做完——否则进程会按调用方处置立刻退出，
#    **而快照还在磁盘上**
# ---------------------------------------------------------------------------
run_case postworker-default default no postworker TERM -
check "post-worker TERM / exit status" 143 "$case_status"
run_case postworker-exit exit no postworker TERM -
check "post-worker TERM / caller handler wins" 71 "$case_status"
contains "post-worker / caller handler ran" "$work/postworker-exit/out" "CALLER-TRAP-TERM"
absent "post-worker / never claims success" "$work/postworker-exit/out" "RESOLVED"

# 这两条才是「trap 作用域」真正的判据。归还得太早时，落在这个窗口里的信号会命中
# 调用方的处置：`trap '' SIG` 直接丢弃、handler 返回后继续往下跑——两种情况下
# resolve 都会**照常成功**并打出 RESOLVED，也就是「被中断了却装作读到了」。
# trap 保持到快照删除完成之后，这里就只能 fail closed。
run_case postworker-ignore ignore no postworker TERM -
check "post-worker ignored TERM / fails closed" 2 "$case_status"
absent "post-worker ignored / no RESOLVED" "$work/postworker-ignore/out" "RESOLVED"
contains "post-worker ignored / says why" "$work/postworker-ignore/out" "interrupted by a signal"
run_case postworker-return return no postworker TERM -
check "post-worker returning handler / fails closed" 2 "$case_status"
absent "post-worker returning / no RESOLVED" "$work/postworker-return/out" "RESOLVED"
contains "post-worker returning / handler ran" "$work/postworker-return/out" "CALLER-RETURN-TERM"

# ---------------------------------------------------------------------------
# 9. 正常完成：口令解析成功，三个信号 trap 与 EXIT trap 全部归还
# ---------------------------------------------------------------------------
run_case normal exit no none - -
check "normal / exit status" 0 "$case_status"
contains "normal / secret resolved" "$work/normal/out" "RESOLVED 25"
contains "normal / chained EXIT sees rc" "$work/normal/out" "CALLER-EXIT-MARKER rc=0"
for fragment in 'exit 71' 'exit 72' 'exit 73'; do
  if sed -n '/TRAPS-AFTER-BEGIN/,/TRAPS-AFTER-END/p' "$work/normal/out" |
    grep -q "$fragment"; then
    pass "normal / signal trap restored" "$fragment"
  else
    fail "normal / signal trap restored" "$fragment missing"
  fi
done
if sed -n '/EXIT-TRAP-AFTER-BEGIN/,/EXIT-TRAP-AFTER-END/p' "$work/normal/out" |
  grep -q 'CALLER-EXIT-MARKER'; then
  pass "normal / EXIT trap handed back" "caller command restored"
else
  fail "normal / EXIT trap handed back" "caller EXIT trap was not restored"
fi
if sed -n '/EXIT-TRAP-AFTER-BEGIN/,/EXIT-TRAP-AFTER-END/p' "$work/normal/out" |
  grep -q 'meal_agent_run_exit_trap'; then
  fail "normal / EXIT trap handed back" "our chained handler is still installed"
else
  pass "normal / EXIT trap handed back" "no leftover meal_agent handler"
fi

echo "signal-matrix: $checks checks, $failures failure(s)"
[ "$failures" -eq 0 ]
