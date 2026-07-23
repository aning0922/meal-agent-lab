import { createPlatformAdapter } from './create-platform-adapter'
import { taroRuntime } from './taro-runtime'

export const platform = createPlatformAdapter(taroRuntime)
