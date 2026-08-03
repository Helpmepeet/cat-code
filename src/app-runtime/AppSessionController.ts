import { randomUUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { MessageOrigin } from '../types/message.js'
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
