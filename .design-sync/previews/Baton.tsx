import * as React from 'react'
import { Baton } from '@cat-code/desktop'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-app-bg flex flex-wrap items-center gap-6 p-6 font-sans">
      {children}
    </div>
  )
}

/**
 * Who owns the next action. Lifecycle and ownership are separate axes, so a blocked worker
 * is neutral while the assistant can pick it up.
 */
export function Owners() {
  return (
    <Frame>
      <span className="inline-flex items-center gap-2">
        <Baton owner="assistant" />
        <span className="font-mono text-[11px] text-text-subtle">the assistant will handle it</span>
      </span>
      <span className="inline-flex items-center gap-2">
        <Baton owner="assistant" />
        <span className="font-mono text-[11px] text-text-subtle">the assistant will handle it</span>
      </span>
    </Frame>
  )
}

/** `none` renders nothing, so a row with nobody waiting stays quiet. */
export function Quiet() {
  return (
    <div className="bg-app-bg p-6 font-sans">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-text-faint">owner none, nothing renders:</span>
        <Baton owner="none" />
        <span className="font-mono text-[11px] text-text-ghost">(end of row)</span>
      </div>
    </div>
  )
}

/** On a row, the baton is the last thing before the edge. */
export function OnARow() {
  return (
    <div className="bg-app-bg p-4 font-sans">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="font-mono text-[12.5px] font-medium text-purple-200">Hopper</span>
        <span className="flex-1 truncate text-[11.5px] text-text-subtle">
          Blocked on a missing credential
        </span>
        <Baton owner="assistant" />
      </div>
    </div>
  )
}
