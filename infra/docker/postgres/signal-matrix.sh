#!/usr/bin/env bash
#
# 阶段 09A / M3A：`secret-source.sh` 信号状态机的精简矩阵。
#
#   usage: signal-matrix.sh <path-to-secret-source.sh>
#
# 它是**门禁的载荷**，不是文档示例：`tests/unit/bootstrap-secret-source-container
# .test.ts` 会把它放进钉住 digest 的 `postgres:18.4-bookworm` 里以 uid 999 跑一遍，
# 因此 macOS/bash 3.2 与 Debian/bash 5.2 两侧用的是**同一份**断言。
#
# 覆盖的维度：
#
#   调用方处置   default（默认处置）、exit（handler 自杀）、return（handler 返回
#                但不退出）、ignore（`trap '' SIG`）
#   信号         TERM / INT / HUP
#   投递窗口     none（worker 运行中）、starting（trap 已装、worker 未起）、
#                terminating（TERM 已发、KILL 未发）
#   并发裁决     first-wins：winner 在 terminating 窗口里再收一个 loser
#   EXIT trap    调用方原有的 EXIT trap 必须**链式执行**，不能被换掉
#
# 窗口投递是**确定的**：实现在进入窗口时创建 marker 文件并有界等待 release 文件，
# 本脚本据此投递，而不是 sleep 一个固定毫秒数然后但愿它落对地方。
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
trap 'rm -rf -- "$work"' EXIT
umask 077

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

# 受控的 stall wrapper：第一次调用时接管 `head`，忽略三个信号，派生一个同样忽略
# 信号的孙进程，并持有一个真实 FIFO 的读端。忽略在 fork **之前**设好，孙进程因此
# 继承 SIG_IGN——「TERM 就够了」这条捷径被堵死，只有对整个进程组补 KILL 才收得掉。
mkdir -p "$work/bin"
cat > "$work/bin/head" << 'WRAPPER'
#!/usr/bin/env bash
set -u
if [ ! -e "$MEAL_AGENT_MATRIX_MARKER" ]; then
  : > "$MEAL_AGENT_MATRIX_MARKER"
  trap '' TERM INT HUP
  printf '%s' "$$" > "$MEAL_AGENT_MATRIX_HEAD"
  printf '%s' "$PPID" > "$MEAL_AGENT_MATRIX_WORKER"
  exec 7<> "$MEAL_AGENT_MATRIX_FIFO"
  sleep 600 &
  printf '%s' "$!" > "$MEAL_AGENT_MATRIX_SLEEP"
  wait
  exit 0
fi
exec /usr/bin/head "$@"
WRAPPER
chmod 755 "$work/bin/head"

# 调用方驱动脚本。`DISPOSITION` 决定它给 TERM/INT/HUP 装什么；EXIT trap 永远装，
# 因为「调用方的 EXIT trap 必须链式执行」是每个用例都要验的。
cat > "$work/driver.sh" << 'DRIVER'
#!/usr/bin/env bash
set -u
trap 'echo CALLER-EXIT-MARKER >&2' EXIT
case "$DISPOSITION" in
  default) ;;
  exit)
    trap 'echo CALLER-TRAP-TERM >&2; exit 71' TERM
    trap 'echo CALLER-TRAP-INT >&2; exit 72' INT
    trap 'echo CALLER-TRAP-HUP >&2; exit 73' HUP
    ;;
  slow-exit)
    # winner 的 handler 故意跑得慢一点，好让 loser 确定地落在「winner 已开始
    # 处理、还没退出」这一段里。
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
  # $1 = path, $2 = ticks (0.05s each). 返回 0 表示出现了。
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

# ---------------------------------------------------------------------------
# 一个用例
# ---------------------------------------------------------------------------
# run_case <slot> <disposition> <stall:yes|no> <window:none|starting|terminating>
#          <winner|-> <loser|->
run_case() {
  local slot="$1" disposition="$2" stall="$3" window="$4" winner="$5" loser="$6"
  local dir="$work/$slot"
  local markers="$dir/markers"
  mkdir -p "$dir" "$markers"
  local out="$dir/out"
  local fifo="$dir/fifo"
  mkfifo "$fifo"

  local path="$PATH"
  if [ "$stall" = "yes" ]; then
    path="$work/bin:$PATH"
  fi
  local marker_dir=""
  if [ "$window" != "none" ]; then
    marker_dir="$markers"
  fi

  set -m
  env PATH="$path" TMPDIR="$dir" \
    DISPOSITION="$disposition" \
    MEAL_AGENT_MATRIX_SOURCE="$meal_agent_source" \
    MEAL_AGENT_MATRIX_MARKER="$dir/stall.marker" \
    MEAL_AGENT_MATRIX_HEAD="$dir/head.pid" \
    MEAL_AGENT_MATRIX_WORKER="$dir/worker.pid" \
    MEAL_AGENT_MATRIX_SLEEP="$dir/sleep.pid" \
    MEAL_AGENT_MATRIX_FIFO="$fifo" \
    MEAL_AGENT_SECRET_WINDOW_MARKER_DIR="$marker_dir" \
    MEAL_AGENT_RUNTIME_PASSWORD_FILE="$work/secret" \
    bash "$work/driver.sh" > "$out" 2>&1 &
  local driver=$!
  set +m

  case "$window" in
    starting)
      # 确定地落进 starting：实现在装完 trap、起 worker **之前**创建 marker 并
      # 等 release。收到 marker 才发信号，发完再放行。
      if await_file "$markers/starting" 200; then
        [ "$winner" != "-" ] && kill -"$winner" "$driver" 2> /dev/null
        [ "$loser" != "-" ] && kill -"$loser" "$driver" 2> /dev/null
      else
        fail "$slot / starting marker" "never appeared"
      fi
      : > "$markers/starting.release"
      ;;
    terminating)
      # 先等 worker 真的跑起来（三层 PID 齐全），发 winner 触发清理；实现进入
      # terminating 时创建 marker，此时再发 loser，然后放行。
      if ! await_file "$dir/sleep.pid" 200; then
        fail "$slot / stall wrapper" "never reached the copy stage"
      fi
      kill -"$winner" "$driver" 2> /dev/null
      if ! await_file "$markers/terminating" 200; then
        fail "$slot / terminating marker" "never appeared"
      fi
      [ "$loser" != "-" ] && kill -"$loser" "$driver" 2> /dev/null
      : > "$markers/terminating.release"
      ;;
    handler)
      # 确定地落进「winner 的调用方 handler 正在跑」那一段：等它把自己的 marker
      # 打出来，再发 loser。这正是上一轮「先恢复全部 trap、再重投 winner」留下的
      # 竞态窗口——那时 loser 会命中调用方的 HUP handler，退出码由 loser 决定。
      if ! await_file "$dir/sleep.pid" 200; then
        fail "$slot / stall wrapper" "never reached the copy stage"
      fi
      kill -"$winner" "$driver" 2> /dev/null
      local spins=0
      while ! grep -q CALLER-TRAP-TERM "$out" 2> /dev/null; do
        if [ "$spins" -ge 200 ]; then
          fail "$slot / winner handler" "never started"
          break
        fi
        sleep 0.05
        spins=$((spins + 1))
      done
      [ "$loser" != "-" ] && kill -"$loser" "$driver" 2> /dev/null
      ;;
    none)
      if [ "$stall" = "yes" ]; then
        if ! await_file "$dir/sleep.pid" 200; then
          fail "$slot / stall wrapper" "never reached the copy stage"
        fi
        [ "$winner" != "-" ] && kill -"$winner" "$driver" 2> /dev/null
      fi
      ;;
  esac

  wait "$driver" 2> /dev/null
  case_status=$?

  # --- 断言先做，清理后做 ---------------------------------------------------
  # 下面这一段读的是「实现留下的事实」。任何 kill 都必须排在它后面，否则断言
  # 通过只能证明**测试自己**把进程收掉了。
  local head worker sleeper leftover=""
  head="$(cat "$dir/head.pid" 2> /dev/null || echo 0)"
  worker="$(cat "$dir/worker.pid" 2> /dev/null || echo 0)"
  sleeper="$(cat "$dir/sleep.pid" 2> /dev/null || echo 0)"
  if [ "$stall" = "yes" ] && [ "$window" != "starting" ]; then
    local pid=""
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
run_case exit-int exit yes none INT -
check "caller-exit INT / exit status" 72 "$case_status"
run_case exit-hup exit yes none HUP -
check "caller-exit HUP / exit status" 73 "$case_status"

# ---------------------------------------------------------------------------
# 3. 调用方 handler **返回**而不退出：实现必须 fail closed，不能假装读到了口令
# ---------------------------------------------------------------------------
run_case return-term return yes none TERM -
check "caller-return TERM / exit status" 2 "$case_status"
contains "caller-return TERM / handler ran" "$work/return-term/out" "CALLER-RETURN-TERM"
contains "caller-return TERM / fails closed" "$work/return-term/out" "interrupted by a signal"
absent "caller-return TERM / no RESOLVED" "$work/return-term/out" "RESOLVED"

# ---------------------------------------------------------------------------
# 4. 调用方 `trap '' SIG` 忽略：同样必须 fail closed
# ---------------------------------------------------------------------------
run_case ignore-term ignore yes none TERM -
check "caller-ignore TERM / exit status" 2 "$case_status"
contains "caller-ignore TERM / fails closed" "$work/ignore-term/out" "interrupted by a signal"
absent "caller-ignore TERM / no RESOLVED" "$work/ignore-term/out" "RESOLVED"

# ---------------------------------------------------------------------------
# 5. starting 窗口：trap 已装、worker 未起。信号既不能丢，也不能按默认处置把
#    父进程带走并留下孤儿
# ---------------------------------------------------------------------------
run_case starting-default default yes starting TERM -
check "starting-window TERM / exit status" 143 "$case_status"
run_case starting-exit exit yes starting HUP -
check "starting-window HUP / caller exit" 73 "$case_status"

# ---------------------------------------------------------------------------
# 6. terminating 窗口 + first-wins：TERM 是 winner，HUP 确定地落在 TERM→KILL
#    之间。裁决是先到者胜，所以退出语义仍然是 TERM 那一条
# ---------------------------------------------------------------------------
run_case first-wins-default default yes terminating TERM HUP
check "first-wins default / stays TERM" 143 "$case_status"
run_case first-wins-exit exit yes terminating TERM HUP
check "first-wins caller-exit / stays 71" 71 "$case_status"
contains "first-wins / winner handler ran" "$work/first-wins-exit/out" "CALLER-TRAP-TERM"
absent "first-wins / loser handler suppressed" "$work/first-wins-exit/out" "CALLER-TRAP-HUP"

# ---------------------------------------------------------------------------
# 6b. loser 落在 winner 的调用方 handler 执行期间。上一轮先把**全部**三个 trap
#     还回去再重投 winner，因此这里的 HUP 会命中调用方的 HUP handler，退出码变成
#     73——first-wins 只是概率性的。现在 loser 一直被抑制到 winner 投递完成
# ---------------------------------------------------------------------------
run_case loser-during-handler slow-exit yes handler TERM HUP
check "loser during winner handler / stays 71" 71 "$case_status"
contains "loser during handler / winner finished" "$work/loser-during-handler/out" "CALLER-TRAP-TERM-DONE"
absent "loser during handler / loser suppressed" "$work/loser-during-handler/out" "CALLER-TRAP-HUP"

# ---------------------------------------------------------------------------
# 7. 正常完成：口令解析成功，三个信号 trap 与 EXIT trap 全部归还
# ---------------------------------------------------------------------------
run_case normal exit no none - -
check "normal / exit status" 0 "$case_status"
contains "normal / secret resolved" "$work/normal/out" "RESOLVED 25"
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
