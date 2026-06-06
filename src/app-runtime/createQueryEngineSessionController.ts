import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import {
  AppSessionController,
  type AppSessionPrompt,
  type AppSessionControllerAdapter,
} from './AppSessionController.js'
import type {
  AppPermissionRequest,
  AppPermissionResponse,
} from './sessionEvents.js'

export type QueryEngineSessionOptions = {
  uuid?: string
  isMeta?: boolean
  onPermissionRequest?: (
    request: AppPermissionRequest,
  ) => Promise<AppPermissionResponse>
}

export type QueryEngineSessionLike = {
  submitMessage(
    prompt: AppSessionPrompt,
    options?: QueryEngineSessionOptions,
  ): AsyncIterable<SDKMessage>
  interrupt?: () => void
  refreshAbortController?: () => AbortController
}

export function createQueryEngineSessionAdapter(
  session: QueryEngineSessionLike,
): AppSessionControllerAdapter {
  return {
    runTurn({ prompt, options, onPermissionRequest }) {
      return session.submitMessage(prompt, {
        ...options,
        onPermissionRequest,
      })
    },
    abort() {
      session.interrupt?.()
    },
  }
}

export function createQueryEngineSessionController(
  session: QueryEngineSessionLike,
): AppSessionController {
  return new AppSessionController(createQueryEngineSessionAdapter(session))
}
