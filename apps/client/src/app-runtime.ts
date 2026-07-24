// 必须先于任何 @meal-agent/contracts schema 构造（见 zod-runtime-config）。
import './zod-runtime-config'

import { createTaroPlatformAdapter } from './platform/taro-adapter'
import { createAppServices, type AppServices } from './core/app-services'

let services: AppServices | undefined

/** 页面获取应用服务的唯一入口；真实运行时用 Taro 适配器组装。 */
export const getAppServices = (): AppServices => {
  services ??= createAppServices(
    createTaroPlatformAdapter(),
    __MEAL_AGENT_API_BASE_URL__
  )
  return services
}
