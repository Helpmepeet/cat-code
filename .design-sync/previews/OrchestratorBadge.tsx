import * as React from 'react'
import { OrchestratorBadge } from '@cat-code/desktop'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-app-bg flex flex-wrap items-center gap-5 p-5 font-sans">
      {children}
    </div>
  )
}

/** Passive marker: it states the mode and nothing more. Off and passive, it renders nothing at all. */
export function Passive() {
  return (
    <Frame>
      <OrchestratorBadge active />
    </Frame>
  )
}

/**
 * With `onToggle` the badge IS the switch. Off collapses to the glyph alone, because a lit
 * "Orchestrator" pill on a session not in the mode would name a state nobody chose.
 */
export function Switch() {
  return (
    <Frame>
      <span className="inline-flex items-center gap-2">
        <OrchestratorBadge active onToggle={() => {}} sessionLabel="cat-code" />
        <span className="font-mono text-[11px] text-text-subtle">on</span>
      </span>
      <span className="inline-flex items-center gap-2">
        <OrchestratorBadge active={false} onToggle={() => {}} sessionLabel="cat-code" />
        <span className="font-mono text-[11px] text-text-subtle">off</span>
      </span>
    </Frame>
  )
}

/** Where it lives: riding a session tab beside the title, which is why it stays this small. */
export function OnATab() {
  return (
    <div className="bg-app-bg p-5 font-sans">
      <div className="inline-flex items-center gap-2 rounded-[9px] border border-shell-seam bg-surface-raised px-3 py-2">
        <span className="text-[12.5px] text-text-primary">Subagent panel redesign</span>
        <OrchestratorBadge active onToggle={() => {}} sessionLabel="Subagent panel redesign" />
      </div>
    </div>
  )
}
