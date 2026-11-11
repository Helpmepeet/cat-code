import { useContext } from 'react'
import { SidePaneNavigationContext } from './sidePaneNavigationContext.js'

export function SidePaneNavigation() {
  const navigation = useContext(SidePaneNavigationContext)
  return <>
    <button type="button" className="file-pane-icon" aria-label="Back" title="Back" disabled={!navigation.canGoBack} onClick={navigation.back}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
    </button>
    <button type="button" className="file-pane-icon" aria-label="Forward" title="Forward" disabled={!navigation.canGoForward} onClick={navigation.forward}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
    </button>
  </>
}
