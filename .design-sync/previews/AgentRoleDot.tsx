import * as React from 'react'
import { AgentRoleDot } from '@cat-code/desktop'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-app-bg flex flex-wrap items-center gap-6 p-6 font-sans">
      {children}
    </div>
  )
}

function Cell({ label, role }: { label: string; role: string | null }) {
  return (
    <span className="inline-flex items-center gap-2">
      <AgentRoleDot role={role} />
      <span className="font-mono text-[11px] text-text-subtle">{label}</span>
    </span>
  )
}

/** The row-leading mark. Unlike the pip it carries TYPE, not lifecycle. */
export function ByType() {
  return (
    <Frame>
      <Cell label="Explore" role="Explore" />
      <Cell label="general-purpose" role="general-purpose" />
      <Cell label="implementor" role="implementor" />
      <Cell label="verification" role="verification" />
      <Cell label="null" role={null} />
    </Frame>
  )
}

/** Paired with a lifecycle pip at the other end of the row, so the two axes never collide. */
export function BothAxes() {
  return (
    <div className="bg-app-bg p-4 font-sans">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <AgentRoleDot role="Explore" />
        <span className="font-mono text-[12.5px] font-medium text-purple-200">Ada</span>
        <span className="flex-1 truncate text-[11.5px] text-text-subtle">
          Trace the auth refresh path
        </span>
        <span className="font-mono text-[10.5px] text-text-faint">type at the left, status at the right</span>
      </div>
    </div>
  )
}
