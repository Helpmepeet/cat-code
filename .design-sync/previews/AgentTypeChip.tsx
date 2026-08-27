import * as React from 'react'
import { AgentTypeChip } from '@cat-code/desktop'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-app-bg flex flex-wrap items-center gap-3 p-5 font-sans">
      {children}
    </div>
  )
}

/** The known agent types, each with its own tone. */
export function KnownTypes() {
  return (
    <Frame>
      <AgentTypeChip role="Explore" />
      <AgentTypeChip role="general-purpose" />
      <AgentTypeChip role="implementor" />
      <AgentTypeChip role="verification" />
      <AgentTypeChip role="coding-worker" />
    </Frame>
  )
}

/**
 * An unrecognised type still gets a chip, labelled with the type itself in neutral grey.
 * Only a null or empty role renders nothing.
 */
export function UnknownType() {
  return (
    <Frame>
      <AgentTypeChip role="statusline-setup" />
      <AgentTypeChip role="claude-code-guide" />
    </Frame>
  )
}
