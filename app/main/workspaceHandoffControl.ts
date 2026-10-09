/** Command correlation never owns execution. Late authenticated replies still
 * deliver cumulative operation evidence after their acknowledgement expires. */
import { randomUUID } from 'node:crypto'
import { PROTOCOL_VERSION } from '../shared/protocol.js'
import { MAX_HANDOFF_STATE_BYTES, MAX_HANDOFF_STATES_PER_WINDOW, HANDOFF_STATE_WINDOW_MS } from '../shared/limits.js'
import { isWorkspaceHandoffSnapshot, isHandoffUuid, isWorkspaceHandoffAction, isWorkspaceHandoffReason, type WorkspaceHandoffSnapshot } from '../shared/workspaceHandoff.js'
export type WorkspaceControlAction =
  | { action: 'verify'; tipUuid: string; toolUseId: string }
  | { action: 'continue'; continuationId: string }
  | { action: 'status' }
  | { action: 'cancel'; cancelId: string }
  | { action: 'settle'; outcome: 'failed' | 'cancelled' | 'uncertain' }
  | { action: 'release'; authorizationRevision: number }
export type WorkspaceControlResult = {
  requestId: string; operationId: string; action: WorkspaceControlAction['action']; disposition: 'accepted' | 'already_applied' | 'busy' | 'refused'; reason?: import('../shared/workspaceHandoff.js').WorkspaceHandoffReason; status?: WorkspaceHandoffSnapshot
}
export type WorkspaceControlDelivery =
  | { kind: 'result'; result: WorkspaceControlResult }
  | { kind: 'timeout' | 'disconnected' | 'unavailable' }
type Pending = { sessionId: string; operationId: string; generation: string; action: WorkspaceControlAction['action']; settle: (value: WorkspaceControlDelivery) => void }
export class WorkspaceHandoffControl {
  private readonly pending = new Map<string, Pending>()
  private readonly authorizedOperations = new Map<string, string>()
  private readonly windows = new Map<string, { started: number; count: number; latest?: WorkspaceHandoffSnapshot; timer?: ReturnType<typeof setTimeout> }>()
  private readonly operations = new Map<string, string>()
  constructor(private readonly deps: {
    generation: (sessionId: string) => string | null | undefined
    send: (sessionId: string, message: { type: 'workspace.handoff'; requestId: string; operationId: string; forGeneration: string } & WorkspaceControlAction) => boolean
    acceptsStatus: (sessionId: string, status: WorkspaceHandoffSnapshot) => boolean
    observe: (sessionId: string, status: WorkspaceHandoffSnapshot) => void
    recover: (sessionId: string, operationId: string) => void
  }) {}
  request(sessionId: string, operationId: string, action: WorkspaceControlAction): Promise<WorkspaceControlDelivery> {
    const generation = this.deps.generation(sessionId)
    const key = `${sessionId}:${operationId}`
    // Cancellation has its own priority slot. The in-flight storage/continue
    // acknowledgement cannot delay application at the engine's closure latch.
    const slot = action.action === 'cancel' ? `${key}:cancel` : key
    if (!generation || this.pending.size >= 128 || this.operations.has(slot)) return Promise.resolve({ kind: 'unavailable' })
    if (this.authorizedOperations.get(sessionId) !== operationId) {
      const previousWindow = this.windows.get(sessionId)
      if (previousWindow?.timer) clearTimeout(previousWindow.timer)
      this.windows.delete(sessionId)
      this.authorizedOperations.set(sessionId, operationId)
    }
    const requestId = randomUUID()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        settle({ kind: 'timeout' })
        this.deps.recover(sessionId, operationId)
      }, 20_000)
      const settle = (value: WorkspaceControlDelivery) => {
        clearTimeout(timer); this.pending.delete(requestId)
        if (this.operations.get(slot) === requestId) this.operations.delete(slot)
        resolve(value)
      }
      this.operations.set(slot, requestId)
      this.pending.set(requestId, { sessionId, operationId, generation, action: action.action, settle })
      try {
        if (!this.deps.send(sessionId, { type: 'workspace.handoff', requestId, operationId, forGeneration: generation, ...action })) settle({ kind: 'unavailable' })
      } catch { settle({ kind: 'unavailable' }) }
    })
  }
  receiveFrame(sessionId: string, frame: unknown): void {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return
    const f = frame as Record<string, unknown>
    const allowed = f.kind === 'workspace.handoff.result' ? ['kind','protocolVersion','sessionId','requestId','operationId','action','disposition','reason','status'] : ['kind','protocolVersion','sessionId','operationId','status']
    if (Object.keys(f).some(key => !allowed.includes(key)) || f.protocolVersion !== PROTOCOL_VERSION || f.sessionId !== sessionId || !isHandoffUuid(f.operationId) || Buffer.byteLength(JSON.stringify(f)) > MAX_HANDOFF_STATE_BYTES) return
    if (f.status !== undefined && (!isWorkspaceHandoffSnapshot(f.status) || f.status.appSessionId !== sessionId || f.status.operationId !== f.operationId || f.status.observerGeneration !== this.deps.generation(sessionId))) return
    if (f.kind === 'workspace.handoff.state') { if (isWorkspaceHandoffSnapshot(f.status)) this.receiveState(sessionId, f.status); return }
    if (f.kind !== 'workspace.handoff.result' || !isHandoffUuid(f.requestId) || !isWorkspaceHandoffAction(f.action) || !['accepted','already_applied','busy','refused'].includes(f.disposition as string)) return
    if (['busy','refused'].includes(f.disposition as string) ? !isWorkspaceHandoffReason(f.reason) : f.reason !== undefined) return
    this.receive(sessionId, f as unknown as WorkspaceControlResult)
  }
  receiveState(sessionId: string, status: WorkspaceHandoffSnapshot): void {
    if (status.appSessionId !== sessionId || status.observerGeneration !== this.deps.generation(sessionId) || this.authorizedOperations.has(sessionId) && this.authorizedOperations.get(sessionId) !== status.operationId || !this.deps.acceptsStatus(sessionId, status)) return
    const now = Date.now()
    let window = this.windows.get(sessionId)
    if (!window || now - window.started >= HANDOFF_STATE_WINDOW_MS) { if (window?.timer) clearTimeout(window.timer); window = { started: now, count: 0 }; this.windows.set(sessionId, window) }
    if (++window.count <= MAX_HANDOFF_STATES_PER_WINDOW) { this.deps.observe(sessionId, status); return }
    if (!window.latest || window.latest.observerGeneration !== status.observerGeneration || window.latest.statusSeq < status.statusSeq) window.latest = status
    if (!window.timer) window.timer = setTimeout(() => {
      const latest = window!.latest
      this.windows.delete(sessionId)
      if (latest && latest.observerGeneration === this.deps.generation(sessionId) && this.authorizedOperations.get(sessionId) === latest.operationId && this.deps.acceptsStatus(sessionId, latest)) { this.deps.observe(sessionId, latest); this.deps.recover(sessionId, latest.operationId) }
    }, Math.max(1, HANDOFF_STATE_WINDOW_MS - (now - window.started)))
  }
  receive(sessionId: string, result: WorkspaceControlResult): void {
    const generation = this.deps.generation(sessionId)
    if (!generation) return
    // The supervisor already authenticates connection membership. Operation
    // identity and monotonic status are checked by the transition owner.
    if (result.status?.observerGeneration === generation) this.receiveState(sessionId, result.status)
    const pending = this.pending.get(result.requestId)
    if (pending && pending.sessionId === sessionId && pending.operationId === result.operationId && pending.generation === generation && pending.action === result.action) pending.settle({ kind: 'result', result })
  }
  disconnect(sessionId: string): void {
    for (const pending of this.pending.values()) if (pending.sessionId === sessionId) pending.settle({ kind: 'disconnected' })
  }
  dispose(): void { for (const window of this.windows.values()) if (window.timer) clearTimeout(window.timer); this.windows.clear(); this.authorizedOperations.clear(); for (const pending of this.pending.values()) pending.settle({ kind: 'disconnected' }) }
}
