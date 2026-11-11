import { useState, type ReactNode } from 'react'
import { SidePaneShellContext } from './sidePaneShellContext.js'
import './sidePaneShell.css'

export function SidePaneShell({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  return <SidePaneShellContext.Provider value={host}>
    <div className="side-pane-shell bg-shell-chrome font-sans text-text-primary" data-window-ground>
      <div className="side-pane-shell-main">{children}</div>
      <div ref={setHost} className="side-pane-shell-host" />
    </div>
  </SidePaneShellContext.Provider>
}
