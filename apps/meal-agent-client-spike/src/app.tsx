import type { PropsWithChildren } from 'react'
import { useLaunch } from '@tarojs/taro'

import './app.css'

function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    console.info('[meal-agent-client-spike] launched')
  })

  return children
}

export default App
