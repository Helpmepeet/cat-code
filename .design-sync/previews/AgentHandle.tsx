import * as React from 'react'
import { AgentHandle } from '@cat-code/desktop'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-app-bg flex flex-wrap items-center gap-6 p-6 font-sans">
      {children}
    </div>
  )
}

/**
 * Worker names come from the engine's themed pools, so they are real names rather than ids.
 * Pass the name already stripped of any leading @.
 */
export function Names() {
  return (
    <Frame>
      <AgentHandle name="Ada" />
      <AgentHandle name="Turing" />
      <AgentHandle name="Hopper" />
      <AgentHandle name="Noether" />
      <AgentHandle name="Curie" />
    </Frame>
  )
}

/** A name collision falls back to a numbered variant rather than an id. */
export function Deduplicated() {
  return (
    <Frame>
      <AgentHandle name="Turing" />
      <AgentHandle name="Turing-2" />
      <AgentHandle name="Turing-3" />
    </Frame>
  )
}

/** In place, as the anchor of a worker row. */
export function OnARow() {
  return (
    <div className="bg-app-bg p-4 font-sans">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <AgentHandle name="Ada" />
        <span className="flex-1 truncate text-[11.5px] text-text-subtle">
          Trace the auth refresh path
        </span>
        <span className="font-mono text-[10.5px] text-sky-300">Explore</span>
      </div>
    </div>
  )
}
