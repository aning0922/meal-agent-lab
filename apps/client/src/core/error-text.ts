import type { ApiError } from '@meal-agent/contracts/api'

const CODE_TEXT: Partial<Record<ApiError['code'], string>> = {
  VALIDATION_FAILED: '提交内容未通过服务端校验，请检查后重试。',
  AUTHENTICATION_REQUIRED: '需要登录后才能继续。',
  SESSION_EXPIRED: '会话已过期，请重新登录。',
  FORBIDDEN: '当前身份没有权限执行此操作。',
  RESOURCE_NOT_FOUND: '资源不存在或不可访问。',
  CONFLICT: '操作与当前状态冲突，请刷新后重试。',
  IDEMPOTENCY_KEY_REUSED: '相同的幂等键已用于不同请求，请重新发起操作。',
  INVENTORY_VERSION_CONFLICT: '批次刚被其他成员更新，已为你刷新最新状态。',
  INVENTORY_INSUFFICIENT: '批次剩余数量不足，无法完成本次消耗。',
  SAFETY_BLOCKED: '该操作被食品安全规则阻止。',
  RATE_LIMITED: '操作过于频繁，请稍后重试。',
  EXTERNAL_DEPENDENCY_UNAVAILABLE: '依赖服务暂时不可用，请稍后重试。',
  INTERNAL_ERROR: '服务内部错误，请稍后重试。'
}

/** problem+json → 用户可读文案；未覆盖的 code 回退到服务端 title。 */
export const describeApiError = (error: ApiError): string =>
  CODE_TEXT[error.code] ?? `${error.title}（${error.code}）`

export const TRANSPORT_ERROR_TEXT =
  '网络连接失败，本次操作未确认完成；请检查网络后重试。'

export const MALFORMED_RESPONSE_TEXT =
  '服务响应不符合契约，已停止本次操作；请稍后重试或升级客户端。'
