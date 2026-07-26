#!/usr/bin/env node
//
// 阶段 09A / M2A：可移植的「无控制终端」包装器。
//
// psql 的 `\password` 使用 simple_prompt()，它**先尝试打开 /dev/tty**，只有打开
// 失败才回落到 stdin。因此在有控制终端的交互式 shell 里，用管道把口令喂给
// `\password` 会永久阻塞且没有任何错误输出。
//
// Linux 上可以用 util-linux 的 `setsid` 脱离控制终端，但 macOS 不带 `setsid`。
// 本包装器用 Node 自带能力做同一件事：POSIX 上 `spawn(..., { detached: true })`
// 会在子进程中调用 setsid(2)，于是子进程进入新会话、没有控制终端，
// `\password` 的 /dev/tty 打开失败并回落到 stdin。
//
// 它只依赖 Node 标准库，不引入任何第三方依赖，也不实现任何口令算法：
// SCRAM verifier 仍由 psql 在客户端生成。
//
// 用法：
//   printf '%s\n%s\n' "$PW" "$PW" | node no-ctty.mjs psql --dbname db -c '\password role'
//
// 退出码与信号都真实透传：子进程处于**新的进程组**，调用方发给本进程组的信号
// 不会自动到达它，因此这里显式转发 SIGINT/SIGTERM/SIGHUP；子进程被信号终止时，
// 本进程用同一信号自杀，让调用方看到真实的终止原因而不是一个普通退出码。

import { spawn } from "node:child_process";

const [, , command, ...args] = process.argv;

if (command === undefined) {
  process.stderr.write("no-ctty: usage: no-ctty.mjs <command> [args...]\n");
  process.exit(2);
}

// stdio 直接继承：子进程拿到调用方原本的 stdin（口令来源），不经过 Node 层的
// 异步转发，也不经过命令行或环境变量。继承文件描述符不会重新获得控制终端——
// 控制终端属于会话，而 detached 已经让子进程进入新会话。
const child = spawn(command, args, {
  // POSIX: 让子进程成为新会话的首进程，从而失去控制终端。
  detached: true,
  stdio: "inherit",
});

child.on("error", (error) => {
  process.stderr.write(`no-ctty: failed to run ${command}: ${error.message}\n`);
  process.exit(127);
});

const forwarded = ["SIGINT", "SIGTERM", "SIGHUP"];
const forward = (signal) => {
  try {
    process.kill(child.pid, signal);
  } catch {
    // 子进程可能已经退出；忽略。
  }
};
for (const signal of forwarded) {
  process.on(signal, () => forward(signal));
}

child.on("exit", (code, signal) => {
  if (signal !== null) {
    // 恢复默认处置后用同一信号自杀，真实传播终止原因。
    for (const name of forwarded) {
      process.removeAllListeners(name);
    }
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
