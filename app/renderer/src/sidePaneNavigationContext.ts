import { createContext } from 'react'

export type SidePaneNavigationValue = {
  canGoBack: boolean
  canGoForward: boolean
  back: () => void
  forward: () => void
}

export const SidePaneNavigationContext = createContext<SidePaneNavigationValue>({
  canGoBack: false,
  canGoForward: false,
  back() {},
  forward() {},
})
