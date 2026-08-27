import * as React from 'react'
import { AgentActionButton } from '@cat-code/desktop'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-app-bg flex flex-wrap items-center gap-4 p-6 font-sans">
      {children}
    </div>
  )
}

/** The three outline tones. `danger` is the one in production use: the worker Stop control. */
export function Tones() {
  return (
    <Frame>
      <AgentActionButton label="Stop" tone="danger" onClick={() => {}} />
      <AgentActionButton label="Resume" tone="accent" onClick={() => {}} />
      <AgentActionButton label="Dismiss" tone="neutral" onClick={() => {}} />
    </Frame>
  )
}

/** In place: the only control the read-only worker detail offers. */
export function InDetail() {
  return (
    <div className="bg-app-bg p-6 font-sans">
      <div className="flex items-center gap-3 border-t border-shell-seam pt-4">
        <AgentActionButton
          label="Stop"
          onClick={() => {}}
          title="Stop this worker"
          tone="danger"
        />
        <span className="text-[11px] text-text-subtle">
          Available while the worker is still running.
        </span>
      </div>
    </div>
  )
}
