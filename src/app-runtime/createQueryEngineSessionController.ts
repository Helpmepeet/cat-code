import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { ConversationRewindResult } from '../QueryEngine.js'
import type { ConversationForkResult } from '../commands/branch/branch.js'
import type { MessageOrigin } from '../types/message.js'
import type { UserMessage } from '../types/message.js'
import type { ResumeCheckpointV1 } from '../../app/shared/workspaceHandoff.js'
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
  uuid?: string
  isMeta?: boolean
  origin?: MessageOrigin
  onInputPersisted?: () => void | Promise<void>
  handoffContinuation?: { operationId: string }
  /** Internal controller admission requirement, never renderer input. */
  handoffReconciliationAdmission?: true
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
  continueHandoff?: (operationId: string, options?: { uuid?: string; onInputPersisted?: () => void | Promise<void> } & HandoffTurnLifecycleOptions) => AsyncIterable<SDKMessage>
  readHandoffOutcome?: (operationId: string) => Promise<HandoffTerminalOutcome | null>
  recoverHandoffReconciliation?: (notice: { displayUuid: string; contextUuid: string }) => Promise<{
    inputUuid: string; contextUuid: string; checkpoint: ResumeCheckpointV1
  } | null>
  sealResumeCheckpoint?: () => Promise<ResumeCheckpointV1>
  verifyResumeCheckpoint?: (checkpoint: ResumeCheckpointV1) => Promise<void>
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
    runTurn({ prompt, options, onPermissionRequest }) {
      return session.submitMessage(prompt, {
        ...options,
        onPermissionRequest,
      })
    },
    readHandoffOutcome: session.readHandoffOutcome ? operationId => session.readHandoffOutcome!(operationId) : undefined,
    recoverHandoffReconciliation: session.recoverHandoffReconciliation ? notice => session.recoverHandoffReconciliation!(notice) : undefined,
    sealResumeCheckpoint: session.sealResumeCheckpoint ? () => session.sealResumeCheckpoint!() : undefined,
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
