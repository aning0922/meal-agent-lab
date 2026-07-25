import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const listed = spawnSync('rg', ['--files', '-g', '*.md'], {
  cwd: root,
  encoding: 'utf8'
})
if (listed.error !== undefined || listed.status !== 0) {
  process.stderr.write(`markdown link check failed: ${listed.stderr}\n`)
  process.exit(1)
}

const files = listed.stdout.trim().split('\n').filter(Boolean).sort()
const failures = []
let checkedLinks = 0
const inlineLink = /!?\[[^\]]*]\((<[^>]+>|[^)\s]+)(?:\s+["'][^)]*)?\)/g

for (const file of files) {
  const absoluteFile = resolve(root, file)
  const text = readFileSync(absoluteFile, 'utf8')
  for (const match of text.matchAll(inlineLink)) {
    const rawTarget = match[1]?.replace(/^<|>$/g, '')
    if (
      rawTarget === undefined ||
      rawTarget === '' ||
      rawTarget.startsWith('#') ||
      /^(?:https?:|mailto:|tel:|data:)/i.test(rawTarget)
    ) {
      continue
    }
    checkedLinks += 1
    const pathOnly = decodeURIComponent(rawTarget.split('#', 1)[0] ?? '')
    if (pathOnly === '') continue
    const target = pathOnly.startsWith('/')
      ? resolve(root, `.${pathOnly}`)
      : resolve(dirname(absoluteFile), pathOnly)
    if (!target.startsWith(`${root}/`) && target !== root) {
      failures.push(`${file}: link escapes repository: ${rawTarget}`)
      continue
    }
    if (!existsSync(target)) {
      failures.push(`${file}: missing target: ${rawTarget}`)
      continue
    }
    if (rawTarget.endsWith('/') && !statSync(target).isDirectory()) {
      failures.push(`${file}: expected directory target: ${rawTarget}`)
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(
  `Markdown local link check PASS (${files.length} files, ${checkedLinks} local links)\n`
)
