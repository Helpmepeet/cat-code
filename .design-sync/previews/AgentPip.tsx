import * as React from 'react'
import { AgentPip } from '@cat-code/desktop'

const STATES = [
  'running', 'background', 'waiting', 'needs-you', 'result-ready',
  'completed', 'reviewed', 'attention', 'failed', 'stopped',
  'paused', 'resumable', 'stale', 'resumed',
] as const

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-app-bg flex flex-wrap items-center gap-x-6 gap-y-3 p-5 font-sans">
      {children}
    </div>
  )
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      {children}
      <span className="font-mono text-[11px] text-text-subtle">{label}</span>
    </span>
  )
}

/** Every lifecycle state. Pulsing dot = running, hollow ring = pending or idle, filled dot = terminal. */
export function Lifecycle() {
  return (
    <Frame>
      {STATES.map(state => (
        <Cell key={state} label={state}>
          <AgentPip state={state} />
        </Cell>
      ))}
    </Frame>
  )
}

/** The two sizes. `xs` is for dense count strips, `sm` for list rows. */
export function Sizes() {
  return (
    <Frame>
      <Cell label="xs · running"><AgentPip size="xs" state="running" /></Cell>
      <Cell label="sm · running"><AgentPip size="sm" state="running" /></Cell>
      <Cell label="xs · needs-you"><AgentPip size="xs" state="needs-you" /></Cell>
      <Cell label="sm · needs-you"><AgentPip size="sm" state="needs-you" /></Cell>
    </Frame>
  )
}

/** In place: the mark that carries status on a worker row. */
export function OnARow() {
  return (
    <div className="bg-app-bg p-4 font-sans">
      <div className="flex items-center gap-2 rounded-[7px] px-[7px] py-[5px]">
        <AgentPip state="running" />
        <span className="font-mono text-[12.5px] font-medium text-purple-200">Ada</span>
        <span className="flex-1 truncate text-[11.5px] text-text-subtle">
          Trace the auth refresh path
        </span>
        <span className="font-mono text-[10.5px] text-sky-300">Explore</span>
      </div>
      <div className="flex items-center gap-2 rounded-[7px] px-[7px] py-[5px]">
        <AgentPip state="background" />
        <span className="font-mono text-[12.5px] font-medium text-purple-200">Hopper</span>
        <span className="flex-1 truncate text-[11.5px] text-text-subtle">
          Long migration sweep
        </span>
        <span className="font-mono text-[10.5px] text-violet-300">Implementor</span>
      </div>
    </div>
  )
}
