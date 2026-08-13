#!/usr/bin/env node
//
// stage09a 聚合门禁的直接 step controller。
//
// 聚合器只把这个 controller 作为直接、detached 的进程组组长。实际门禁命令
// 与 controller 留在同一进程组；controller 独占持有 ownership fd，并且只在
// 实际命令 close 之后写出一条完整的 PRODUCER DONE 帧。这样聚合器不需要用
// pipe EOF 与 leader exit 的事件先后顺序猜测「producer 是否已经结束」。
import { spawn } from 'node:child_process'
import { writeSync } from 'node:fs'

const ownershipFd = 3
const heldSignals = ['SIGINT', 'SIGTERM', 'SIGHUP']
const holdSignalUntilChildSettles = () => undefined
for (const signal of heldSignals) {
  process.on(signal, holdSignalUntilChildSettles)
}

const writeFrame = (frame) => {
  const bytes = Buffer.from(frame, 'utf8')
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(ownershipFd, bytes, offset, bytes.length - offset)
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('ownership frame write did not make progress')
    }
    offset += written
  }
}

const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

let argv
try {
  argv = JSON.parse(process.argv[2] ?? '')
} catch {
  fail('stage09a step controller received an invalid command', 2)
}
if (!Array.isArray(argv) || argv.length === 0 || argv.some((item) => typeof item !== 'string')) {
  fail('stage09a step controller received an invalid command', 2)
}

const child = spawn(argv[0], argv.slice(1), {
  detached: false,
  env: {
    ...process.env,
    MEAL_AGENT_STAGE09A_PGID_FD: String(ownershipFd)
  },
  stdio: ['inherit', 'inherit', 'inherit', ownershipFd]
})

let finished = false
const finish = (code, signal, startFailed = false) => {
  if (finished) return
  finished = true
  try {
    writeFrame(`PRODUCER ${String(process.pid)} DONE\n`)
  } catch {
    fail('stage09a step controller could not close the ownership protocol')
  }
  for (const heldSignal of heldSignals) {
    process.removeListener(heldSignal, holdSignalUntilChildSettles)
  }
  if (startFailed) {
    fail('stage09a step controller failed to start the command', 127)
  }
  if (signal !== null) {
    try {
      process.kill(process.pid, signal)
    } catch {
      fail('stage09a step controller could not preserve the child signal')
    }
    return
  }
  process.exit(Number.isInteger(code) ? code : 1)
}

child.once('error', () => finish(null, null, true))
child.once('close', (code, signal) => finish(code, signal))
