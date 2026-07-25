import type {
  AppRoute,
  HttpRequest,
  HttpResponse,
  PlatformAdapter
} from '../../src/platform/ports'

export interface RecordedNavigation {
  readonly kind: 'reLaunch' | 'navigateTo' | 'navigateBack'
  readonly route?: AppRoute
}

type ResponseScript = HttpResponse | Error | Promise<HttpResponse>

/** Node 测试用的确定性平台适配器：请求按脚本应答并全程留痕。 */
export class FakePlatform implements PlatformAdapter {
  public readonly sentRequests: HttpRequest[] = []
  public readonly navigations: RecordedNavigation[] = []
  public readonly storageMap = new Map<string, unknown>()
  public loginCodeQueue: string[] = []
  public currentTimeMs = Date.parse('2026-07-24T08:00:00.000Z')

  private readonly responseQueue: ResponseScript[] = []
  private fallbackResponder:
    | ((request: HttpRequest) => ResponseScript)
    | undefined
  private tokenCounter = 0

  public enqueueResponse(response: ResponseScript): void {
    this.responseQueue.push(response)
  }

  public respondWith(
    responder: (request: HttpRequest) => ResponseScript
  ): void {
    this.fallbackResponder = responder
  }

  public enqueueJson(statusCode: number, body: unknown): void {
    this.enqueueResponse({ statusCode, body: JSON.stringify(body) })
  }

  public get lastRequest(): HttpRequest {
    const request = this.sentRequests.at(-1)
    if (request === undefined) {
      throw new Error('no request was sent')
    }
    return request
  }

  public readonly auth = {
    getLoginCode: async (): Promise<string> => {
      const code = this.loginCodeQueue.shift()
      return code ?? `fake-login-code-${this.sentRequests.length}`
    }
  }

  public readonly network = {
    request: async (request: HttpRequest): Promise<HttpResponse> => {
      this.sentRequests.push(request)
      const scripted =
        this.responseQueue.shift() ?? this.fallbackResponder?.(request)
      if (scripted === undefined) {
        throw new Error(
          `no scripted response for ${request.method} ${request.url}`
        )
      }
      if (scripted instanceof Error) {
        throw scripted
      }
      return await scripted
    }
  }

  public readonly storage = {
    get: (key: string): unknown => this.storageMap.get(key),
    set: (key: string, value: unknown): void => {
      this.storageMap.set(key, value)
    },
    remove: (key: string): void => {
      this.storageMap.delete(key)
    }
  }

  public readonly navigation = {
    reLaunch: async (route: AppRoute): Promise<void> => {
      this.navigations.push({ kind: 'reLaunch', route })
    },
    navigateTo: async (route: AppRoute): Promise<void> => {
      this.navigations.push({ kind: 'navigateTo', route })
    },
    navigateBack: async (): Promise<void> => {
      this.navigations.push({ kind: 'navigateBack' })
    }
  }

  public readonly runtime = {
    nowMs: (): number => this.currentTimeMs,
    randomToken: (): string => {
      this.tokenCounter += 1
      return `fake-token-${String(this.tokenCounter).padStart(6, '0')}`
    }
  }
}
