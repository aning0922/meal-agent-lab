import type { AppServices } from './app-services'
import {
  describeApiError,
  MALFORMED_RESPONSE_TEXT,
  TRANSPORT_ERROR_TEXT
} from './error-text'

export type SignInResult =
  | { readonly kind: 'success' }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

/** 登录：取平台 login code → 兑换会话 → 持久化。失败不写入任何会话。 */
export const signIn = async (
  services: AppServices
): Promise<SignInResult> => {
  let loginCode: string
  try {
    loginCode = await services.adapter.auth.getLoginCode()
  } catch {
    return {
      kind: 'failed',
      message: '获取微信登录凭证失败，请重试。',
      retryable: true
    }
  }

  const outcome = await services.api.exchangeWechatLogin({ loginCode })
  switch (outcome.kind) {
    case 'success':
      services.session.save(outcome.data)
      return { kind: 'success' }
    case 'apiError':
      return {
        kind: 'failed',
        message: describeApiError(outcome.error),
        retryable: outcome.error.retryable
      }
    case 'transportError':
      return {
        kind: 'failed',
        message: TRANSPORT_ERROR_TEXT,
        retryable: true
      }
    case 'malformedResponse':
      return {
        kind: 'failed',
        message: MALFORMED_RESPONSE_TEXT,
        retryable: false
      }
  }
}

/**
 * 登出：先尽力撤销服务端会话，无论结果如何都清除本地会话，
 * 保证本地不会残留一个用户已放弃的登录态。
 */
export const signOut = async (services: AppServices): Promise<void> => {
  try {
    await services.api.revokeSession()
  } finally {
    services.session.clear()
  }
}
