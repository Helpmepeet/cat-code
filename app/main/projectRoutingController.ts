import type { ProjectRoutingStore, RouteRecord } from './projectRoutingStore.js'
import type {
  ErrorFrame,
  SidecarClientMessage,
} from '../shared/protocol.js'
import type {
  ProjectRouteCommand,
  ProjectRouteDecision,
  ProjectRouteSnapshot,
} from '../shared/projectRouting.js'

type RoutedSubmit = Extract<SidecarClientMessage, { type: 'app.submit' }> & {
  options?: NonNullable<Extract<SidecarClientMessage, { type: 'app.submit' }>['options']> & {
    submitId?: string
  }
}

export type PendingRoute = {
  sessionId: string
  submitId: string
  message: RoutedSubmit
  routingText: string
  sourceCwd: string
  phase: ProjectRouteSnapshot['phase']
  decision: Exclude<ProjectRouteDecision, { kind: 'stay' }> | null
  messageText: string | null
  outcome: 'unsent' | 'unknown' | 'accepted'
}

export type ProjectRoutingControllerOptions = {
  store?: ProjectRoutingStore
  prepareForward?(sessionId: string): Promise<void>
  currentCwd(sessionId: string): string | null
  forward(sessionId: string, message: SidecarClientMessage): ErrorFrame['code'] | null
  answerRefused(sessionId: string, submitId: string, code: ErrorFrame['code']): void
  publish(sessionId: string, snapshot: ProjectRouteSnapshot | null): void
  log(message: string): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ProjectRoutingController {
  private readonly pending = new Map<string, PendingRoute>()

  private readonly accepted = new Map<string, RouteRecord>()
  private storageFailure = false
  private readonly receiptTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly options: ProjectRoutingControllerOptions) {
    try {
      for (const route of options.store?.load() ?? []) {
        if (route.outcome === 'accepted') this.accepted.set(route.sessionId, route)
        else {
          route.phase = route.outcome === 'unknown' ? 'uncertain' : 'unsent'
          route.messageText = null
          this.pending.set(route.sessionId, route)
        }
      }
    } catch (error) {
      this.storageFailure = true
      options.log(`[project-routing] recovery failed: ${errorMessage(error)}`)
    }
  }

  private persist(): void {
    this.options.store?.save([...this.accepted.values(), ...this.pending.values()])
  }

  /** New submissions bypass the retired classifier. The legacy journal still
   * owns duplicate receipts and refusal while a saved payload needs recovery. */
  acceptsNewSubmit(sessionId: string, id: string | undefined): boolean {
    if (this.storageFailure || this.pending.has(sessionId)) return false
    return id === undefined || this.accepted.get(sessionId)?.submitId !== id
  }

  async resolve(command: ProjectRouteCommand): Promise<void> {
    const route = this.pending.get(command.appSessionId)
    if (route === undefined || route.submitId !== command.submitId) return

    if (command.choice === 'cancel') {
      this.cancel(command.appSessionId)
      return
    }
    if (['resend', 'stay'].includes(command.choice) &&
        ['unsent', 'uncertain', 'ask', 'failed'].includes(route.phase)) {
      route.outcome = 'unsent'
      await this.forwardHeld(route)
    }
  }

  onSubmitResult(sessionId: string, submitId: string, accepted: boolean): void {
    const route = this.pending.get(sessionId)
    if (route === undefined || route.submitId !== submitId || route.outcome !== 'unknown') return
    this.clearReceiptTimer(sessionId)
    route.outcome = accepted ? 'accepted' : 'unsent'
    if (accepted) {
      this.accepted.set(sessionId, { ...route, routingText: '',
        message: { type: 'app.submit', requestId: route.message.requestId, prompt: '', options: { submitId } } })
    }
    if (accepted) this.clear(route)
    else {
      route.phase = 'unsent'
      route.messageText = 'The message was not accepted. You can send it again.'
      this.publish(route)
    }
  }

  interrupted(sessionId: string): void {
    const route = this.pending.get(sessionId)
    if (route?.outcome !== 'unknown') return
    this.clearReceiptTimer(sessionId)
    route.phase = 'uncertain'
    this.publish(route)
  }

  snapshots(): ProjectRouteSnapshot[] {
    return [...this.pending.values()].map(route => this.snapshot(route))
  }

  hasPending(sessionId: string): boolean {
    return this.storageFailure || this.pending.has(sessionId)
  }

  cancel(sessionId: string): void {
    const route = this.pending.get(sessionId)
    if (
      route === undefined ||
      !['checking', 'ask', 'failed', 'unsent', 'uncertain'].includes(route.phase)
    ) return
    if (route.outcome === 'unsent') this.options.answerRefused(sessionId, route.submitId, 'bad_request')
    this.clear(route)
  }

  private async forwardHeld(route: PendingRoute): Promise<void> {
    if (this.pending.get(route.sessionId) !== route) return
    route.phase = 'recovery'
    this.publish(route)
    try {
      await this.options.prepareForward?.(route.sessionId)
      if (this.pending.get(route.sessionId) !== route) return
      const cwd = this.options.currentCwd(route.sessionId)
      if (cwd !== route.sourceCwd && cwd !== route.decision?.cwd) {
        this.fail(route, 'Project folder changed before sending.')
        return
      }
      route.outcome = 'unknown'
      route.phase = 'recovery'
      try { this.persist() } catch (error) {
        route.outcome = 'unsent'
        throw error
      }
      this.options.publish(route.sessionId, this.snapshot(route))
      const timer = setTimeout(() => this.interrupted(route.sessionId), 15_000)
      timer.unref?.()
      this.receiptTimers.set(route.sessionId, timer)
      const failure = this.options.forward(route.sessionId, route.message)
      if (failure === null) return
      this.clearReceiptTimer(route.sessionId)
      route.outcome = 'unsent'
      route.phase = 'unsent'
      route.messageText = 'The message was not sent. Restore the conversation and try again.'
      this.publish(route)
    } catch (error) {
      route.phase = route.outcome === 'unknown' ? 'uncertain' : 'unsent'
      route.messageText = 'Could not send the message. Check the conversation before trying again.'
      this.options.log(`[project-routing] delivery failed: ${errorMessage(error)}`)
      this.publish(route)
    }
  }

  private fail(route: PendingRoute, message: string): void {
    if (this.pending.get(route.sessionId) !== route) return
    route.phase = route.outcome === 'unsent' && route.decision !== null &&
      this.options.currentCwd(route.sessionId) === route.decision.cwd ? 'unsent' : 'failed'
    route.messageText = message
    this.publish(route)
  }

  private clearReceiptTimer(sessionId: string): void {
    const timer = this.receiptTimers.get(sessionId)
    if (timer !== undefined) clearTimeout(timer)
    this.receiptTimers.delete(sessionId)
  }

  private clear(route: PendingRoute): void {
    if (this.pending.get(route.sessionId) !== route) return
    this.clearReceiptTimer(route.sessionId)
    this.pending.delete(route.sessionId)
    try { this.persist() } catch (error) { this.options.log(`[project-routing] journal failed: ${errorMessage(error)}`) }
    this.options.publish(route.sessionId, null)
  }

  private publish(route: PendingRoute): void {
    try { this.persist() } catch (error) { this.options.log(`[project-routing] journal failed: ${errorMessage(error)}`) }
    this.options.publish(route.sessionId, this.snapshot(route))
  }

  private snapshot(route: PendingRoute): ProjectRouteSnapshot {
    return {
      appSessionId: route.sessionId,
      submitId: route.submitId,
      phase: route.phase,
      text: route.routingText,
      projectName: route.decision?.name ?? null,
      message: route.messageText,
    }
  }
}
