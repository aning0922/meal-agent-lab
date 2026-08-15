// 阶段 09A 聚合门禁的前置工具成功证据。只返回固定类别或经过闭集文法验证的
// 单行版本；绝不 trim/截取任意外部 stdout 后直接打印。

const patterns = Object.freeze({
  'Docker daemon': /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){1,3}(?:[-+][A-Za-z0-9.-]+)?$/,
  'Docker Compose v2': /^v?(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){1,3}(?:[-+][A-Za-z0-9.-]+)?$/,
  git: /^git version (?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){1,3}(?:[-+][A-Za-z0-9.-]+)?$/,
  pnpm: /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){1,3}(?:[-+][A-Za-z0-9.-]+)?$/
})

export const interpretPrerequisiteEvidence = (label, result) => {
  if (result?.ok !== true) {
    return { ok: false, detail: 'prerequisite command failed' }
  }
  const raw = result.stdout
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 256) {
    return { ok: false, detail: 'prerequisite evidence was invalid' }
  }
  const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  const pattern = patterns[label]
  if (pattern === undefined || /[\r\n]/.test(value) || !pattern.test(value)) {
    return { ok: false, detail: 'prerequisite evidence was invalid' }
  }
  return { ok: true, detail: value }
}
