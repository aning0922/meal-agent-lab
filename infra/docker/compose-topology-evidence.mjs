// 阶段 09A：resolved Compose 结构的纯函数投影。CLI checker 与纯 Node 回归共用；
// 这里不运行 Docker，也不接受任何外部诊断文本。

export const isResolvedServiceRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const resolvedHealthcheckProjection = (value) => {
  if (!isResolvedServiceRecord(value)) return null
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
    !isResolvedServiceRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['condition', 'required']) ||
    value.required !== true ||
    value.restart !== undefined
  ) {
    return null
  }
  return value.condition
}
