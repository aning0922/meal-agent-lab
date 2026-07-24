import {
  apiErrorSchema,
  type ApiError,
  type ApiMeta
} from '@meal-agent/contracts/api'
import type { z } from 'zod'

import type { HttpMethod, NetworkPort } from '../platform/ports'

/**
 * 所有响应经 @meal-agent/contracts 的 zod 模式校验后才交给页面。
 * 四种结局互斥：成功、契约内错误（problem+json）、传输失败、响应不合契约。
 */
export type ApiOutcome<Data> =
  | {
      readonly kind: 'success'
      readonly data: Data
      readonly meta: ApiMeta
      readonly statusCode: number
    }
  | { readonly kind: 'apiError'; readonly error: ApiError }
  | { readonly kind: 'transportError'; readonly message: string }
  | { readonly kind: 'malformedResponse'; readonly message: string }

interface SuccessEnvelope {
  readonly ok: true
  readonly data: unknown
  readonly meta: ApiMeta
}

export interface ApiRequestSpec<Envelope extends SuccessEnvelope> {
  readonly method: HttpMethod
  readonly path: string
  readonly envelope: z.ZodType<Envelope>
  readonly query?: Readonly<
    Record<string, string | number | undefined>
  >
  readonly body?: unknown
  readonly idempotencyKey?: string
}

export interface ApiClientOptions {
  readonly baseUrl: string
  readonly network: NetworkPort
  readonly getAccessToken: () => string | undefined
  /** 收到 401（未认证 / 会话过期）时触发，由组合根清理会话并引导重新登录。 */
  readonly onUnauthorized: (error: ApiError) => void
}

const buildQueryString = (
  query: Readonly<Record<string, string | number | undefined>>
): string => {
  const parts = Object.entries(query)
    .filter(
      (entry): entry is [string, string | number] =>
        entry[1] !== undefined
    )
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
    )
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}

export class ApiClient {
  public constructor(private readonly options: ApiClientOptions) {}

  public async call<Envelope extends SuccessEnvelope>(
    spec: ApiRequestSpec<Envelope>
  ): Promise<ApiOutcome<Envelope['data']>> {
    const headers: Record<string, string> = {
      accept: 'application/json'
    }
    const accessToken = this.options.getAccessToken()
    if (accessToken !== undefined) {
      headers['authorization'] = `Bearer ${accessToken}`
    }
    if (spec.idempotencyKey !== undefined) {
      headers['idempotency-key'] = spec.idempotencyKey
    }

    let body: string | undefined
    if (spec.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(spec.body)
    }

    let response
    try {
      response = await this.options.network.request({
        method: spec.method,
        url: `${this.options.baseUrl}${spec.path}${buildQueryString(
          spec.query ?? {}
        )}`,
        headers,
        ...(body === undefined ? {} : { body })
      })
    } catch (error) {
      return {
        kind: 'transportError',
        message: error instanceof Error ? error.message : String(error)
      }
    }

    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(response.body)
    } catch {
      return {
        kind: 'malformedResponse',
        message: `HTTP ${response.statusCode} 响应不是合法 JSON`
      }
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      const parsed = spec.envelope.safeParse(parsedBody)
      if (!parsed.success) {
        return {
          kind: 'malformedResponse',
          message: `HTTP ${response.statusCode} 成功响应不符合契约`
        }
      }
      return {
        kind: 'success',
        data: parsed.data.data,
        meta: parsed.data.meta,
        statusCode: response.statusCode
      }
    }

    const parsedError = apiErrorSchema.safeParse(parsedBody)
    if (!parsedError.success) {
      return {
        kind: 'malformedResponse',
        message: `HTTP ${response.statusCode} 错误响应不符合 problem+json 契约`
      }
    }

    // 只有携带了本地会话凭证的请求，其 401 才代表"会话失效需重新登录"；
    // 登录兑换自身或无凭证请求的 401 走普通错误路径，由页面原地展示。
    if (
      accessToken !== undefined &&
      (parsedError.data.code === 'AUTHENTICATION_REQUIRED' ||
        parsedError.data.code === 'SESSION_EXPIRED')
    ) {
      this.options.onUnauthorized(parsedError.data)
    }

    return { kind: 'apiError', error: parsedError.data }
  }
}
