import {
  QueryEngine,
  type ConversationRewindResult,
  type QueryEngineConfig,
} from '../QueryEngine.js'
import {
  createForkBeforeUserMessage,
  type ConversationForkResult,
} from '../commands/branch/branch.js'
import { createAbortController } from '../utils/abortController.js'
import {
  createAppRuntimeCanUseTool,
  type AppPermissionRequestHandler,
} from './appRuntimeCanUseTool.js'
import type { AppSessionAbortIntent } from './AppSessionController.js'
import type {
  QueryEngineSessionLike,
  QueryEngineSessionOptions,
} from './createQueryEngineSessionController.js'

export type QueryEngineAppSessionConfig = Omit<
  QueryEngineConfig,
  'abortController' | 'canUseTool'
> & {
  abortController?: AbortController
  canUseTool?: QueryEngineConfig['canUseTool']
  createRequestId?: () => string
  createEngine?: (config: QueryEngineConfig) => QueryEngineSessionLike
}

export function createQueryEngineAppSession(
  config: QueryEngineAppSessionConfig,
): QueryEngineSessionLike {
  let currentPermissionHandler: AppPermissionRequestHandler | undefined
  const abortController = config.abortController ?? createAbortController()
  const engineConfig = {
    ...config,
    abortController,
    canUseTool: createAppRuntimeCanUseTool({
      baseCanUseTool: config.canUseTool,
      createRequestId: config.createRequestId,
      getPermissionRequestHandler: () => currentPermissionHandler,
    }),
  }
  const engine = config.createEngine?.(engineConfig) ?? new QueryEngine(engineConfig)

  return {
    async *submitMessage(prompt, options?: QueryEngineSessionOptions) {
      engine.refreshAbortController?.()
      currentPermissionHandler = options?.onPermissionRequest
      try {
        yield* engine.submitMessage(prompt, {
          uuid: options?.uuid,
          isMeta: options?.isMeta,
          origin: options?.origin,
          onInputPersisted: options?.onInputPersisted,
        })
      } finally {
        currentPermissionHandler = undefined
      }
    },
    interrupt(intent?: AppSessionAbortIntent) {
      if (intent === undefined) {
        engine.interrupt?.()
      } else {
        engine.interrupt?.(intent)
      }
    },
    refreshAbortController() {
      return engine.refreshAbortController?.() ?? abortController
    },
    selectUserMessage(targetUuid) {
      if (!engine.selectUserMessage) {
        throw new Error('Conversation message selection is unavailable')
      }
      return engine.selectUserMessage(targetUuid)
    },
    rewindBeforeUserMessage(targetUuid): Promise<ConversationRewindResult> {
      if (!engine.rewindBeforeUserMessage) {
        throw new Error('Conversation rewind is unavailable')
      }
      return engine.rewindBeforeUserMessage(targetUuid)
    },
    forkBeforeUserMessage(
      targetUuid,
      customTitle,
    ): Promise<ConversationForkResult> {
      return engine.forkBeforeUserMessage?.(targetUuid, customTitle) ??
        createForkBeforeUserMessage(targetUuid, customTitle)
    },
  }
}
