import * as React from 'react'
import { AgentStateWord } from '@cat-code/desktop'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-app-bg flex flex-wrap items-center gap-5 p-6 font-sans">
      {children}
    </div>
  )
}

/**
 * The compressed vocabulary. Several lifecycle states deliberately collapse to one word:
 * a scanning reader needs "done", not the difference between completed and reviewed.
 */
export function Compressed() {
  return (
    <Frame>
      <AgentStateWord state="running" />
      <AgentStateWord state="waiting" />
      <AgentStateWord state="needs-you" />
      <AgentStateWord state="completed" />
      <AgentStateWord state="failed" />
      <AgentStateWord state="stopped" />
    </Frame>
  )
}

/** Three in-flight states, one word. Tone still separates them. */
export function CollapsedToRunning() {
  return (
    <Frame>
      <AgentStateWord state="running" />
      <AgentStateWord state="background" />
      <AgentStateWord state="resumed" />
    </Frame>
  )
}

/** Three settled states, one word. */
export function CollapsedToDone() {
  return (
    <Frame>
      <AgentStateWord state="completed" />
      <AgentStateWord state="reviewed" />
      <AgentStateWord state="result-ready" />
    </Frame>
  )
}
