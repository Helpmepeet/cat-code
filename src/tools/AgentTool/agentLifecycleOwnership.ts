export type AgentLifecycleOwnership = {
  agentId: string
  token: symbol
}

const activeAgentLifecycles = new Map<string, { token: symbol; completion: Promise<void>; release: () => void }>()

export function acquireAgentLifecycleOwnership(
  agentId: string,
): AgentLifecycleOwnership | undefined {
  if (activeAgentLifecycles.has(agentId)) return undefined
  const ownership = { agentId, token: Symbol(agentId) }
  let release!: () => void
  const completion = new Promise<void>(resolve => { release = resolve })
  activeAgentLifecycles.set(agentId, { token: ownership.token, completion, release })
  return ownership
}

export function releaseAgentLifecycleOwnership(
  ownership: AgentLifecycleOwnership,
): void {
  const active = activeAgentLifecycles.get(ownership.agentId)
  if (active?.token === ownership.token) {
    activeAgentLifecycles.delete(ownership.agentId)
    active.release()
  }
}

export function getAgentLifecycleCompletion(agentId: string): Promise<void> | undefined {
  return activeAgentLifecycles.get(agentId)?.completion
}

export function isAgentLifecycleOwned(agentId: string): boolean {
  return activeAgentLifecycles.has(agentId)
}

export async function runWithAgentLifecycleOwnership<T>(
  agentId: string,
  lifecycle: () => Promise<T>,
  existingOwnership?: AgentLifecycleOwnership,
): Promise<T> {
  const ownership =
    existingOwnership ?? acquireAgentLifecycleOwnership(agentId)
  if (!ownership || ownership.agentId !== agentId) {
    throw new Error(`Agent ${agentId} already has an active lifecycle`)
  }
  try {
    return await lifecycle()
  } finally {
    releaseAgentLifecycleOwnership(ownership)
  }
}

export function _resetAgentLifecycleOwnershipForTest(): void {
  activeAgentLifecycles.clear()
}
