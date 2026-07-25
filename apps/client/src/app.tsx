import './zod-runtime-config'

import type { PropsWithChildren } from 'react'

import { PendingCommandRecovery } from './components/pending-command-recovery'
import './app.css'

function App({ children }: PropsWithChildren) {
  return (
    <>
      {children}
      <PendingCommandRecovery />
    </>
  )
}

export default App
