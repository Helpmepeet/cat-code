import type { CatCodeBridge } from '../../shared/protocol.js'

/** Null means the native picker was cancelled before any host move request. */
export async function requestSessionMove(
  bridge: Pick<CatCodeBridge, 'pickDirectory' | 'moveSession'>,
  appSessionId: string,
  kind: 'move-to-project' | 'move-back',
): Promise<Awaited<ReturnType<CatCodeBridge['moveSession']>> | null> {
  const token = kind === 'move-back' ? null : await bridge.pickDirectory(appSessionId)
  if (kind === 'move-to-project' && token === null) return null
  return bridge.moveSession(appSessionId, token)
}
