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
  eligible(sessionId: string): boolean
  currentCwd(sessionId: string): string | null
  classify(
    sessionId: string,
    text: string,
    previousUserMessages: string[],
    suppressedRoots: string[],
  ): Promise<ProjectRouteDecision>
  move(sessionId: string, cwd: string): Promise<{ ok: true } | { ok: false; error: { message: string } }>
  forward(sessionId: string, message: SidecarClientMessage): ErrorFrame['code'] | null
  answerRefused(sessionId: string, submitId: string, code: ErrorFrame['code']): void
  publish(sessionId: string, snapshot: ProjectRouteSnapshot | null): void
  log(message: string): void
}

function submitId(message: RoutedSubmit): string | null {
  return typeof message.options?.submitId === 'string' && message.options.submitId.length > 0
    ? message.options.submitId
    : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ProjectRoutingController {
  private readonly pending = new Map<string, PendingRoute>()
  private readonly previousUserMessages = new Map<string, string[]>()
  private readonly suppressedRoots = new Map<string, Set<string>>()

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

  async submit(
    sessionId: string,
    message: SidecarClientMessage | RoutedSubmit,
    routingText: string,
  ): Promise<void> {
    if (message.type !== 'app.submit') {
      this.forwardDirect(sessionId, message)
      return
    }
    const held = message as RoutedSubmit
    const id = submitId(held)
    const existing = this.pending.get(sessionId)
    if (existing !== undefined) {
      if (existing.submitId !== id && id !== null) this.options.answerRefused(sessionId, id, 'bad_request')
      return
    }
    if (id !== null && this.accepted.get(sessionId)?.submitId === id) return
    if (this.storageFailure) {
      if (id !== null) this.options.answerRefused(sessionId, id, 'bad_request')
      return
    }
    if (id === null || !this.options.eligible(sessionId)) {
      this.forwardDirect(sessionId, message)
      return
    }

    const sourceCwd = this.options.currentCwd(sessionId)
    if (sourceCwd === null) {
      this.forwardDirect(sessionId, held)
      return
    }

    const route: PendingRoute = {
      sessionId,
      submitId: id,
      message: held,
      routingText,
      sourceCwd,
      phase: 'checking',
      decision: null,
      messageText: null,
      outcome: 'unsent',
    }
    this.pending.set(sessionId, route)
    try { this.persist() } catch (error) {
      this.pending.delete(sessionId)
      this.options.log(`[project-routing] could not hold message: ${errorMessage(error)}`)
      this.options.answerRefused(sessionId, id, 'bad_request')
      return
    }
    this.publish(route)

    await this.classifyHeld(route)
  }

  private async classifyHeld(route: PendingRoute): Promise<void> {
    try {
      const decision = await this.options.classify(
        route.sessionId,
        route.routingText,
        [...(this.previousUserMessages.get(route.sessionId) ?? [])],
        [...(this.suppressedRoots.get(route.sessionId) ?? [])],
      )
      if (this.pending.get(route.sessionId) !== route) return
      await this.applyDecision(route, decision)
    } catch (error) {
      if (this.pending.get(route.sessionId) !== route) return
      this.options.log(`[project-routing] classifier failed: ${errorMessage(error)}`)
      if (!this.verifySource(route)) return
      await this.forwardHeld(route)
    }
  }

  async resolve(command: ProjectRouteCommand): Promise<void> {
    const route = this.pending.get(command.appSessionId)
    if (route === undefined || route.submitId !== command.submitId) return

    if (command.choice === 'cancel') {
      this.cancel(command.appSessionId)
      return
    }
    if (command.choice === 'resend' && ['unsent', 'uncertain'].includes(route.phase)) {
      const shouldRoute = route.outcome === 'unsent' &&
        this.options.currentCwd(route.sessionId) === route.sourceCwd && this.options.eligible(route.sessionId)
      route.outcome = 'unsent'
      if (shouldRoute) {
        route.phase = 'checking'
        this.publish(route)
        await this.classifyHeld(route)
      } else await this.forwardHeld(route)
      return
    }
    if (!['ask', 'failed'].includes(route.phase)) return

    if (command.choice === 'stay') {
      if (!this.verifySource(route)) return
      if (route.decision !== null && !route.decision.explicit) {
        let roots = this.suppressedRoots.get(route.sessionId)
        if (roots === undefined) {
          roots = new Set()
          this.suppressedRoots.set(route.sessionId, roots)
        }
        roots.add(route.decision.cwd)
      }
      await this.forwardHeld(route)
      return
    }

    if (command.choice === 'move' && route.decision !== null) {
      await this.moveThenForward(route)
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
      const previous = this.previousUserMessages.get(sessionId) ?? []
      this.previousUserMessages.set(sessionId, [...previous, route.routingText.slice(0, 2000)].slice(-3))
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
    return this.pending.has(sessionId)
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

  private async applyDecision(route: PendingRoute, decision: ProjectRouteDecision): Promise<void> {
    if (decision.kind === 'stay') {
      if (!this.verifySource(route)) return
      await this.forwardHeld(route)
      return
    }

    route.decision = decision
    if (!this.verifySource(route)) return
    if (decision.kind === 'ask') {
      route.phase = 'ask'
      this.publish(route)
      return
    }
    await this.moveThenForward(route)
  }

  private async moveThenForward(route: PendingRoute): Promise<void> {
    const decision = route.decision
    if (decision === null || !this.verifySource(route)) return

    route.phase = 'moving'
    try {
      // Movement may commit independently of the held delivery. Record its
      // destination first so restart can safely identify the new binding.
      this.persist()
      this.options.publish(route.sessionId, this.snapshot(route))
      const result = await this.options.move(route.sessionId, decision.cwd)
      if (this.pending.get(route.sessionId) !== route) return
      if (!result.ok) {
        this.fail(route, result.error.message)
        return
      }
      await this.forwardHeld(route)
    } catch (error) {
      if (this.pending.get(route.sessionId) !== route) return
      this.options.log(`[project-routing] move failed: ${errorMessage(error)}`)
      this.fail(route, errorMessage(error))
    }
  }

  private forwardDirect(sessionId: string, message: SidecarClientMessage | RoutedSubmit): void {
    const failure = this.options.forward(sessionId, message)
    if (failure === null || message.type !== 'app.submit') return
    const id = submitId(message as RoutedSubmit)
    if (id !== null) this.options.answerRefused(sessionId, id, failure)
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

  private verifySource(route: PendingRoute): boolean {
    if (this.options.currentCwd(route.sessionId) === route.sourceCwd) return true
    this.fail(route, 'Project folder changed before routing completed.')
    return false
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
