// 阶段 09A：resolved Compose 结构的纯函数投影。CLI checker 与纯 Node 回归共用；
// 这里不运行 Docker，也不接受任何外部诊断文本。

export const isResolvedServiceRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const sameKeys = (value, expected) =>
  isResolvedServiceRecord(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())

/**
 * Compose JSON 是外部证据。这里只接受一个具有四个结构化主 section 与非空 name
 * 的文档；调用方仍负责逐项闭合这些 section 的能力字段。失败只返回 null，绝不把
 * JSON、异常或调用方内容带进诊断。
 */
export const parseResolvedComposeDocument = (text) => {
  if (typeof text !== 'string' || text.length === 0 || text.trim() === '') return null
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (
    !isResolvedServiceRecord(value) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    !isResolvedServiceRecord(value.services) ||
    !isResolvedServiceRecord(value.networks) ||
    !isResolvedServiceRecord(value.volumes) ||
    !isResolvedServiceRecord(value.secrets)
  ) {
    return null
  }
  return value
}

export const resolvedHealthcheckProjection = (value) => {
  if (
    !sameKeys(value, [
      'test',
      'interval',
      'timeout',
      'retries',
      'start_period',
      'start_interval',
      'disable'
    ].filter((key) => value?.[key] !== undefined))
  ) return null
  const allowed = new Set([
    'test',
    'interval',
    'timeout',
    'retries',
    'start_period',
    'start_interval',
    'disable'
  ])
  if (Object.keys(value).some((key) => !allowed.has(key))) return null
  return {
    test: value.test ?? null,
    interval: value.interval ?? null,
    timeout: value.timeout ?? null,
    retries: value.retries ?? null,
    start_period: value.start_period ?? null,
    start_interval: value.start_interval ?? null,
    disable: value.disable ?? null
  }
}

export const resolvedDependencyProjection = (value) => {
  if (
    !sameKeys(value, ['condition', 'required']) ||
    value.required !== true ||
    value.restart !== undefined
  ) {
    return null
  }
  return value.condition
}
