import * as React from 'react'
import { AgentSectionLabel } from '@cat-code/desktop'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-app-bg flex flex-col gap-4 p-6 font-sans">{children}</div>
  )
}

/** The four caption tones. */
export function Tones() {
  return (
    <Frame>
      <AgentSectionLabel>Prompt</AgentSectionLabel>
      <AgentSectionLabel tone="accent">Waiting on the assistant</AgentSectionLabel>
      <AgentSectionLabel tone="lease">Account leases</AgentSectionLabel>
      <AgentSectionLabel tone="warn">Failed over</AgentSectionLabel>
    </Frame>
  )
}

/** In place: captioning a block in the worker detail panel. */
export function InDetail() {
  return (
    <div className="bg-app-bg flex flex-col gap-4 p-6 font-sans">
      <div>
        <AgentSectionLabel>Prompt</AgentSectionLabel>
        <div className="mt-1 text-[12.5px] leading-relaxed text-text-muted">
          Trace how the auth refresh path decides to rotate a token, and report where the
          decision is made.
        </div>
      </div>
      <div>
        <AgentSectionLabel>Result</AgentSectionLabel>
        <div className="mt-1 rounded-md border border-shell-seam bg-surface-raised px-3 py-2.5 text-[12.5px] leading-relaxed text-text-muted">
          Rotation is decided in the account pool, not the request path. Two callers bypass it.
        </div>
      </div>
    </div>
  )
}
