export type AgentLifecycleOwnership = {
  agentId: string
  token: symbol
}

const activeAgentLifecycles = new Map<string, symbol>()

export function acquireAgentLifecycleOwnership(
  agentId: string,
): AgentLifecycleOwnership | undefined {
  if (activeAgentLifecycles.has(agentId)) return undefined
  const ownership = { agentId, token: Symbol(agentId) }
  activeAgentLifecycles.set(agentId, ownership.token)
  return ownership
}

export function releaseAgentLifecycleOwnership(
  ownership: AgentLifecycleOwnership,
): void {
  if (activeAgentLifecycles.get(ownership.agentId) === ownership.token) {
    activeAgentLifecycles.delete(ownership.agentId)
  }
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
