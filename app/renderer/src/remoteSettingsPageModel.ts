import type { RemoteSettingsResultFrame } from '../../shared/protocol.js'

/** Returns only the direct-connect result addressed to this panel's request. */
export function directConnectResultForRequest(
  pendingRequestId: string | null,
  result: RemoteSettingsResultFrame | null,
): RemoteSettingsResultFrame | null {
  return result?.verb === 'remoteSettings.directConnect' &&
    result.requestId === pendingRequestId
    ? result
    : null
}
