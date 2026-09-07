import * as React from 'react'
import { AgentStateLabel } from '@cat-code/desktop'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-app-bg flex flex-col gap-2.5 p-5 font-sans">{children}</div>
  )
}

/** In-flight states. The pip and the word are toned from one vocabulary, so they can never disagree. */
export function InFlight() {
  return (
    <Frame>
      <AgentStateLabel state="running" />
      <AgentStateLabel state="background" />
      <AgentStateLabel state="resumed" />
      <AgentStateLabel state="paused" />
    </Frame>
  )
}

/** Handoff states. Purple means the assistant owns the next action. */
export function Handoff() {
  return (
    <Frame>
      <AgentStateLabel state="waiting" />
      <AgentStateLabel state="needs-you" />
      <AgentStateLabel state="result-ready" />
      <AgentStateLabel state="attention" />
    </Frame>
  )
}

/** Settled states, once a worker has stopped doing anything. */
export function Settled() {
  return (
    <Frame>
      <AgentStateLabel state="completed" />
      <AgentStateLabel state="reviewed" />
      <AgentStateLabel state="failed" />
      <AgentStateLabel state="stopped" />
    </Frame>
  )
}

/** Workers carried over from an earlier session. */
export function Prior() {
  return (
    <Frame>
      <AgentStateLabel state="resumable" />
      <AgentStateLabel state="stale" />
    </Frame>
  )
}
