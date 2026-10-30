import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { InlineCommandRun } from '../../app/shared/inlineCommand.js'
import type { InlineCommandOperation } from './inlineCommand.js'
import type { ConversationRewindResult } from '../QueryEngine.js'
import type { ConversationForkResult } from '../commands/branch/branch.js'
import type { MessageOrigin } from '../types/message.js'
import type { UserMessage } from '../types/message.js'
import type { Message, PriorAssistantContext } from '../types/message.js'
import type { ResumeCheckpoint } from '../../app/shared/workspaceHandoff.js'
import type { HandoffTerminalOutcome, HandoffTurnLifecycleOptions } from './handoff.js'
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

export type QueryEngineSessionOptions = HandoffTurnLifecycleOptions & {
  priorAssistantContext?: PriorAssistantContext | null
  uuid?: string
  isMeta?: boolean
  origin?: MessageOrigin
  onInputPersisted?: () => void | Promise<void>
  inlineCommand?: InlineCommandOperation
  handoffContinuation?: { operationId: string }
  /** Internal controller admission requirement, never renderer input. */
  handoffReconciliationAdmission?: true
  onPermissionRequest?: (
    request: AppPermissionRequest,
    signal?: AbortSignal,
  ) => Promise<AppPermissionResponse>
}

export type QueryEngineSessionLike = {
  getMessages?: () => readonly Message[]
  executeInlineCommand?: (operation: InlineCommandOperation, options?: Pick<QueryEngineSessionOptions, 'onPermissionRequest'>) => AsyncIterable<SDKMessage>
  getInlineCommandRuns?: () => InlineCommandRun[]
  submitMessage(
    prompt: AppSessionPrompt,
    options?: QueryEngineSessionOptions,
  ): AsyncIterable<SDKMessage>
  interrupt?: (intent?: AppSessionAbortIntent) => void
  refreshAbortController?: () => AbortController
  continueHandoff?: (operationId: string, options?: { uuid?: string; onInputPersisted?: () => void | Promise<void> } & HandoffTurnLifecycleOptions) => AsyncIterable<SDKMessage>
  readHandoffOutcome?: (operationId: string) => Promise<HandoffTerminalOutcome | null>
  recoverHandoffReconciliation?: (notice: { displayUuid: string; contextUuid: string }) => Promise<{
    inputUuid: string; contextUuid: string; checkpoint: ResumeCheckpoint
  } | null>
  sealResumeCheckpoint?: () => Promise<ResumeCheckpoint>
  requiresRecoveryReview?: () => boolean
  verifyResumeCheckpoint?: (checkpoint: ResumeCheckpoint) => Promise<void>
  persistHandoffOutcome?: (operationId: string, outcome: HandoffTerminalOutcome) => Promise<SDKMessage[]>
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
    getMessages: session.getMessages ? () => session.getMessages!() : undefined,
    runInlineCommand: session.executeInlineCommand
      ? ({ operation, onPermissionRequest }) => session.executeInlineCommand!(operation, { onPermissionRequest })
      : undefined,
    runTurn({ prompt, options, onPermissionRequest }) {
      return session.submitMessage(prompt, {
        ...options,
        onPermissionRequest,
      })
    },
    getInlineCommandRuns: session.getInlineCommandRuns ? () => session.getInlineCommandRuns!() : undefined,
    readHandoffOutcome: session.readHandoffOutcome ? operationId => session.readHandoffOutcome!(operationId) : undefined,
    recoverHandoffReconciliation: session.recoverHandoffReconciliation ? notice => session.recoverHandoffReconciliation!(notice) : undefined,
    sealResumeCheckpoint: session.sealResumeCheckpoint ? () => session.sealResumeCheckpoint!() : undefined,
    requiresRecoveryReview: session.requiresRecoveryReview ? () => session.requiresRecoveryReview!() : undefined,
    verifyResumeCheckpoint: session.verifyResumeCheckpoint ? checkpoint => session.verifyResumeCheckpoint!(checkpoint) : undefined,
    persistHandoffOutcome: session.persistHandoffOutcome
      ? (operationId, outcome) => session.persistHandoffOutcome!(operationId, outcome)
      : undefined,
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
