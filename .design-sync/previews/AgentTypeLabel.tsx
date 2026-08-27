import * as React from 'react'
import { AgentTypeLabel } from '@cat-code/desktop'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-app-bg flex flex-wrap items-center gap-5 p-5 font-sans">
      {children}
    </div>
  )
}

/** The compact form for crowded rows: the type as toned mono text, no pill. */
export function Types() {
  return (
    <Frame>
      <AgentTypeLabel role="Explore" />
      <AgentTypeLabel role="general-purpose" />
      <AgentTypeLabel role="implementor" />
      <AgentTypeLabel role="verification" />
    </Frame>
  )
}

/** Why it exists: on a dense row the pill would compete with the name and the status. */
export function OnARow() {
  return (
    <div className="bg-app-bg p-4 font-sans">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="font-mono text-[12.5px] font-medium text-purple-200">Noether</span>
        <span className="flex-1 truncate text-[11.5px] text-text-subtle">
          Check the permission boundary
        </span>
        <AgentTypeLabel role="verification" />
      </div>
    </div>
  )
}
