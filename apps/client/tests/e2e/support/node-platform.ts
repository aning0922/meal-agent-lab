import type {
  AppRoute,
  HttpRequest,
  HttpResponse,
  PlatformAdapter
} from '../../../src/platform/ports'

export interface RecordedNavigation {
  readonly kind: 'reLaunch' | 'navigateTo' | 'navigateBack'
  readonly route?: AppRoute
}

/**
 * E2E 用平台适配器：网络走真实 HTTP（fetch）打到本地 services/api，
 * 存储/导航/登录凭证仍为可观测的内存实现。
 */
export class NodePlatform implements PlatformAdapter {
  public readonly navigations: RecordedNavigation[] = []
  public readonly storageMap = new Map<string, unknown>()

  public constructor(private readonly loginCode: string) {}

  public readonly auth = {
    getLoginCode: async (): Promise<string> => this.loginCode
  }

  public readonly network = {
    request: async (request: HttpRequest): Promise<HttpResponse> => {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: 'manual'
      })
      return {
        statusCode: response.status,
        body: await response.text()
      }
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
    nowMs: (): number => Date.now(),
    randomToken: (): string => crypto.randomUUID()
  }
}
