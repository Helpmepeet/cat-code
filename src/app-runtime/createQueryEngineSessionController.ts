import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { ConversationRewindResult } from '../QueryEngine.js'
import type { ConversationForkResult } from '../commands/branch/branch.js'
import type { MessageOrigin } from '../types/message.js'
import type { UserMessage } from '../types/message.js'
import {
  AppSessionController,
  type AppSessionAbortIntent,
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
  origin?: MessageOrigin
  onInputPersisted?: () => void
  onPermissionRequest?: (
    request: AppPermissionRequest,
  ) => Promise<AppPermissionResponse>
}

export type QueryEngineSessionLike = {
  submitMessage(
    prompt: AppSessionPrompt,
    options?: QueryEngineSessionOptions,
  ): AsyncIterable<SDKMessage>
  interrupt?: (intent?: AppSessionAbortIntent) => void
  refreshAbortController?: () => AbortController
  selectUserMessage?: (targetUuid: string) => UserMessage
  rewindBeforeUserMessage?: (
    targetUuid: string,
  ) => Promise<ConversationRewindResult>
  forkBeforeUserMessage?: (
    targetUuid: string,
    customTitle?: string,
  ) => Promise<ConversationForkResult>
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
    abort(intent) {
      if (intent === undefined) {
        session.interrupt?.()
      } else {
        session.interrupt?.(intent)
      }
    },
    selectUserMessage: session.selectUserMessage
      ? targetUuid => session.selectUserMessage!(targetUuid)
      : undefined,
    rewindBeforeUserMessage: session.rewindBeforeUserMessage
      ? targetUuid => session.rewindBeforeUserMessage!(targetUuid)
      : undefined,
    forkBeforeUserMessage: session.forkBeforeUserMessage
      ? (targetUuid, customTitle) =>
          session.forkBeforeUserMessage!(targetUuid, customTitle)
      : undefined,
  }
}

export function createQueryEngineSessionController(
  session: QueryEngineSessionLike,
): AppSessionController {
  return new AppSessionController(createQueryEngineSessionAdapter(session))
}
