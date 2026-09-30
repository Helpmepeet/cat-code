import { randomUUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { MessageOrigin } from '../types/message.js'
import type { UserMessage } from '../types/message.js'
import type { ConversationRewindResult } from '../QueryEngine.js'
import type { ConversationForkResult } from '../commands/branch/branch.js'
import { withStreamJsonAccountDiagnosticHook } from '../services/api/accountDiagnostics.js'
import { handoffContinuationPrompt, type HandoffTerminalOutcome } from './handoff.js'
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
  onInputPersisted?: () => void
}

export type AppSessionPrompt = string | ContentBlockParam[]

export type AppSessionControllerAdapter = {
  runTurn(args: {
    prompt: AppSessionPrompt
    options?: {
      uuid?: string
      isMeta?: boolean
      origin?: MessageOrigin
      onInputPersisted?: () => void
      handoffContinuation?: { operationId: string }
      /** Controller-owned admission barrier; never accepted from app.submit. */
      handoffReconciliationAdmission?: true
    }
    signal: AbortSignal
    onPermissionRequest: (
      request: AppPermissionRequest,
    ) => Promise<AppPermissionResponse>
  }): AsyncIterable<SDKMessage>
  persistHandoffOutcome?: (operationId: string, outcome: HandoffTerminalOutcome) => Promise<SDKMessage[]>
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
  canStartAutomaticTurn(): boolean { return !this.activeTurn && !this.handoffReservation && !this.requiresUserReconciliation }
  subscribeHandoffStatus(listener: () => void): () => void {
    this.handoffListeners.add(listener)
    return () => { this.handoffListeners.delete(listener) }
  }

  reserveHandoff(operationId: string): void {
    if (!operationId || !this.activeTurn || this.handoffReservation || this.requiresUserReconciliation || this.pendingPermissionRequests.size) {
      throw new Error('Session cannot reserve a workspace handoff')
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

  async continueHandoff(operationId: string, options?: { uuid?: string; onInputPersisted?: () => void }): Promise<void> {
    if (this.handoffReservation !== operationId || this.requiresUserReconciliation || this.handoffContinuationAdmitted) throw new Error('Workspace continuation is not reserved')
    this.handoffContinuationAdmitted = true
    await this.runSubmit(handoffContinuationPrompt(), {
      isMeta: true, uuid: options?.uuid, onInputPersisted: options?.onInputPersisted,
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
    if (this.handoffReservation) throw new Error('Conversation is reserved for a workspace handoff')
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
    if (this.handoffReservation) throw new Error('Conversation is reserved for a workspace handoff')
    if (this.requiresUserReconciliation && (options?.isMeta || options?.origin)) throw new Error('Workspace handoff requires user reconciliation')
    await this.runSubmit(prompt, options)
  }

  private async runSubmit(
    prompt: AppSessionPrompt,
    options?: AppSessionSubmitOptions,
    continuationOperationId?: string,
  ): Promise<void> {
    if (this.activeTurn) {
      throw new Error('Session turn already running')
    }
    const reconcileInput = this.requiresUserReconciliation && !continuationOperationId &&
      !options?.isMeta && !options?.origin

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
              onInputPersisted: () => {
                if (reconcileInput && this.requiresUserReconciliation) {
                  this.requiresUserReconciliation = false
                  this.announceHandoffState()
                }
                options?.onInputPersisted?.()
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
