import type {
  BridgePermissionCallbacks,
  BridgePermissionResponse,
} from './bridgePermissionCallbacks.js'
import type { PermissionUpdate } from '../utils/permissions/PermissionUpdateSchema.js'

type SendRequestArgs = [
  requestId: string,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
  description: string,
  permissionSuggestions?: PermissionUpdate[],
  blockedPath?: string,
]

export function mergeBridgePermissionCallbacks(
  ...callbacks: Array<BridgePermissionCallbacks | undefined>
): BridgePermissionCallbacks | undefined {
  const active = callbacks.filter(
    (callback): callback is BridgePermissionCallbacks => callback !== undefined,
  )

  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]

  return {
    sendRequest(...args: SendRequestArgs) {
      for (const callback of active) {
        callback.sendRequest(...args)
      }
    },
    sendResponse(requestId: string, response: BridgePermissionResponse) {
      for (const callback of active) {
        callback.sendResponse(requestId, response)
      }
    },
    cancelRequest(requestId: string) {
      for (const callback of active) {
        callback.cancelRequest(requestId)
      }
    },
    onResponse(
      requestId: string,
      handler: (response: BridgePermissionResponse) => void,
    ) {
      const unsubscribes = active.map((callback, index) =>
        callback.onResponse(requestId, response => {
          active.forEach((sibling, siblingIndex) => {
            if (siblingIndex !== index) {
              sibling.cancelRequest(requestId)
            }
          })
          handler(response)
        }),
      )
      return () => {
        for (const unsubscribe of unsubscribes) {
          unsubscribe()
        }
      }
    },
  }
}
