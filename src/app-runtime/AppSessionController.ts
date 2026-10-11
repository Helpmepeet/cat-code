import { randomUUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { MessageOrigin } from '../types/message.js'
import type { UserMessage } from '../types/message.js'
import type { ConversationRewindResult } from '../QueryEngine.js'
import type { ConversationForkResult } from '../commands/branch/branch.js'
import { withStreamJsonAccountDiagnosticHook } from '../services/api/accountDiagnostics.js'
import { canonicalResumeJson } from '../utils/resumeCheckpoint.js'
import { HandoffExecution, type WorkspaceHandoffConfiguration } from './handoffExecution.js'
import type { ResumeCheckpointV1, WorkspaceHandoffSnapshot } from '../../app/shared/workspaceHandoff.js'
import { handoffContinuationPrompt, type HandoffTerminalOutcome, type HandoffTurnLifecycleOptions } from './handoff.js'
import {
  createAbortStatusEvent,
  createGoalSnapshotEvent,
  createMessageEvent,
  createPermissionRequestedEvent,
  createPermissionResolvedEvent,
  createTurnStatusEvent,
  type AppGoalSnapshot,
  type AppPermissionRequest,
  type AppPermissionResponse,
  type AppSessionAbortState,
  type AppSessionEvent,
} from './sessionEvents.js'

export type AppSessionAbortIntent = 'interrupt'

export type AppSessionSubmitOptions = {
  uuid?: string
  isMeta?: boolean
  goalSnapshot?: AppGoalSnapshot
  /** Engine-owned provenance for autonomous turns (never renderer input). */
  origin?: MessageOrigin
  /** Input persistence acknowledgement; reconciliation includes a durable barrier. */
  onInputPersisted?: () => void | Promise<void>
}

export type AppSessionPrompt = string | ContentBlockParam[]

export type AppSessionControllerAdapter = {
  runTurn(args: {
    prompt: AppSessionPrompt
    options?: {
      uuid?: string
      isMeta?: boolean
      origin?: MessageOrigin
      onInputPersisted?: () => void | Promise<void>
      handoffContinuation?: { operationId: string }
      /** Controller-owned admission barrier; never accepted from app.submit. */
      handoffReconciliationAdmission?: true
    } & HandoffTurnLifecycleOptions
    signal: AbortSignal
    onPermissionRequest: (
      request: AppPermissionRequest,
    ) => Promise<AppPermissionResponse>
  }): AsyncIterable<SDKMessage>
  persistHandoffOutcome?: (operationId: string, outcome: HandoffTerminalOutcome) => Promise<SDKMessage[]>
  readHandoffOutcome?: (operationId: string) => Promise<HandoffTerminalOutcome | null>
  recoverHandoffReconciliation?: (notice: { displayUuid: string; contextUuid: string }) => Promise<{
    inputUuid: string; contextUuid: string; checkpoint: ResumeCheckpointV1
  } | null>
  sealResumeCheckpoint?: () => Promise<ResumeCheckpointV1>
  verifyResumeCheckpoint?: (checkpoint: ResumeCheckpointV1) => Promise<void>
  abort?: (intent?: AppSessionAbortIntent) => void
  selectUserMessage?: (targetUuid: string) => UserMessage
  rewindBeforeUserMessage?: (
    targetUuid: string,
  ) => Promise<ConversationRewindResult>
  forkBeforeUserMessage?: (
    targetUuid: string,
    customTitle?: string,
  ) => Promise<ConversationForkResult>
}

type AppSessionEventListener = (event: AppSessionEvent) => void

type PendingPermissionRequest = {
  request: AppPermissionRequest
  resolve: (response: AppPermissionResponse) => void
}

export class AppSessionController {
  private readonly listeners = new Set<AppSessionEventListener>()
  private readonly pendingPermissionRequests = new Map<
    string,
    PendingPermissionRequest
  >()

  private abortState: AppSessionAbortState = { status: 'idle' }
  private goalSnapshot: AppGoalSnapshot = null
  private abortController: AbortController | null = null
  private activeTurn = false
  private handoffExecution: HandoffExecution | null = null
  private handoffSettlement: Promise<void> | null = null
  private initialization: Promise<void> = Promise.resolve()
  private initializing = false
  private pendingReconciliation: { noticeUuid: string; inputUuid: string; contextUuid: string; prompt: string } | null = null
  private handoffReservation: string | null = null
  private handoffContinuationAdmitted = false
  private requiresUserReconciliation = false
  private readonly handoffListeners = new Set<() => void>()
  private readonly idleWaiters = new Set<() => void>()
  private readonly fallbackDiagnosticSessionId = randomUUID()

  constructor(private readonly adapter: AppSessionControllerAdapter) {}

  subscribe(listener: AppSessionEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAbortState(): AppSessionAbortState {
    return this.abortState
  }

  getGoalSnapshot(): AppGoalSnapshot {
    return this.goalSnapshot
  }

  getPendingPermissionRequests(): AppPermissionRequest[] {
    return Array.from(this.pendingPermissionRequests.values(), value => value.request)
  }

  isTurnActive(): boolean {
    return this.activeTurn
  }

  getHandoffReservation(): string | null { return this.handoffReservation }
  requiresHandoffReconciliation(): boolean { return this.requiresUserReconciliation }
  canStartAutomaticTurn(): boolean { return !this.initializing && !this.activeTurn && !this.handoffReservation && !this.requiresUserReconciliation }
  subscribeHandoffStatus(listener: () => void): () => void {
    this.handoffListeners.add(listener)
    return () => { this.handoffListeners.delete(listener) }
  }

  initializeBeforeAdmission(initialization: Promise<void>): void {
    this.initializing = true
    this.initialization = initialization.then(() => { this.initializing = false })
    void this.initialization.catch(() => {})
  }
  waitForInitialization(): Promise<void> { return this.initialization }

  async configureWorkspaceHandoff(configuration: WorkspaceHandoffConfiguration): Promise<void> {
    if (this.activeTurn || (this.handoffReservation && this.handoffReservation !== configuration.identity.operationId)) throw new Error('Workspace handoff ownership changed')
    const previous = this.getWorkspaceHandoffSnapshot()
    if (previous && previous.record.kind !== 'absent' &&
      (previous.admissionGeneration !== configuration.identity.admissionGeneration || previous.operationSha256 !== configuration.identity.operationSha256)) {
      throw new Error('Workspace admission identity changed')
    }
    if (!configuration.historical) this.restoreHandoffReservation(configuration.identity.operationId)
    else if (this.handoffReservation) throw new Error('Active handoff cannot become historical')
    const execution = new HandoffExecution(configuration, () => this.announceHandoffState())
    this.handoffExecution = execution
    this.pendingReconciliation = null
    await execution.recover(checkpoint => {
      if (!this.adapter.verifyResumeCheckpoint) throw new Error('Resume proof verification unavailable')
      return this.adapter.verifyResumeCheckpoint(checkpoint)
    })
    let record = execution.persisted
    if (!configuration.historical && record?.notice && !record.reconciliation && this.adapter.recoverHandoffReconciliation) {
      const recovered = await this.adapter.recoverHandoffReconciliation(record.notice)
      if (recovered) {
        await execution.reconcile({ noticeUuid: record.notice.displayUuid, ...recovered })
        record = execution.persisted
      }
    }
    if (configuration.historical) { this.handoffReservation = null; this.requiresUserReconciliation = false }
    else if (record?.notice) {
      this.handoffReservation = null
      this.requiresUserReconciliation = !record.reconciliation
    }
    this.announceHandoffState()
  }
  getWorkspaceHandoffSnapshot(): WorkspaceHandoffSnapshot | null {
    return this.handoffExecution?.snapshot({ mode: this.handoffReservation ? 'held' : this.requiresUserReconciliation ? 'review' : 'open',
      reservationOperationId: this.handoffReservation, requiresUserReconciliation: this.requiresUserReconciliation }) ?? null
  }
  async startHandoffContinuation(): Promise<{ completion: Promise<void> }> {
    const execution = this.handoffExecution
    if (!execution || !this.adapter.sealResumeCheckpoint || this.handoffReservation !== execution.configuration.identity.operationId || this.requiresUserReconciliation) throw new Error('Workspace continuation unavailable')
    return execution.claim(() => this.continueHandoff(execution.configuration.identity.operationId, {
      uuid: execution.configuration.identity.continuationId,
      onHandoffInputCommitted: checkpoint => execution.inputCommitted(checkpoint),
      onExecutionClosed: outcome => execution.close(outcome),
    }), () => this.adapter.sealResumeCheckpoint!())
  }
  async cancelWorkspaceHandoff(cancelId: string): Promise<void> {
    if (!this.handoffExecution) throw new Error('Workspace execution unavailable')
    await this.handoffExecution.cancel(cancelId, () => this.abort('Workspace continuation stopped'))
  }
  async settleWorkspaceHandoff(outcome: HandoffTerminalOutcome): Promise<void> {
    if (this.handoffSettlement) return this.handoffSettlement
    const execution = this.handoffExecution
    if (!execution || !execution.canSettle || this.activeTurn) throw new Error('Workspace outcome cannot be settled')
    if (execution.persisted?.notice) return
    if (execution.persisted?.terminal?.outcome === 'success') throw new Error('Successful execution cannot publish a warning')
    // Fence delayed continuation before the first warning/storage await.
    execution.fenceNoStart()
    this.handoffSettlement = this.persistWorkspaceHandoffNotice(outcome)
    try { await this.handoffSettlement } finally { this.handoffSettlement = null }
  }
  private async persistWorkspaceHandoffNotice(outcome: HandoffTerminalOutcome): Promise<void> {
    const execution = this.handoffExecution
    if (!execution || !execution.canSettle || this.activeTurn || !this.adapter.persistHandoffOutcome || !this.adapter.sealResumeCheckpoint) throw new Error('Workspace outcome cannot be settled')
    const operationId = execution.configuration.identity.operationId
    const existing = execution.persisted?.notice
    const actualOutcome = existing?.outcome ?? await this.adapter.readHandoffOutcome?.(operationId) ?? outcome
    const messages = await this.adapter.persistHandoffOutcome(operationId, actualOutcome)
    const displayUuid = messages[0]?.uuid
    const contextUuid = messages.at(-1)?.uuid
    if (!displayUuid || !contextUuid || messages.length < 2) throw new Error('Workspace warning proof unavailable')
    const checkpoint = await this.adapter.sealResumeCheckpoint()
    await execution.notice({ displayUuid, contextUuid, outcome: actualOutcome, checkpoint })
    for (const message of messages) this.emitMessage(message)
    this.requiresUserReconciliation = true
    if (this.handoffReservation === operationId) this.releaseHandoffReservation(operationId)
    else this.announceHandoffState()
  }
  async releaseWorkspaceHandoff(operationId: string, target: 'open' | 'review'): Promise<'applied' | 'already_applied' | 'refused'> {
    const execution = this.handoffExecution
    if (!execution || execution.configuration.identity.operationId !== operationId ||
      (this.handoffReservation && this.handoffReservation !== operationId)) return 'refused'
    const record = execution.persisted
    if (!record || (target === 'open' ? !(record.terminal?.outcome === 'success' || record.reconciliation) : !record.notice || !!record.reconciliation)) return 'refused'
    if (!this.handoffReservation) return this.requiresUserReconciliation === (target === 'review') ? 'already_applied' : 'refused'
    if (this.activeTurn || !execution.closed) return 'refused'
    this.requiresUserReconciliation = target === 'review'
    this.releaseHandoffReservation(operationId)
    execution.gateChanged()
    return 'applied'
  }

  reserveHandoff(operationId: string): void {
    if (!operationId || !this.activeTurn || this.handoffReservation || this.requiresUserReconciliation || this.pendingPermissionRequests.size) {
      throw new Error('Session cannot reserve a workspace handoff')
    }
    if (this.handoffExecution) {
      if (this.handoffExecution.configuration.identity.operationId === operationId ||
        this.handoffSettlement || !this.handoffExecution.canRetire) throw new Error('Prior workspace handoff has not converged')
      // A new source turn owns a new operation. Retain the old durable receipt
      // on disk, but never pair its execution identity with the new reservation.
      this.handoffExecution = null
      this.pendingReconciliation = null
    }
    this.handoffReservation = operationId
    this.handoffContinuationAdmitted = false
    this.announceHandoffState()
  }

  restoreHandoffReservation(operationId: string): void {
    if (!operationId || this.activeTurn || (this.handoffReservation && this.handoffReservation !== operationId)) {
      throw new Error('Session cannot restore a workspace handoff reservation')
    }
    if (this.handoffReservation !== operationId) this.handoffContinuationAdmitted = false
    this.handoffReservation = operationId
    this.announceHandoffState()
  }

  releaseHandoffReservation(operationId: string): void {
    if (this.handoffReservation !== operationId) throw new Error('Workspace handoff ownership changed')
    this.handoffReservation = null
    this.handoffContinuationAdmitted = false
    this.announceHandoffState()
  }

  async continueHandoff(operationId: string, options?: { uuid?: string; onInputPersisted?: () => void | Promise<void> } & HandoffTurnLifecycleOptions): Promise<void> {
    if (this.handoffReservation !== operationId || this.requiresUserReconciliation || this.handoffContinuationAdmitted) throw new Error('Workspace continuation is not reserved')
    this.handoffContinuationAdmitted = true
    await this.runSubmit(handoffContinuationPrompt(), {
      ...options, isMeta: true, uuid: options?.uuid, onInputPersisted: options?.onInputPersisted,
    }, operationId)
    // The host releases ownership only after recording continuation settlement.
  }

  async settleHandoff(operationId: string, outcome: HandoffTerminalOutcome): Promise<void> {
    if (this.activeTurn || this.handoffReservation !== operationId || !this.adapter.persistHandoffOutcome) throw new Error('Workspace outcome cannot be settled')
    const messages = await this.adapter.persistHandoffOutcome(operationId, outcome)
    for (const message of messages) this.emitMessage(message)
    this.requiresUserReconciliation = true
    this.releaseHandoffReservation(operationId)
  }

  restoreHandoffReconciliation(): void {
    if (this.activeTurn) throw new Error('Cannot reconcile an active turn')
    this.requiresUserReconciliation = true
    this.announceHandoffState()
  }

  private announceHandoffState(): void { for (const listener of this.handoffListeners) listener() }
  private assertMutable(): void {
    if (this.handoffReservation || this.requiresUserReconciliation) throw new Error('Conversation is reserved for a workspace handoff')
  }

  waitUntilIdle(): Promise<void> {
    if (!this.activeTurn) return Promise.resolve()
    return new Promise(resolve => {
      this.idleWaiters.add(resolve)
    })
  }

  updateGoalSnapshot(snapshot: AppGoalSnapshot): void {
    this.goalSnapshot = snapshot
    this.emit(createGoalSnapshotEvent(snapshot))
  }

  respondToPermissionRequest(
    requestId: string,
    response: AppPermissionResponse,
  ): boolean {
    const pendingRequest = this.pendingPermissionRequests.get(requestId)
    if (!pendingRequest) {
      return false
    }

    this.pendingPermissionRequests.delete(requestId)
    pendingRequest.resolve(response)
    this.emit(createPermissionResolvedEvent(pendingRequest.request, response))
    return true
  }

  abort(
    reason = 'Session aborted',
    adapterIntent?: AppSessionAbortIntent,
  ): void {
    if (!this.activeTurn && this.pendingPermissionRequests.size === 0) {
      return
    }

    if (
      this.abortState.status === 'requested' ||
      this.abortState.status === 'aborted'
    ) {
      return
    }

    this.setAbortState({ status: 'requested', reason })

    for (const requestId of this.pendingPermissionRequests.keys()) {
      this.respondToPermissionRequest(requestId, {
        behavior: 'deny',
        message: reason,
      })
    }

    this.abortController?.abort(reason)
    if (adapterIntent === undefined) {
      this.adapter.abort?.()
    } else {
      this.adapter.abort?.(adapterIntent)
    }
  }

  rewindBeforeUserMessage(
    targetUuid: string,
  ): Promise<ConversationRewindResult> {
    this.assertMutable()
    if (!this.adapter.rewindBeforeUserMessage) {
      throw new Error('Conversation rewind is unavailable')
    }
    return this.adapter.rewindBeforeUserMessage(targetUuid)
  }

  selectUserMessage(targetUuid: string): UserMessage {
    if (!this.adapter.selectUserMessage) {
      throw new Error('Conversation message selection is unavailable')
    }
    return this.adapter.selectUserMessage(targetUuid)
  }

  forkBeforeUserMessage(
    targetUuid: string,
    customTitle?: string,
  ): Promise<ConversationForkResult> {
    this.assertMutable()
    if (!this.adapter.forkBeforeUserMessage) {
      throw new Error('Conversation fork is unavailable')
    }
    return this.adapter.forkBeforeUserMessage(targetUuid, customTitle)
  }

  async submit(
    prompt: AppSessionPrompt,
    options?: AppSessionSubmitOptions,
  ): Promise<void> {
    if (this.initializing) await this.waitForInitialization()
    if (this.handoffReservation) throw new Error('Conversation is reserved for a workspace handoff')
    if (this.requiresUserReconciliation && (options?.isMeta || options?.origin)) throw new Error('Workspace handoff requires user reconciliation')
    await this.runSubmit(prompt, options)
  }

  private async runSubmit(
    prompt: AppSessionPrompt,
    options?: AppSessionSubmitOptions & HandoffTurnLifecycleOptions,
    continuationOperationId?: string,
  ): Promise<void> {
    if (this.activeTurn) {
      throw new Error('Session turn already running')
    }
    const reconcileInput = this.requiresUserReconciliation && !continuationOperationId &&
      !options?.isMeta && !options?.origin

    if (reconcileInput && !options?.uuid) options = { ...options, uuid: randomUUID() }
    this.setActiveTurn(true)
    this.abortController = new AbortController()

    if (this.abortState.status !== 'idle') {
      this.setAbortState({ status: 'idle' })
    }

    if (options && 'goalSnapshot' in options) {
      this.updateGoalSnapshot(options.goalSnapshot ?? null)
    }

    await withStreamJsonAccountDiagnosticHook(
      {
        emit: message => {
          this.emit(createMessageEvent(message))
        },
        getSessionId: () => this.getDiagnosticSessionId(),
      },
      async () => {
        try {
          const messages = this.adapter.runTurn({
            prompt,
            options: {
              uuid: options?.uuid,
              isMeta: options?.isMeta,
              origin: options?.origin,
              ...(continuationOperationId ? { handoffContinuation: { operationId: continuationOperationId } } : {}),
              ...(reconcileInput ? { handoffReconciliationAdmission: true as const } : {}),
              onExecutionClosed: options?.onExecutionClosed,
              ...(continuationOperationId ? { onHandoffInputCommitted: options?.onHandoffInputCommitted } : {}),
              ...(reconcileInput && this.handoffExecution?.persisted?.notice ? (() => {
                const notice = this.handoffExecution!.persisted!.notice!
                const inputUuid = options!.uuid!
                const promptKey = canonicalResumeJson(prompt)
                const pending = this.pendingReconciliation
                if (pending?.inputUuid === inputUuid && pending.noticeUuid === notice.displayUuid && pending.prompt !== promptKey) {
                  throw new Error('Reconciliation retry changed the accepted input')
                }
                const contextUuid = pending?.inputUuid === inputUuid && pending.noticeUuid === notice.displayUuid ? pending.contextUuid : randomUUID()
                this.pendingReconciliation = { noticeUuid: notice.displayUuid, inputUuid, contextUuid, prompt: promptKey }
                return { handoffReconciliationContext: { operationId: this.handoffExecution!.configuration.identity.operationId, noticeUuid: notice.displayUuid, contextUuid },
                  onHandoffInputCommitted: async (checkpoint: ResumeCheckpointV1) => {
                    if (!options?.uuid) throw new Error('Reconciliation input identity unavailable')
                    await this.handoffExecution!.reconcile({ noticeUuid: notice.displayUuid, inputUuid: options.uuid, contextUuid, checkpoint })
                    this.pendingReconciliation = null
                  } }
              })() : {}),
              onInputPersisted: async () => {
                if (reconcileInput && this.requiresUserReconciliation) {
                  this.requiresUserReconciliation = false
                  this.announceHandoffState()
                }
                await options?.onInputPersisted?.()
              },
            },
            signal: this.abortController.signal,
            onPermissionRequest: request => this.waitForPermissionResponse(request),
          })

          for await (const message of messages) {
            this.emit(createMessageEvent(message))
          }
        } finally {
          this.setActiveTurn(false)
          const signal = this.abortController.signal
          this.abortController = null

          if (signal.aborted) {
            const reason =
              this.abortState.status === 'requested' ||
              this.abortState.status === 'aborted'
                ? this.abortState.reason
                : undefined
            this.setAbortState(
              reason ? { status: 'aborted', reason } : { status: 'aborted' },
            )
          }
        }
      }
    )
  }

  private getDiagnosticSessionId(): string {
    return this.goalSnapshot?.threadId ?? this.fallbackDiagnosticSessionId
  }

  /**
   * Out-of-band engine message injection, for a message the engine PUSHES
   * through a callback instead of yielding from the turn generator. The
   * compaction status is the only one today: `setSDKStatus` fires from inside
   * the compaction service (`src/services/compact/compact.ts`), which is not a
   * point in the message stream, so there is nothing to yield it from.
   *
   * Same shape as the stream-json account-diagnostic hook already wired inside
   * `submit`, lifted to a method because `createRuntimeBackedAppSession`
   * builds its callback before the controller exists.
   */
  emitMessage(message: SDKMessage): void {
    this.emit(createMessageEvent(message))
  }

  private emit(event: AppSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private setAbortState(abortState: AppSessionAbortState): void {
    this.abortState = abortState
    this.emit(createAbortStatusEvent(abortState))
  }

  /**
   * The only writer of `activeTurn` — a bare assignment cannot announce itself,
   * and a client that misses one flip is stuck with a stale turn state until it
   * reattaches. Idempotent so a repeated write emits nothing.
   */
  private setActiveTurn(activeTurn: boolean): void {
    if (this.activeTurn === activeTurn) return
    this.activeTurn = activeTurn
    this.emit(createTurnStatusEvent(activeTurn))
    if (!activeTurn) {
      for (const resolve of this.idleWaiters) resolve()
      this.idleWaiters.clear()
    }
  }

  private waitForPermissionResponse(
    request: AppPermissionRequest,
  ): Promise<AppPermissionResponse> {
    if (this.abortController?.signal.aborted) {
      return Promise.resolve({
        behavior: 'deny',
        message: this.getAbortReason(),
      })
    }

    return new Promise(resolve => {
      this.pendingPermissionRequests.set(request.requestId, {
        request,
        resolve,
      })
      this.emit(createPermissionRequestedEvent(request))
    })
  }

  private getAbortReason(): string {
    if (
      this.abortState.status === 'requested' ||
      this.abortState.status === 'aborted'
    ) {
      return this.abortState.reason ?? 'Session aborted'
    }

    return 'Session aborted'
  }
}
