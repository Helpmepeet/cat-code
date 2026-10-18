/** Owns the one-shot operation, not the model's workspace judgment.
 * HOST-REQUEST-PLANE and CHAT-RELOCATION's agent-jump amendments define authority.
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { createWorkspaceJumpTiming, type WorkspaceJumpTimingSink } from '../shared/workspaceJumpTiming.js'
import { isWorkspaceHandoffSnapshot, type WorkspaceHandoffSnapshot } from '../shared/workspaceHandoff.js'
import type { WorkspaceControlAction, WorkspaceControlDelivery } from './workspaceHandoffControl.js'
import type { Host, CwdValidation } from '../host/host.js'
import type { HostRequestValues, HostRequestError, HostRequestVerb } from '../shared/protocol.js'
import type { PeerRegistryRow, ValidatedHostRequest } from './peerRequestPlane.js'
import { readSessionRelocation } from '../../src/utils/sessionRelocationState.js'
import {
  hasVerifiedSourceCompensation, loadWorkspaceJumpRetention, readWorkspaceJump, workspaceJumpDirectory, workspaceJumpRequiresRetention, writeWorkspaceJump,
  upgradeWorkspaceJumpState, workspaceJumpOperationSha256, workspaceJumpHasConfirmedGate, workspaceJumpAllowsQueuedInput, type WorkspaceJumpBoundary, type WorkspaceJumpStateV2,
} from '../../src/utils/workspaceJumpState.js'

export { loadWorkspaceJumpRetention, workspaceJumpAllowsQueuedInput } from '../../src/utils/workspaceJumpState.js'
export type { WorkspaceJumpState, WorkspaceJumpStateV2 } from '../../src/utils/workspaceJumpState.js'

type WorkspaceVerb = Extract<HostRequestVerb, 'workspaces.list' | 'workspace.jump' | 'workspace.ready' | 'workspace.cancel'>
type WorkspaceRequest = Extract<ValidatedHostRequest, { verb: WorkspaceVerb }>
type Result<V extends WorkspaceVerb = WorkspaceVerb> = { ok: true; value: HostRequestValues[V] } | { ok: false; error: HostRequestError }
export type WorkspaceJumpIdentity = { appSessionId: string; engineSessionId: string; generation: string }
export type WorkspaceJumpCoordinatorDeps = {
  host: Pick<Host, 'reserveWorkspaceJump' | 'releaseWorkspaceJump' | 'moveWorkspaceJump' | 'getSessionGeneration'>
  row: (appSessionId: string) => PeerRegistryRow | undefined
  knownProjects: () => readonly { path: string; lastUsedAt: number }[]
  validateCwd: (cwd: string) => CwdValidation
  /** Observation-only engine trust read. Never instructions, hooks, or accounts. */
  trustedProjectRoots: (roots: readonly string[]) => Promise<readonly string[]>
  /** Source receiving boundary checks both controller and sidecar turn owners,
   * its observed SDKResultHandoff, and the current active-chain boundary.
   */
  verifyReady: (identity: WorkspaceJumpIdentity, boundary: WorkspaceJumpBoundary, state: WorkspaceJumpStateV2) => boolean | Promise<boolean>
  /** Cumulative snapshots enter observe through the control plane's bounded receiver. */
  control: (state: WorkspaceJumpStateV2, action: WorkspaceControlAction) => Promise<WorkspaceControlDelivery>
  waitForControlSlot?: (appSessionId: string, operationId: string, generation: string) => Promise<boolean>
  controlSlotOccupied?: (appSessionId: string, operationId: string) => boolean
  /** Holds source/destination turn admission and user reconciliation gates. */
  onStateChanged?: (state: WorkspaceJumpStateV2) => void
  directory?: string
  now?: () => number
  timing?: WorkspaceJumpTimingSink
}

const refuse = (message: string): { ok: false; error: HostRequestError } => ({ ok: false, error: { code: 'unavailable', message } })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_CANCELLED_OPERATIONS_PER_GENERATION = 128
type GenerationCancellations = { engineSessionId: string; generation: string; operationIds: Set<string>; closed: boolean }
type LiveMove = { operationId: string; engineSessionId: string; continuationId: string; sourceGeneration: string; destination: string; generation?: string }

export class WorkspaceJumpCoordinator {
  private readonly timing
  private readonly acceptedTimings = new Map<string, { operationId: string; received?: (outcome?: 'completed' | 'failed' | 'unavailable') => void; end: (outcome?: 'completed' | 'failed' | 'unavailable') => void; boundary: (outcome?: 'completed' | 'failed' | 'unavailable') => void; admission?: (outcome?: 'completed' | 'failed' | 'unavailable') => void; providerObserved?: boolean; admissionObserved?: boolean }>()
  private readonly directory: string
  private readonly handles = new Map<string, { appSessionId: string; generation: string; path: string }>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly observations = new Map<string, WorkspaceHandoffSnapshot>()
  private readonly effects = new Set<Promise<void>>()
  private readonly redeliveries = new Map<string, number>()
  private readonly effectKeys = new Set<string>()
  private readonly accepting = new Map<string, string>()
  private readonly cancellations = new Map<string, GenerationCancellations>()
  private readonly liveMoves = new Map<string, LiveMove>()
  private readonly freshEvidence = new Map<string, number>()
  private readonly refusedContinuations = new Set<string>()
  private readonly observationRetries = new Map<string, { operationId: string; generation: string; attempts: number; timer?: ReturnType<typeof setTimeout> }>()
  private disposed = false
  constructor(private readonly deps: WorkspaceJumpCoordinatorDeps) {
    this.directory = deps.directory ?? workspaceJumpDirectory()
    this.timing = createWorkspaceJumpTiming(deps.timing)
  }

  /** Main observes the provider marker's delivery, not a foreign process clock. */
  observeProviderRequest(appSessionId: string, engineSessionId: string, operationId: string, generation: string): void {
    const state = this.snapshot(appSessionId)
    const pending = this.acceptedTimings.get(appSessionId)
    if (!pending || pending.operationId !== operationId || state?.operationId !== operationId ||
        state.engineSessionId !== engineSessionId || state.location !== 'destination' ||
        state.continuation.admissionGeneration !== generation || this.identity(appSessionId)?.generation !== generation) return
    pending.end()
    pending.received?.()
    pending.providerObserved = true
    if (pending.admissionObserved) this.acceptedTimings.delete(appSessionId)
  }

  snapshot(appSessionId: string): WorkspaceJumpStateV2 | null { const state = readWorkspaceJump(appSessionId, this.directory); return state ? upgradeWorkspaceJumpState(state) : null }
  loadRetention(): ReturnType<typeof loadWorkspaceJumpRetention> { return loadWorkspaceJumpRetention(this.directory) }
  /** Retire only ephemeral discovery authority; durable history is never erased. */
  forgetHandles(appSessionId: string): void {
    for (const [handle, entry] of this.handles) if (entry.appSessionId === appSessionId) this.handles.delete(handle)
    if (!this.identity(appSessionId)) {
      this.cancellations.delete(appSessionId)
      const pending = this.acceptedTimings.get(appSessionId)
      pending?.end('unavailable'); pending?.received?.('unavailable'); pending?.boundary('unavailable'); pending?.admission?.('unavailable')
      this.acceptedTimings.delete(appSessionId)
    }
  }
  retains(appSessionId: string): boolean {
    try { const s = this.snapshot(appSessionId); return !!s && workspaceJumpRequiresRetention(s, this.identity(appSessionId)?.generation) }
    catch { return true }
  }
  isReserved(appSessionId: string): boolean {
    try {
      const state = this.snapshot(appSessionId)
      if (!state) return false
      if (state.continuation.outcome === 'legacy_settled' && !state.review.required) return false
      return !workspaceJumpHasConfirmedGate(state)
    } catch { return true }
  }
  /** Destination work may use project peers without releasing the recovery hold. */
  isPeerAccessBlocked(appSessionId: string): boolean {
    if (!this.isReserved(appSessionId)) return false
    try {
      const state = this.snapshot(appSessionId)
      const row = this.deps.row(appSessionId)
      const generation = this.deps.host.getSessionGeneration(appSessionId)
      const live = this.observations.get(appSessionId)
      return !state || row?.binding?.kind !== 'project' || row.cwd !== state.target.cwd ||
        row.engineSessionId !== state.engineSessionId || state.continuation.outcome !== 'pending' ||
        !live || live.observerGeneration !== generation || live.operationId !== state.operationId ||
        live.continuationId !== state.continuation.id || live.record.kind !== 'valid' ||
        !live.record.record.consumed || !live.record.record.inputCommitted ||
        !workspaceJumpAllowsQueuedInput(state, live)
    } catch { return true }
  }
  requiresReview(appSessionId: string): boolean {
    try { return this.snapshot(appSessionId)?.review.required === true } catch { return true }
  }
  private save(state: WorkspaceJumpStateV2): void {
    const saved = { ...state, revision: state.revision + 1 }
    writeWorkspaceJump(saved, this.directory)
    this.deps.onStateChanged?.(saved)
  }
  private identity(appSessionId: string): WorkspaceJumpIdentity | null {
    const row = this.deps.row(appSessionId)
    const generation = this.deps.host.getSessionGeneration(appSessionId)
    return row?.engineSessionId && generation ? { appSessionId, engineSessionId: row.engineSessionId, generation } : null
  }
  private generationCancellations(identity: WorkspaceJumpIdentity, create = false): GenerationCancellations | undefined {
    let entry = this.cancellations.get(identity.appSessionId)
    if (entry && (entry.generation !== identity.generation || entry.engineSessionId !== identity.engineSessionId)) {
      this.cancellations.delete(identity.appSessionId)
      entry = undefined
    }
    if (!entry && create) {
      entry = { engineSessionId: identity.engineSessionId, generation: identity.generation, operationIds: new Set(), closed: false }
      this.cancellations.set(identity.appSessionId, entry)
    }
    return entry
  }
  private cancellationBlocks(identity: WorkspaceJumpIdentity, operationId: string): boolean {
    const entry = this.generationCancellations(identity)
    return !!entry && (entry.closed || entry.operationIds.has(operationId))
  }
  private cancelUnaccepted(identity: WorkspaceJumpIdentity, operationId: string): void {
    const entry = this.generationCancellations(identity, true)!
    if (entry.operationIds.size >= MAX_CANCELLED_OPERATIONS_PER_GENERATION && !entry.operationIds.has(operationId)) entry.closed = true
    else entry.operationIds.add(operationId)
    // These tombstones need not survive main: its restart destroys destination
    // handles and source process generations. Pending accepts recheck generation;
    // durable acceptance is always represented by the separate operation ledger.
  }
  private eligible(appSessionId: string): boolean {
    const row = this.deps.row(appSessionId)
    const identity = this.identity(appSessionId)
    if (row?.binding?.kind !== 'managed' || !row.engineSessionId || row.createdBy || !identity || this.generationCancellations(identity)?.closed) return false
    const state = this.snapshot(appSessionId)
    if (state && (state.engineSessionId !== row.engineSessionId || state.consumed || workspaceJumpRequiresRetention(state))) return false
    // Existing manual/legacy attachments cannot reset the one-shot capability.
    const record = readSessionRelocation(row.engineSessionId)
    return record === null || hasVerifiedSourceCompensation(state, record, appSessionId, row.engineSessionId, row.cwd)
  }
  private roots(): string[] {
    const candidates = new Map<string, number>()
    for (const project of this.deps.knownProjects()) {
      const used = Number.isFinite(project.lastUsedAt) ? project.lastUsedAt : 0
      candidates.set(project.path, Math.max(candidates.get(project.path) ?? used, used))
    }
    const recent = new Map<string, number>()
    for (const [path, used] of candidates) {
      const validated = this.deps.validateCwd(path)
      if (!validated.ok) continue
      recent.set(validated.realpath, Math.max(recent.get(validated.realpath) ?? 0, used))
    }
    // Conversation duplicates and aliases cannot consume the workspace bound.
    return [...recent].sort(([a, at], [b, bt]) => bt - at || a.localeCompare(b)).slice(0, 128).map(([path]) => path)
  }
  private async list(appSessionId: string): Promise<Result<'workspaces.list'>> {
    for (const [handle, entry] of this.handles) {
      const current = this.identity(entry.appSessionId)
      if (!current || current.generation !== entry.generation) this.handles.delete(handle)
    }
    for (const [id, entry] of this.cancellations) {
      const current = this.identity(id)
      if (!current || current.generation !== entry.generation || current.engineSessionId !== entry.engineSessionId) this.cancellations.delete(id)
    }
    if (!this.eligible(appSessionId)) return { ok: true, value: { workspaces: [], eligible: false } }
    const identity = this.identity(appSessionId)!
    const roots = this.roots()
    const trusted = new Set(await this.deps.trustedProjectRoots(roots))
    if (!this.eligible(appSessionId) || this.identity(appSessionId)?.generation !== identity.generation) return refuse('This Chat changed while projects were listed')
    const available = roots.filter(path => trusted.has(path))
    const previous = new Map<string, string>()
    for (const [handle, entry] of this.handles) {
      if (entry.appSessionId !== appSessionId) continue
      if (!available.includes(entry.path)) this.handles.delete(handle)
      else previous.set(entry.path, handle)
    }
    // Frozen initial context can keep selecting a still-current handle after a
    // later listing. Only current canonical roots retain discovery authority.
    const workspaces = available.map(path => {
      const handle = previous.get(path) ?? randomUUID()
      this.handles.set(handle, { appSessionId, generation: identity.generation, path })
      return { handle, name: basename(path), path }
    })
    return { ok: true, value: { workspaces, eligible: true } }
  }
  private async accept(appSessionId: string, operationId: string, handle: string, onAccepted: () => void): Promise<Result<'workspace.jump'>> {
    if (!UUID.test(operationId) || this.accepting.has(appSessionId)) return refuse('A workspace change is already being considered')
    this.accepting.set(appSessionId, operationId)
    let reserved = false
    try {
      if (this.snapshot(appSessionId)?.operationId === operationId) return refuse('This workspace request has already been handled')
      if (!this.eligible(appSessionId)) return refuse('This Chat cannot select another workspace')
      const identity = this.identity(appSessionId)!
      if (this.cancellationBlocks(identity, operationId)) return refuse('This workspace request was cancelled')
      const destination = this.handles.get(handle)
      if (!destination || destination.appSessionId !== appSessionId || destination.generation !== identity.generation) return refuse('List the available projects again before selecting one')
      const roots = this.roots()
      const canonical = this.deps.validateCwd(destination.path)
      if (!canonical.ok || canonical.realpath !== destination.path || !roots.includes(destination.path) ||
          !(await this.deps.trustedProjectRoots([destination.path])).includes(destination.path)) return refuse('This project is no longer available and trusted')
      if (!this.eligible(appSessionId) || this.identity(appSessionId)?.generation !== identity.generation ||
          this.cancellationBlocks(identity, operationId)) return refuse('This Chat changed before the workspace request completed')
      const held = await this.deps.host.reserveWorkspaceJump(appSessionId, operationId, identity.generation)
      if (!held.ok) return refuse(held.error.message)
      reserved = true
      if (this.identity(appSessionId)?.generation !== identity.generation || this.cancellationBlocks(identity, operationId)) {
        this.deps.host.releaseWorkspaceJump(appSessionId, operationId)
        reserved = false
        return refuse('This workspace change was cancelled')
      }
      const row = this.deps.row(appSessionId)!
      const previous = this.snapshot(appSessionId)
      this.save({ version: 2, revision: 1, origin: 'fresh', sourceGeneration: identity.generation,
        appSessionId, engineSessionId: identity.engineSessionId, operationId,
        source: { cwd: row.cwd, binding: row.binding! }, target: { cwd: destination.path, binding: { kind: 'project' } },
        acceptedAt: (this.deps.now ?? Date.now)(), phase: 'accepted', location: 'source', consumed: false, cancellation: null,
        review: { required: false, noticeUuid: null, reconciledInputUuid: null }, release: { target: 'held', authorizedRevision: null, confirmed: null },
        ...(previous?.compensation ? { compensation: previous.compensation } : {}),
        continuation: { id: randomUUID(), admissionGeneration: null, dispatch: 'none', outcome: 'pending', receiptRevision: null, checkpointSha256: null },
      } as WorkspaceJumpStateV2)
      onAccepted()
      this.acceptedTimings.set(appSessionId, { operationId,
        end: this.timing.start({ ...identity, operationId }, 'accepted_to_provider_request_observed'),
        boundary: this.timing.start({ ...identity, operationId }, 'accepted_to_source_boundary') })
      return { ok: true, value: { operationId, status: 'accepted' } }
    } catch {
      if (reserved) {
        // Rename or its state notification may have succeeded before throwing.
        // Only a readable snapshot proving no publication can release authority.
        let unpublished = false
        try { unpublished = this.snapshot(appSessionId)?.operationId !== operationId } catch { /* Retain uncertain publication. */ }
        if (unpublished) this.deps.host.releaseWorkspaceJump(appSessionId, operationId)
      }
      return refuse('The workspace request could not be saved safely')
    }
    finally { this.accepting.delete(appSessionId) }
  }
  private async ready(appSessionId: string, request: Extract<WorkspaceRequest, { verb: 'workspace.ready' }>): Promise<Result<'workspace.ready'>> {
    const state = this.snapshot(appSessionId)
    const identity = this.identity(appSessionId)
    if (!state || !identity || state.operationId !== request.operationId || state.engineSessionId !== identity.engineSessionId ||
        state.sourceGeneration !== identity.generation || state.cancellation) return refuse('This workspace change is no longer awaiting readiness')
    const boundary = { tipUuid: request.tipUuid, toolUseId: request.toolUseId }
    if (state.phase === 'ready' && state.boundary?.tipUuid === boundary.tipUuid && state.boundary.toolUseId === boundary.toolUseId) {
      return { ok: true, value: { operationId: state.operationId, status: 'ready' } }
    }
    if (state.phase !== 'accepted') return refuse('This workspace change is no longer awaiting readiness')
    if (!(await this.deps.verifyReady(identity, boundary, state))) return refuse('This Chat has not reached a durable idle boundary')
    const canonical = this.deps.validateCwd(state.target.cwd)
    if (!canonical.ok || canonical.realpath !== state.target.cwd || !this.roots().includes(state.target.cwd) ||
      !(await this.deps.trustedProjectRoots([state.target.cwd])).includes(state.target.cwd)) return refuse('This project is no longer available and trusted')
    const current = this.snapshot(appSessionId)
    if (!current || current.operationId !== state.operationId || current.phase !== 'accepted' || current.cancellation ||
        this.identity(appSessionId)?.generation !== state.sourceGeneration) return refuse('This workspace change was cancelled or replaced')
    this.save({ ...current, phase: 'ready', boundary })
    this.acceptedTimings.get(appSessionId)?.boundary()
    return { ok: true, value: { operationId: state.operationId, status: 'ready' } }
  }
  async handleRequest(appSessionId: string, request: WorkspaceRequest, receivedAt = this.timing.now()): Promise<Result> {
    try {
      switch (request.verb) {
        case 'workspaces.list': return await this.timing.span({ ...this.identity(appSessionId), appSessionId }, 'catalog', () => this.list(appSessionId))
        case 'workspace.jump': {
          // Production supplies main's supervisor-frame receipt clock, before
          // peer-plane validation. Direct internal callers default to dispatch.
          // Both spans include validation, fresh trust, reservation and save.
          const identity = { ...this.identity(appSessionId), appSessionId, operationId: request.operationId }
          const acceptance = this.timing.start(identity, 'request_received_to_acceptance', receivedAt)
          const received = this.timing.start(identity, 'request_received_to_provider_request_observed', receivedAt)
          try {
            const result = await this.accept(appSessionId, request.operationId, request.destinationHandle, acceptance)
            const pending = this.acceptedTimings.get(appSessionId)
            if (result.ok && pending?.operationId === request.operationId) {
              acceptance()
              pending.received = received
            } else {
              acceptance('unavailable')
              received('unavailable')
            }
            return result
          } catch (error) {
            acceptance('failed')
            received('unavailable')
            throw error
          }
        }
        case 'workspace.ready': return await this.ready(appSessionId, request)
        case 'workspace.cancel': {
          const state = this.snapshot(appSessionId)
          if (!(await this.cancel(appSessionId, request.operationId))) return refuse('This workspace change is no longer current')
          return { ok: true, value: { operationId: request.operationId, status: state?.operationId === request.operationId ? 'cancelled' : 'not_accepted' } }
        }
      }
    } catch { return refuse('The saved workspace change needs recovery before proceeding') }
  }
  /** Invoke only AFTER host.result was forwarded. Acceptance never starts movement. */
  afterResponse(appSessionId: string, request: WorkspaceRequest, answered: boolean): void {
    if (request.verb === 'workspace.jump' && !answered) { void this.cancel(appSessionId, request.operationId); return }
    if (request.verb !== 'workspace.ready') return
    if (!answered) { void this.cancel(appSessionId, request.operationId); return }
    if (this.running.has(appSessionId)) return
    const task = this.move(appSessionId, request.operationId).catch(() => {
      this.scheduleObservation(appSessionId)
    }).finally(() => {
      this.running.delete(appSessionId)
      try {
        if (this.liveMoves.get(appSessionId)?.operationId === request.operationId &&
            this.snapshot(appSessionId)?.continuation.admissionGeneration !== this.identity(appSessionId)?.generation) this.liveMoves.delete(appSessionId)
      } catch { this.liveMoves.delete(appSessionId) /* Durable unreadable state remains retained. */ }
    })
    this.running.set(appSessionId, task)
  }
  async cancel(appSessionId: string, operationId?: string, requestedBy: 'stop' | 'close' = 'stop'): Promise<boolean> {
    const state = this.snapshot(appSessionId)
    const identity = this.identity(appSessionId)
    if (!identity) return false
    const requestedOperation = operationId ?? this.accepting.get(appSessionId) ?? state?.operationId
    if (!requestedOperation || !UUID.test(requestedOperation)) return false
    if (state?.operationId !== requestedOperation) { this.cancelUnaccepted(identity, requestedOperation); return true }
    if (state.engineSessionId !== identity.engineSessionId) return false
    if (!workspaceJumpRequiresRetention(state, identity.generation)) return false
    const cancellation = state.cancellation ?? { cancelId: randomUUID(), requestedBy, application: 'unknown' as const }
    this.save({ ...state, cancellation: { ...cancellation, requestedBy: requestedBy === 'close' ? 'close' : cancellation.requestedBy } })
    this.effect(appSessionId, { action: 'cancel', cancelId: cancellation.cancelId })
    if (state.phase === 'accepted' || state.phase === 'ready') this.settleWarning(appSessionId, 'cancelled')
    return true
  }
  private effect(appSessionId: string, action: WorkspaceControlAction, retry = false): void {
    const state = this.snapshot(appSessionId)
    const generation = this.identity(appSessionId)?.generation
    if (this.disposed || !state || !generation) return
    const key = `${state.operationId}:${generation}:${JSON.stringify(action)}`
    if (this.effectKeys.has(key)) return
    this.effectKeys.add(key)
    let sent = false
    const task = Promise.resolve().then(async () => {
      if (action.action !== 'cancel' && this.deps.waitForControlSlot) {
        do {
          if (!await this.deps.waitForControlSlot(appSessionId, state.operationId, generation)) return { kind: 'unavailable' } as const
        } while (this.deps.controlSlotOccupied?.(appSessionId, state.operationId))
      }
      const current = this.snapshot(appSessionId)
      const identity = this.identity(appSessionId)
      const row = this.deps.row(appSessionId)
      if (this.disposed || !current || current.operationId !== state.operationId || identity?.generation !== generation ||
          action.action === 'release' && current.release.authorizedRevision !== action.authorizationRevision ||
          action.action === 'continue' && (current.engineSessionId !== state.engineSessionId || identity.engineSessionId !== state.engineSessionId ||
            current.sourceGeneration !== state.sourceGeneration || current.continuation.id !== state.continuation.id ||
            current.target.cwd !== state.target.cwd || row?.cwd !== state.target.cwd || row.binding?.kind !== 'project' ||
            current.location !== 'destination' || current.phase !== 'settled' || current.cancellation ||
            current.continuation.admissionGeneration !== generation || current.continuation.dispatch === 'consumed' ||
            current.continuation.outcome !== 'pending')) return { kind: 'unavailable' } as const
      if (retry) {
        if (!this.canRetry(appSessionId) || (this.redeliveries.get(state.operationId) ?? 0) >= 1) return { kind: 'unavailable' } as const
        this.redeliveries.set(state.operationId, 1)
      }
      if (action.action === 'continue') {
        const prior = this.observations.get(appSessionId)
        this.freshEvidence.set(`${state.operationId}:${generation}`,
          prior?.admissionGeneration === current.continuation.admissionGeneration ? prior.statusSeq : 0)
        this.liveMoves.delete(appSessionId)
      }
      sent = true
      return this.deps.control(current, action)
    }).then(delivery => {
      const current = this.snapshot(appSessionId)
      if (!current || current.operationId !== state.operationId || this.identity(appSessionId)?.generation !== generation) return
      if (action.action === 'continue' && delivery.kind === 'result' && delivery.result.disposition === 'refused') {
        this.refusedContinuations.add(`${state.operationId}:${generation}`)
      }
      if (sent && (delivery.kind !== 'result' || delivery.result.disposition === 'busy' ||
          delivery.result.disposition === 'accepted' && action.action === 'continue' && !delivery.result.status)) this.scheduleObservation(appSessionId)
      if (action.action === 'continue' && delivery.kind === 'result' &&
          (delivery.result.disposition === 'accepted' || delivery.result.disposition === 'already_applied')) {
        const pending = this.acceptedTimings.get(appSessionId)
        pending?.admission?.()
        if (pending) pending.admissionObserved = true
        if (pending?.providerObserved) this.acceptedTimings.delete(appSessionId)
      }
      if (action.action === 'continue' && delivery.kind !== 'result' && current.continuation.dispatch === 'consumed') {
        const pending = this.acceptedTimings.get(appSessionId)
        pending?.admission?.('unavailable')
        if (pending) pending.admissionObserved = true
        if (pending?.providerObserved) this.acceptedTimings.delete(appSessionId)
      }
    }).finally(() => {
      this.effectKeys.delete(key)
      this.effects.delete(task)
      if (action.action === 'status' || action.action === 'continue') this.retryContinuation(appSessionId)
    }).catch(() => { if (sent) this.scheduleObservation(appSessionId) })
    this.effects.add(task)
  }
  private canRetry(appSessionId: string): boolean {
    const state = this.snapshot(appSessionId)
    const status = this.observations.get(appSessionId)
    const generation = this.identity(appSessionId)?.generation
    if (!state || !status || !generation || status.operationId !== state.operationId ||
        status.observerGeneration !== generation || status.admissionGeneration !== state.continuation.admissionGeneration ||
        status.execution !== 'idle' || status.record.kind !== 'absent' ||
        state.continuation.admissionGeneration !== generation || state.continuation.dispatch !== 'unknown' ||
        state.continuation.outcome !== 'pending' || state.cancellation ||
        this.refusedContinuations.has(`${state.operationId}:${generation}`) ||
        status.statusSeq <= (this.freshEvidence.get(`${state.operationId}:${generation}`) ?? -1)) return false
    return true
  }
  private retryContinuation(appSessionId: string): void {
    if (!this.canRetry(appSessionId)) return
    const state = this.snapshot(appSessionId)!
    const generation = this.identity(appSessionId)!.generation
    const action = { action: 'continue' as const, continuationId: state.continuation.id }
    const prefix = `${state.operationId}:${generation}:`
    // State can arrive before the status acknowledgement frees the command slot.
    // Neither that wait nor an already scheduled continuation spends the retry.
    if (this.effectKeys.has(`${prefix}${JSON.stringify({ action: 'status' })}`) ||
        this.effectKeys.has(`${prefix}${JSON.stringify(action)}`)) return
    const attempts = this.redeliveries.get(state.operationId) ?? 0
    if (attempts < 1) {
      this.effect(appSessionId, action, true)
    }
  }
  private settleWarning(appSessionId: string, outcome: 'failed' | 'cancelled' | 'uncertain'): void {
    const pending = this.acceptedTimings.get(appSessionId)
    pending?.end('unavailable'); pending?.received?.('unavailable'); pending?.boundary('unavailable'); pending?.admission?.('unavailable')
    this.acceptedTimings.delete(appSessionId)
    const state = this.snapshot(appSessionId)
    if (!state || state.location === 'unknown') return
    this.save({ ...state, phase: 'settled', review: { ...state.review, required: true } })
    this.effect(appSessionId, { action: 'settle', outcome })
  }
  /** Observation is a short durable transition, never locked by an RPC. */
  observe(appSessionId: string, status: WorkspaceHandoffSnapshot): boolean {
    if (!isWorkspaceHandoffSnapshot(status)) return false
    const state = this.snapshot(appSessionId)
    const generation = this.identity(appSessionId)?.generation
    if (!state || !generation || status.observerGeneration !== generation || status.appSessionId !== appSessionId || status.engineSessionId !== state.engineSessionId || status.operationId !== state.operationId || status.continuationId !== state.continuation.id || status.sourceGeneration !== state.sourceGeneration || status.admissionGeneration !== state.continuation.admissionGeneration || status.operationSha256 !== workspaceJumpOperationSha256(state)) return false
    const previous = this.observations.get(appSessionId)
    if (previous?.operationId === state.operationId && previous.observerGeneration === generation &&
        previous.admissionGeneration === status.admissionGeneration && previous.statusSeq >= status.statusSeq) return false
    let next = state
    if (status.record.kind === 'valid') {
      const record = status.record.record
      if (state.review.noticeUuid && record.notice?.displayUuid !== state.review.noticeUuid || state.review.reconciledInputUuid && record.reconciliation?.inputUuid !== state.review.reconciledInputUuid || record.terminal && state.continuation.checkpointSha256 && record.terminal.checkpoint.prefixSha256 !== state.continuation.checkpointSha256 || record.admissionGeneration !== state.continuation.admissionGeneration || record.terminal && !['pending','unknown',record.terminal.outcome].includes(state.continuation.outcome) || record.revision < (state.continuation.receiptRevision ?? 0)) return false
      const prior = previous?.operationId === state.operationId && previous.record.kind === 'valid' ? previous.record.record : undefined
      if (prior && (prior.consumed && !record.consumed || prior.inputCommitted && !record.inputCommitted || prior.terminal && JSON.stringify(prior.terminal) !== JSON.stringify(record.terminal) || prior.notice && JSON.stringify(prior.notice) !== JSON.stringify(record.notice) || prior.reconciliation && JSON.stringify(prior.reconciliation) !== JSON.stringify(record.reconciliation) || prior.cancellation && JSON.stringify(prior.cancellation) !== JSON.stringify(record.cancellation) || prior.revision === record.revision && JSON.stringify(prior) !== JSON.stringify(record))) return false
      next = { ...next, continuation: { ...next.continuation, dispatch: record.consumed ? 'consumed' : next.continuation.dispatch, receiptRevision: record.revision } }
      if (record.cancellation && next.cancellation?.cancelId === record.cancellation.cancelId) next = { ...next, cancellation: { ...next.cancellation, application: record.cancellation.application } }
      if (record.terminal) next = { ...next, continuation: { ...next.continuation, outcome: record.terminal.outcome, checkpointSha256: record.terminal.checkpoint.prefixSha256 } }
      if (record.notice) next = { ...next, review: { ...next.review, required: true, noticeUuid: record.notice.displayUuid } }
      if (record.reconciliation && record.notice?.displayUuid === record.reconciliation.noticeUuid) next = { ...next, review: { required: false, noticeUuid: record.reconciliation.noticeUuid, reconciledInputUuid: record.reconciliation.inputUuid } }
      if (next.continuation.outcome === 'success' || next.review.reconciledInputUuid) next = { ...next, release: { ...next.release, target: 'open' } }
      else if (record.notice) next = { ...next, release: { ...next.release, target: 'review' } }
    }
    if (status.execution === 'unconfirmed' && next.continuation.outcome === 'pending') next = { ...next, continuation: { ...next.continuation, outcome: 'unknown' } }
    this.observations.set(appSessionId, status)
    if (next.release.target !== state.release.target) next = { ...next, release: { ...next.release, authorizedRevision: null, confirmed: null } }
    if (next.release.target !== 'held' && next.release.authorizedRevision === null) next = { ...next, release: { ...next.release, authorizedRevision: next.revision + 1 } }
    const gateMatches = next.release.authorizedRevision !== null && status.gate.mode === next.release.target && status.gate.reservationOperationId === null && status.gate.requiresUserReconciliation === (next.release.target === 'review')
    if (gateMatches) next = { ...next, release: { ...next.release, confirmed: { generation, mode: status.gate.mode as 'review' | 'open' } } }
    if (JSON.stringify(next) !== JSON.stringify(state)) this.save(next)
    if (gateMatches) this.deps.host.releaseWorkspaceJump(appSessionId, state.operationId)
    else if (next.release.target !== 'held' && next.release.authorizedRevision !== null) this.effect(appSessionId, { action: 'release', authorizationRevision: next.release.authorizedRevision })
    else if (status.execution === 'unconfirmed' && next.continuation.outcome !== 'success' && !next.review.noticeUuid) this.effect(appSessionId, { action: 'settle', outcome: 'uncertain' })
    else if (['idle','terminal'].includes(status.execution) && next.continuation.outcome !== 'success' && !next.review.noticeUuid && (next.cancellation || next.continuation.outcome !== 'pending')) this.settleWarning(appSessionId, next.cancellation?.application === 'prevented_start' || next.cancellation?.application === 'abort_signalled' ? 'cancelled' : next.continuation.dispatch === 'none' ? 'failed' : 'uncertain')
    else this.retryContinuation(appSessionId)
    return true
  }
  liveObservation(appSessionId: string): WorkspaceHandoffSnapshot | undefined { return this.observations.get(appSessionId) }
  queryStatus(appSessionId: string, attachment = false): void {
    try {
      if (this.disposed || !(attachment || this.retains(appSessionId))) return
      const owner = this.liveMoves.get(appSessionId)
      const state = this.snapshot(appSessionId)
      const identity = this.identity(appSessionId)
      const row = this.deps.row(appSessionId)
      if (owner && state && identity && owner.operationId === state.operationId &&
          owner.engineSessionId === identity.engineSessionId && owner.continuationId === state.continuation.id &&
          owner.sourceGeneration === state.sourceGeneration && owner.destination === state.target.cwd &&
          row?.cwd === owner.destination && row.binding?.kind === 'project' &&
          identity.generation !== owner.sourceGeneration && (!owner.generation || owner.generation === identity.generation) &&
          !state.cancellation && state.continuation.outcome === 'pending' && state.continuation.dispatch !== 'consumed' &&
          (state.phase === 'moving' || state.continuation.admissionGeneration === identity.generation)) {
        owner.generation = identity.generation
        return
      }
      this.clearObservationRetry(appSessionId)
      this.effect(appSessionId, { action: 'status' })
    } catch { /* Unreadable state remains retained. */ }
  }
  private clearObservationRetry(appSessionId: string): void {
    const retry = this.observationRetries.get(appSessionId)
    if (retry?.timer) clearTimeout(retry.timer)
    this.observationRetries.delete(appSessionId)
  }
  private scheduleObservation(appSessionId: string): void {
    let state: WorkspaceJumpStateV2 | null
    try { state = this.snapshot(appSessionId) } catch { /* Retain unreadable state for periodic recovery. */ return }
    const generation = this.identity(appSessionId)?.generation
    if (this.disposed || !state || !generation || !this.retains(appSessionId)) return
    let retry = this.observationRetries.get(appSessionId)
    if (!retry || retry.operationId !== state.operationId || retry.generation !== generation) {
      this.clearObservationRetry(appSessionId)
      retry = { operationId: state.operationId, generation, attempts: 0 }
      this.observationRetries.set(appSessionId, retry)
    }
    if (retry.timer || retry.attempts >= 3) return
    const scheduled = retry
    retry.timer = setTimeout(() => {
      scheduled.timer = undefined
      try {
        if (this.disposed || !this.retains(appSessionId) || this.snapshot(appSessionId)?.operationId !== scheduled.operationId ||
            this.identity(appSessionId)?.generation !== scheduled.generation) return
        this.effect(appSessionId, { action: 'status' })
      } catch { /* Unreadable state remains retained for periodic recovery. */ }
    }, [250, 1_000, 4_000][retry.attempts++]!)
    retry.timer.unref?.()
  }
  requestFreshEvidence(appSessionId: string): void { this.scheduleObservation(appSessionId) }
  dispose(): void {
    this.disposed = true
    this.liveMoves.clear()
    for (const id of this.observationRetries.keys()) this.clearObservationRetry(id)
  }
  private async move(appSessionId: string, operationId: string): Promise<void> {
    const state = this.snapshot(appSessionId)
    if (!state || state.operationId !== operationId || state.origin !== 'fresh' || state.phase !== 'ready' || state.cancellation ||
        state.continuation.admissionGeneration !== null || state.continuation.dispatch !== 'none' ||
        this.identity(appSessionId)?.generation !== state.sourceGeneration) return
    const owner: LiveMove = { operationId, engineSessionId: state.engineSessionId, continuationId: state.continuation.id,
      sourceGeneration: state.sourceGeneration, destination: state.target.cwd }
    this.liveMoves.set(appSessionId, owner)
    const moved = await this.deps.host.moveWorkspaceJump(appSessionId, operationId, state.target.cwd, () => {
      const current = this.snapshot(appSessionId)
      if (this.liveMoves.get(appSessionId) !== owner || !current || current.operationId !== operationId ||
          current.engineSessionId !== owner.engineSessionId || current.sourceGeneration !== owner.sourceGeneration ||
          current.continuation.id !== owner.continuationId || current.target.cwd !== owner.destination ||
          current.cancellation || current.phase !== 'ready') return false
      this.save({ ...current, phase: 'moving', location: 'unknown' })
      return true
    })
    const current = this.snapshot(appSessionId)
    if (this.disposed || this.liveMoves.get(appSessionId) !== owner || !current || current.operationId !== operationId || current.engineSessionId !== state.engineSessionId || current.sourceGeneration !== state.sourceGeneration || this.identity(appSessionId)?.engineSessionId !== state.engineSessionId ||
        current.continuation.id !== owner.continuationId || current.target.cwd !== owner.destination) return
    const compensation = moved.location === 'source' && moved.relocation?.phase === 'complete' &&
      moved.relocation.source.cwd === current.target.cwd && moved.relocation.source.binding.kind === 'project' &&
      JSON.stringify(moved.relocation.target) === JSON.stringify(current.source)
      ? { movedAt: moved.relocation.movedAt, backup: moved.relocation.backup, projectCwd: moved.relocation.source.cwd }
      : current.compensation
    this.save({ ...current, location: moved.location, consumed: current.consumed || moved.location === 'destination',
      ...(compensation ? { compensation } : {}) })
    if (!moved.result.ok || moved.location !== 'destination' || current.cancellation) {
      this.liveMoves.delete(appSessionId)
      this.settleWarning(appSessionId, current.cancellation ? 'cancelled' : 'failed')
      return
    }
    const next = this.snapshot(appSessionId)!
    const generation = this.identity(appSessionId)?.generation
    if (owner.generation && generation !== owner.generation) {
      this.liveMoves.delete(appSessionId)
      this.settleWarning(appSessionId, 'uncertain')
      return
    }
    if (!generation || generation === state.sourceGeneration || this.deps.row(appSessionId)?.cwd !== owner.destination ||
        this.deps.row(appSessionId)?.binding?.kind !== 'project' || next.continuation.outcome !== 'pending') return
    this.save({ ...next, phase: 'settled', continuation: { ...next.continuation, admissionGeneration: generation, dispatch: 'unknown' } })
    const pending = this.acceptedTimings.get(appSessionId)
    if (pending?.operationId === operationId) pending.admission = this.timing.start({ appSessionId, engineSessionId: state.engineSessionId, operationId, generation }, 'admission_to_continuation')
    this.effect(appSessionId, { action: 'continue', continuationId: next.continuation.id })
  }
  async settleRecovery(appSessionId: string, operationId: string): Promise<boolean> {
    const state = this.snapshot(appSessionId)
    if (!state || state.operationId !== operationId) return false
    this.queryStatus(appSessionId)
    return true
  }
  /** Legacy notice callers request fresh cumulative evidence, never clear it. */
  async reconcileUser(appSessionId: string, operationId?: string): Promise<boolean> {
    const state = this.snapshot(appSessionId)
    if (!state) return true
    if (operationId !== undefined && operationId !== state.operationId) return false
    this.queryStatus(appSessionId)
    return !state.review.required
  }
  /** Main restart/process loss: never replay accepted, ready, or admitted work. */
  recover(appSessionId: string): WorkspaceJumpStateV2 | null {
    this.liveMoves.delete(appSessionId)
    this.clearObservationRetry(appSessionId)
    const state = this.snapshot(appSessionId)
    if (!state || !workspaceJumpRequiresRetention(state)) return state
    let location: WorkspaceJumpStateV2['location'] = 'unknown'
    let compensation = state.compensation
    try {
      const move = readSessionRelocation(state.engineSessionId)
      if (!move) location = state.consumed || state.location === 'destination' ? 'unknown' : 'source'
      else if (move.appSessionId === appSessionId && move.phase === 'complete') {
        if (move.target.cwd === state.target.cwd) location = 'destination'
        else if (move.target.cwd === state.source.cwd) {
          location = 'source'
          if (state.phase === 'moving' && move.movedAt >= state.acceptedAt && move.source.cwd === state.target.cwd &&
              move.source.binding.kind === 'project' && JSON.stringify(move.target) === JSON.stringify(state.source)) {
            compensation = { movedAt: move.movedAt, backup: move.backup, projectCwd: move.source.cwd }
          }
        }
      }
    } catch { /* Retain unreadable relocation and refuse recovery admission. */ }
    const recovered: WorkspaceJumpStateV2 = { ...state, phase: 'settled', location, consumed: state.consumed || location === 'destination',
      ...(compensation ? { compensation } : {}),
      continuation: { ...state.continuation, outcome: state.continuation.outcome === 'pending' ? 'unknown' : state.continuation.outcome },
      release: { ...state.release, confirmed: null } }
    this.save(recovered)
    return recovered
  }
  async waitForSettlement(appSessionId: string): Promise<void> { await this.running.get(appSessionId); while (this.effects.size) await Promise.all([...this.effects]) }
}
