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
        if (options?.handoffContinuation) {
          if (!engine.continueHandoff) throw new Error('Workspace continuation is unavailable')
          yield* engine.continueHandoff(options.handoffContinuation.operationId, options)
        } else yield* engine.submitMessage(prompt, {
          uuid: options?.uuid,
          isMeta: options?.isMeta,
          origin: options?.origin,
          onInputPersisted: options?.onInputPersisted,
          handoffReconciliationAdmission: options?.handoffReconciliationAdmission,
          onHandoffInputCommitted: options?.onHandoffInputCommitted,
          onExecutionClosed: options?.onExecutionClosed,
          handoffReconciliationContext: options?.handoffReconciliationContext,
        })
      } finally {
        currentPermissionHandler = undefined
      }
    },
    readHandoffOutcome(operationId) { return engine.readHandoffOutcome?.(operationId) ?? Promise.resolve(null) },
    recoverHandoffReconciliation(notice) {
      if (!engine.recoverHandoffReconciliation) return Promise.resolve(null)
      return engine.recoverHandoffReconciliation(notice)
    },
    sealResumeCheckpoint() {
      if (!engine.sealResumeCheckpoint) throw new Error('Resume checkpoint sealing unavailable')
      return engine.sealResumeCheckpoint()
    },
    verifyResumeCheckpoint(checkpoint) {
      if (!engine.verifyResumeCheckpoint) throw new Error('Resume checkpoint verification unavailable')
      return engine.verifyResumeCheckpoint(checkpoint)
    },
    persistHandoffOutcome(operationId, outcome) {
      if (!engine.persistHandoffOutcome) throw new Error('Workspace outcome persistence is unavailable')
      return engine.persistHandoffOutcome(operationId, outcome)
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
