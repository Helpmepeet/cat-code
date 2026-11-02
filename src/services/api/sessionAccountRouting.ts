export type SessionAccountProvider = 'anthropic' | 'openai'
export type SessionAccountRouteBlock = { requestedAccountId: string; message: string }

const blocks = new Map<SessionAccountProvider, SessionAccountRouteBlock>()

/** Process-local admission hold. Account identifiers never enter the message. */
export function blockSessionAccountRoute(provider: SessionAccountProvider, requestedAccountId: string): void {
  const label = provider === 'anthropic' ? 'Claude' : 'Codex'
  blocks.set(provider, {
    requestedAccountId,
    message: `This chat's saved ${label} account is unavailable. Open Accounts, sign in if needed, then select an account for this chat to continue.`,
  })
}

export function clearSessionAccountRouteBlock(provider: SessionAccountProvider): void {
  blocks.delete(provider)
}

export function getSessionAccountRouteBlock(provider: SessionAccountProvider): SessionAccountRouteBlock | null {
  const block = blocks.get(provider)
  return block ? { ...block } : null
}

export function assertSessionAccountRouteAvailable(provider: SessionAccountProvider): void {
  const block = blocks.get(provider)
  if (block) throw new Error(block.message)
}
