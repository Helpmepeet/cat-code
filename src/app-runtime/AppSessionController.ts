import { randomUUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { MessageOrigin } from '../types/message.js'
import type { UserMessage } from '../types/message.js'
import type { ConversationRewindResult } from '../QueryEngine.js'
import type { ConversationForkResult } from '../commands/branch/branch.js'
import { withStreamJsonAccountDiagnosticHook } from '../services/api/accountDiagnostics.js'
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

export type AppSessionSubmitOptions = {
  uuid?: string
  isMeta?: boolean
  goalSnapshot?: AppGoalSnapshot
  /** Engine-owned provenance for autonomous turns (never renderer input). */
  origin?: MessageOrigin
  /** Sidecar-only acknowledgement after the input is durably persisted. */
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
    }
    signal: AbortSignal
    onPermissionRequest: (
      request: AppPermissionRequest,
    ) => Promise<AppPermissionResponse>
  }): AsyncIterable<SDKMessage>
  abort?: () => void
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

  abort(reason = 'Session aborted'): void {
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
    this.adapter.abort?.()
  }

  rewindBeforeUserMessage(
    targetUuid: string,
  ): Promise<ConversationRewindResult> {
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
    if (!this.adapter.forkBeforeUserMessage) {
      throw new Error('Conversation fork is unavailable')
    }
    return this.adapter.forkBeforeUserMessage(targetUuid, customTitle)
  }

  async submit(
    prompt: AppSessionPrompt,
    options?: AppSessionSubmitOptions,
  ): Promise<void> {
    if (this.activeTurn) {
      throw new Error('Session turn already running')
    }

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
              onInputPersisted: options?.onInputPersisted,
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
   * `submit`, lifted to a method because `createRuntimeBackedWebAppSession`
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
