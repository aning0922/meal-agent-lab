import { createPlatformAdapter } from './create-platform-adapter'
import { taroRuntime } from './taro-runtime'

export const platform = createPlatformAdapter(
  taroRuntime,
  __MEAL_AGENT_MOCK_API_BASE_URL__
)
