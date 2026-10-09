/** Owns the one-shot operation, not the model's workspace judgment.
 * HOST-REQUEST-PLANE and CHAT-RELOCATION's agent-jump amendments define authority.
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { Host, CwdValidation } from '../host/host.js'
import type { HostRequestValues, HostRequestError, HostRequestVerb } from '../shared/protocol.js'
import type { PeerRegistryRow, ValidatedHostRequest } from './peerRequestPlane.js'
import { readSessionRelocation } from '../../src/utils/sessionRelocationState.js'
import {
  hasVerifiedSourceCompensation, loadWorkspaceJumpRetention, readWorkspaceJump, workspaceJumpDirectory, workspaceJumpRequiresRetention, writeWorkspaceJump,
  type WorkspaceJumpBoundary, type WorkspaceJumpState,
} from '../../src/utils/workspaceJumpState.js'

export { loadWorkspaceJumpRetention, workspaceJumpAllowsQueuedInput } from '../../src/utils/workspaceJumpState.js'
export type { WorkspaceJumpState } from '../../src/utils/workspaceJumpState.js'

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
  verifyReady: (identity: WorkspaceJumpIdentity, boundary: WorkspaceJumpBoundary, state: WorkspaceJumpState) => boolean | Promise<boolean>
  /** Engine-owned persistence writes trusted failure/cancellation, never main. */
  persistTerminalOutcome: (state: WorkspaceJumpState) => Promise<boolean>
  /** Ledger admission is already durable. Admit this exact id once via the real
   * controller; resolve only on settlement. Throw/lost acknowledgement is uncertain.
   */
  continueDestination: (state: WorkspaceJumpState) => Promise<void>
  /** Holds source/destination turn admission and user reconciliation gates. */
  onStateChanged?: (state: WorkspaceJumpState) => void
  directory?: string
  now?: () => number
}

const refuse = (message: string): { ok: false; error: HostRequestError } => ({ ok: false, error: { code: 'unavailable', message } })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_CANCELLED_OPERATIONS_PER_GENERATION = 128
type GenerationCancellations = { engineSessionId: string; generation: string; operationIds: Set<string>; closed: boolean }

export class WorkspaceJumpCoordinator {
  private readonly directory: string
  private readonly handles = new Map<string, { appSessionId: string; generation: string; path: string }>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly accepting = new Map<string, string>()
  private readonly cancellations = new Map<string, GenerationCancellations>()
  constructor(private readonly deps: WorkspaceJumpCoordinatorDeps) { this.directory = deps.directory ?? workspaceJumpDirectory() }

  snapshot(appSessionId: string): WorkspaceJumpState | null { return readWorkspaceJump(appSessionId, this.directory) }
  loadRetention(): ReturnType<typeof loadWorkspaceJumpRetention> { return loadWorkspaceJumpRetention(this.directory) }
  /** Retire only ephemeral discovery authority; durable history is never erased. */
  forgetHandles(appSessionId: string): void {
    for (const [handle, entry] of this.handles) if (entry.appSessionId === appSessionId) this.handles.delete(handle)
    if (!this.identity(appSessionId)) this.cancellations.delete(appSessionId)
  }
  retains(appSessionId: string): boolean {
    try { const s = this.snapshot(appSessionId); return !!s && workspaceJumpRequiresRetention(s) }
    catch { return true }
  }
  isReserved(appSessionId: string): boolean {
    try { const s = this.snapshot(appSessionId); return !!s && workspaceJumpRequiresRetention(s) }
    catch { return true }
  }
  private save(state: WorkspaceJumpState): void {
    writeWorkspaceJump(state, this.directory)
    this.deps.onStateChanged?.(state)
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
    const recent = new Map<string, number>()
    for (const project of this.deps.knownProjects()) {
      const validated = this.deps.validateCwd(project.path)
      if (!validated.ok) continue
      const used = Number.isFinite(project.lastUsedAt) ? project.lastUsedAt : 0
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
  private async accept(appSessionId: string, operationId: string, handle: string): Promise<Result<'workspace.jump'>> {
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
      this.save({ version: 1, sourceGeneration: identity.generation,
        appSessionId, engineSessionId: identity.engineSessionId, operationId,
        source: { cwd: row.cwd, binding: row.binding! }, target: { cwd: destination.path, binding: { kind: 'project' } },
        acceptedAt: (this.deps.now ?? Date.now)(), phase: 'accepted', location: 'source', consumed: false, cancelled: false,
        requiresUserReconciliation: false, sourceOutcomePersisted: false,
        ...(previous?.compensation ? { compensation: previous.compensation } : {}),
        continuation: { id: randomUUID(), state: 'not_admitted' },
      } as WorkspaceJumpState)
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
        state.sourceGeneration !== identity.generation || state.cancelled) return refuse('This workspace change is no longer awaiting readiness')
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
    if (!current || current.operationId !== state.operationId || current.phase !== 'accepted' || current.cancelled ||
        this.identity(appSessionId)?.generation !== state.sourceGeneration) return refuse('This workspace change was cancelled or replaced')
    this.save({ ...current, phase: 'ready', boundary })
    return { ok: true, value: { operationId: state.operationId, status: 'ready' } }
  }
  async handleRequest(appSessionId: string, request: WorkspaceRequest): Promise<Result> {
    try {
      switch (request.verb) {
        case 'workspaces.list': return await this.list(appSessionId)
        case 'workspace.jump': return await this.accept(appSessionId, request.operationId, request.destinationHandle)
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
    const task = this.move(appSessionId, request.operationId).catch(() => undefined).finally(() => this.running.delete(appSessionId))
    this.running.set(appSessionId, task)
  }
  async cancel(appSessionId: string, operationId?: string): Promise<boolean> {
    const state = this.snapshot(appSessionId)
    const identity = this.identity(appSessionId)
    if (!identity) return false
    const pendingOperation = this.accepting.get(appSessionId)
    const requestedOperation = operationId ?? pendingOperation ?? state?.operationId
    if (!requestedOperation || !UUID.test(requestedOperation)) return false
    if (state?.operationId !== requestedOperation) {
      this.cancelUnaccepted(identity, requestedOperation)
      return true
    }
    if (state.engineSessionId !== identity.engineSessionId) return false
    if (state.continuation.state === 'settled' && (!state.requiresUserReconciliation || state.sourceOutcomePersisted)) {
      return state.cancelled && state.sourceOutcomePersisted
    }
    this.save({ ...state, cancelled: true, requiresUserReconciliation: true })
    if (state.phase === 'accepted' || state.phase === 'ready' ||
        (state.phase === 'settled' && !state.sourceOutcomePersisted && state.location !== 'unknown')) {
      // The source tool may itself be waiting for this cancellation reply. Its
      // durable terminal note needs idle, so acknowledgement cannot await it.
      this.startTerminal(appSessionId, 'cancelled')
    }
    return true
  }
  private startTerminal(appSessionId: string, outcome: 'failed' | 'cancelled' | 'uncertain'): Promise<void> | null {
    if (this.running.has(appSessionId)) return null
    const task = Promise.resolve().then(() => this.terminal(appSessionId, outcome))
      .catch(() => undefined).finally(() => this.running.delete(appSessionId))
    this.running.set(appSessionId, task)
    return task
  }
  private async terminal(appSessionId: string, outcome: 'failed' | 'cancelled' | 'uncertain'): Promise<void> {
    const state = this.snapshot(appSessionId)!
    // A lost acknowledgement may already have saved this exact engine note.
    // Subsequent Stop/recovery must retry its chosen kind, never replace it.
    const chosen = state.outcome && state.outcome !== 'completed' ? state.outcome : outcome
    this.save({ ...state, phase: 'settled', outcome: chosen, requiresUserReconciliation: true })
    const persisted = await this.deps.persistTerminalOutcome(this.snapshot(appSessionId)!)
    const current = this.snapshot(appSessionId)!
    if (persisted) {
      this.save({ ...current, sourceOutcomePersisted: true })
      this.deps.host.releaseWorkspaceJump(appSessionId, state.operationId)
    }
  }
  private async move(appSessionId: string, operationId: string): Promise<void> {
    const state = this.snapshot(appSessionId)
    if (!state || state.operationId !== operationId || state.phase !== 'ready' || state.cancelled) return
    const moved = await this.deps.host.moveWorkspaceJump(appSessionId, operationId, state.target.cwd, () => {
      const current = this.snapshot(appSessionId)
      if (!current || current.operationId !== operationId || current.cancelled || current.phase !== 'ready') return false
      this.save({ ...current, phase: 'moving', location: 'unknown' })
      return true
    })
    const current = this.snapshot(appSessionId)!
    const compensation = moved.location === 'source' && moved.relocation?.phase === 'complete' &&
      moved.relocation.source.cwd === current.target.cwd && moved.relocation.source.binding.kind === 'project' &&
      JSON.stringify(moved.relocation.target) === JSON.stringify(current.source)
      ? { movedAt: moved.relocation.movedAt, backup: moved.relocation.backup, projectCwd: moved.relocation.source.cwd }
      : current.compensation
    this.save({ ...current, location: moved.location, consumed: current.consumed || moved.location === 'destination',
      ...(compensation ? { compensation } : {}) })
    if (!moved.result.ok || moved.location !== 'destination' || current.cancelled) {
      await this.terminal(appSessionId, current.cancelled ? 'cancelled' : 'failed')
      return
    }
    const next = this.snapshot(appSessionId)!
    this.save({ ...next, phase: 'settled', outcome: 'completed', continuation: { ...next.continuation, state: 'admitted' } })
    // Once admitted, a thrown/lost reply is uncertain work, not permission to retry.
    try {
      await this.deps.continueDestination(this.snapshot(appSessionId)!)
      const settled = this.snapshot(appSessionId)!
      this.save({ ...settled, continuation: { ...settled.continuation, state: 'settled' } })
      if (settled.cancelled) await this.terminal(appSessionId, 'cancelled')
      else this.deps.host.releaseWorkspaceJump(appSessionId, operationId)
    } catch {
      const uncertain = this.snapshot(appSessionId)!
      const outcome = 'uncertain' as const
      this.save({ ...uncertain, outcome, requiresUserReconciliation: true,
        continuation: { ...uncertain.continuation, state: 'uncertain' } })
      await this.terminal(appSessionId, outcome)
    }
  }
  /** Explicit user admission/recovery only. It never resubmits previous work. */
  async settleRecovery(appSessionId: string, operationId: string): Promise<boolean> {
    const state = this.snapshot(appSessionId)
    if (!state || state.operationId !== operationId || state.phase !== 'settled' ||
        !state.requiresUserReconciliation || state.location === 'unknown' || this.running.has(appSessionId)) return false
    if (state.sourceOutcomePersisted) return true
    const outcome = state.continuation.state === 'admitted' || state.continuation.state === 'uncertain'
      ? 'uncertain' : state.cancelled ? 'cancelled' : 'failed'
    const task = this.startTerminal(appSessionId, outcome)
    if (!task) return false
    await task
    return this.snapshot(appSessionId)?.sourceOutcomePersisted === true
  }

  /** Called after genuine input's durable engine receipt, never enqueue acknowledgement. */
  async reconcileUser(appSessionId: string, operationId?: string): Promise<boolean> {
    const state = this.snapshot(appSessionId)
    if (!state) return true
    if (operationId !== undefined && state.operationId !== operationId) return false
    if (this.running.has(appSessionId) || state.location === 'unknown') return false
    if (!state.requiresUserReconciliation) return state.phase === 'settled'
    if (!state.sourceOutcomePersisted && state.outcome !== 'completed') {
      if (!(await this.deps.persistTerminalOutcome(state))) return false
    }
    this.save({ ...state, phase: 'settled', sourceOutcomePersisted: true, requiresUserReconciliation: false,
      continuation: { ...state.continuation, state: 'settled' } })
    this.deps.host.releaseWorkspaceJump(appSessionId, state.operationId)
    return true
  }
  /** Main restart/process loss: never replay accepted, ready, or admitted work. */
  recover(appSessionId: string): WorkspaceJumpState | null {
    const state = this.snapshot(appSessionId)
    if (!state || !workspaceJumpRequiresRetention(state)) return state
    let location: WorkspaceJumpState['location'] = 'unknown'
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
    const recovered: WorkspaceJumpState = { ...state, phase: 'settled', location, consumed: state.consumed || location === 'destination',
      ...(compensation ? { compensation } : {}),
      requiresUserReconciliation: true, outcome: state.outcome && state.outcome !== 'completed' ? state.outcome
        : state.continuation.state === 'admitted' || state.continuation.state === 'uncertain'
          ? 'uncertain' : state.cancelled ? 'cancelled' : 'failed',
      continuation: { ...state.continuation, state: state.continuation.state === 'admitted' ? 'uncertain' : state.continuation.state } }
    this.save(recovered)
    return recovered
  }
  async waitForSettlement(appSessionId: string): Promise<void> { await this.running.get(appSessionId) }
}
