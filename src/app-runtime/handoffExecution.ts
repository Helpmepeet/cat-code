import type { ResumeCheckpointV1, WorkspaceHandoffIdentity, WorkspaceHandoffExecutionRecord,
  WorkspaceHandoffExecutionOutcome, WorkspaceHandoffRecordStatus, WorkspaceHandoffSnapshot } from '../../app/shared/workspaceHandoff.js'

export type WorkspaceHandoffConfiguration = {
  identity: WorkspaceHandoffIdentity
  observerGeneration: string
  origin: 'fresh' | 'legacy'
  recover: boolean
  historical?: true
}

/** One execution attempt. The synchronous latch orders cancellation and closure;
 * disk revisions only publish that already-established ordering.
 */
export class HandoffExecution {
  private record: WorkspaceHandoffRecordStatus = { kind: 'absent' }
  private observation: WorkspaceHandoffSnapshot['execution'] = 'idle'
  private sequence = 1
  private order = 0
  private claimed = false
  private started = false
  private frozen: { outcome: WorkspaceHandoffExecutionOutcome; order: number } | null = null
  private cancellation: WorkspaceHandoffExecutionRecord['cancellation'] = null
  private completion: Promise<void> | null = null
  private acknowledgement: Promise<void> | null = null
  private finished = false
  private fenced = false
  private publications = 0

  constructor(readonly configuration: WorkspaceHandoffConfiguration,
    private readonly changed: () => void) {}

  async recover(verify: (checkpoint: ResumeCheckpointV1) => Promise<void>): Promise<void> {
    const { readWorkspaceHandoffExecution } = await import('../utils/workspaceHandoffExecutionState.js')
    const status = await readWorkspaceHandoffExecution(this.configuration.identity)
    this.record = status.kind === 'identity_mismatch' ? { kind: 'invalid' } : status
    if (status.kind === 'valid') {
      const record = status.record
      this.order = Math.max(record.terminal?.order ?? 0, record.cancellation?.order ?? 0)
      this.claimed = record.consumed
      this.cancellation = record.cancellation
      try {
        // Latest proof is cumulative and may follow a warning/input append.
        const checkpoint = record.reconciliation?.checkpoint ?? record.notice?.checkpoint ?? record.terminal?.checkpoint
        if (checkpoint && !this.configuration.historical) await verify(checkpoint)
        this.frozen = record.terminal ? { outcome: record.terminal.outcome, order: record.terminal.order } : null
        this.observation = record.terminal ? 'terminal' : record.consumed ? 'unconfirmed' : 'idle'
      } catch { this.record = { kind: 'invalid' }; this.observation = 'unconfirmed' }
    } else if (status.kind !== 'absent') this.observation = 'unconfirmed'
    this.announce()
  }

  get persisted(): WorkspaceHandoffExecutionRecord | null {
    return this.record.kind === 'valid' ? this.record.record : null
  }
  get canSettle(): boolean { return !this.completion || this.finished }
  get canRetire(): boolean {
    const record = this.persisted
    return this.canSettle && this.publications === 0 && (this.configuration.historical === true ||
      !!record && (record.terminal?.outcome === 'success' || !!record.reconciliation))
  }
  get closed(): boolean { return this.frozen !== null }
  snapshot(gate: WorkspaceHandoffSnapshot['gate']): WorkspaceHandoffSnapshot {
    return { ...this.configuration.identity, observerGeneration: this.configuration.observerGeneration,
      statusSeq: ++this.sequence, execution: this.observation, record: this.record, gate }
  }
  gateChanged(): void { this.announce() }
  private announce(): void { this.sequence++; this.changed() }
  private initial(): WorkspaceHandoffExecutionRecord {
    return { ...this.configuration.identity, version: 1, origin: this.configuration.origin,
      revision: 0, consumed: false, inputCommitted: false, cancellation: null,
      terminal: null, notice: null, reconciliation: null }
  }
  private async publish(change: (record: WorkspaceHandoffExecutionRecord) => WorkspaceHandoffExecutionRecord): Promise<void> {
    this.publications++
    try { await this.publishRecord(change) } finally { this.publications-- }
  }
  private async publishRecord(change: (record: WorkspaceHandoffExecutionRecord) => WorkspaceHandoffExecutionRecord): Promise<void> {
    const { readWorkspaceHandoffExecution, updateWorkspaceHandoffExecution } = await import('../utils/workspaceHandoffExecutionState.js')
    try {
      const record = await updateWorkspaceHandoffExecution(this.configuration.identity, previous => {
        const value = change(previous ?? this.initial())
        return { ...value, revision: (previous?.revision ?? 0) + 1 }
      })
      this.record = { kind: 'valid', record }; this.announce()
    } catch (error) {
      const reread = await readWorkspaceHandoffExecution(this.configuration.identity)
      this.record = reread.kind === 'identity_mismatch' ? { kind: 'invalid' } : reread
      this.observation = 'unconfirmed'; this.announce()
      throw error
    }
  }

  async claim(run: () => Promise<void>, seal: () => Promise<ResumeCheckpointV1>): Promise<{ completion: Promise<void> }> {
    if (this.completion) { await this.acknowledgement; return { completion: this.completion } }
    if (this.claimed || this.frozen || this.fenced || this.record.kind !== 'absent' || this.configuration.recover ||
      this.configuration.historical || this.configuration.origin !== 'fresh' || !this.configuration.identity.admissionGeneration) {
      throw new Error('Workspace continuation cannot be replayed')
    }
    // Reserve before the first storage await. Cancellation observes this latch.
    this.claimed = true; this.observation = 'consuming'; this.announce()
    let claimReady!: () => void
    let claimFailed!: (error: unknown) => void
    const acknowledgement = new Promise<void>((resolve, reject) => { claimReady = resolve; claimFailed = reject })
    this.acknowledgement = acknowledgement
    this.completion = (async () => {
      try {
        await this.publish(record => ({ ...record, consumed: true, cancellation: this.cancellation ?? record.cancellation }))
        claimReady()
        if (!this.cancellation || this.cancellation.application !== 'prevented_start') {
          this.started = true; this.observation = 'running'; this.announce()
          try { await run() } catch (error) {
            if (!this.frozen || this.frozen.outcome === 'success') throw error
          }
        } else this.close('not_started')
        if (!this.frozen) this.close('failed')
        this.observation = 'finalizing'; this.announce()
        const watchdog = setTimeout(() => { this.observation = 'unconfirmed'; this.announce() }, 30_000)
        try {
          const checkpoint = await seal()
          const terminal = { ...this.frozen!, checkpoint }
          await this.publish(record => ({ ...record, terminal }))
          this.observation = 'terminal'; this.announce()
        } finally { clearTimeout(watchdog) }
      } catch (error) {
        claimFailed(error)
        this.observation = 'unconfirmed'; this.announce()
        throw error
      } finally { this.finished = true; this.announce() }
    })()
    // The caller receives the task after claim commit; failures remain observable
    // without an unhandled rejection before the acknowledgement is delivered.
    void this.completion.catch(() => {})
    await acknowledgement
    return { completion: this.completion }
  }
  close(outcome: WorkspaceHandoffExecutionOutcome): void {
    if (this.frozen) return
    this.frozen = { outcome, order: ++this.order }
    this.observation = 'finalizing'; this.announce()
  }
  async inputCommitted(_checkpoint: ResumeCheckpointV1): Promise<void> {
    if (this.cancellation?.application === 'prevented_start') throw new Error('Workspace continuation cancelled before input')
    await this.publish(record => ({ ...record, inputCommitted: true }))
  }
  async cancel(cancelId: string, abort: () => void): Promise<void> {
    if (this.cancellation) {
      if (this.cancellation.cancelId !== cancelId) throw new Error('Conflicting cancellation identity')
      if (!this.persisted?.cancellation) await this.publish(record => ({ ...record, cancellation: this.cancellation }))
      return
    }
    const identity = this.configuration.identity
    const currentSourceOwner = this.configuration.origin === 'fresh' && identity.admissionGeneration === null &&
      identity.sourceGeneration === this.configuration.observerGeneration
    if (this.configuration.recover && !currentSourceOwner && !this.frozen) {
      this.fenced = true; this.observation = 'unconfirmed'; this.announce()
      throw new Error('Historical cancellation application is unconfirmed')
    }
    const application = this.frozen ? 'too_late' : this.started ? 'abort_signalled' : 'prevented_start'
    this.cancellation = { cancelId, application, order: ++this.order }
    if (application === 'prevented_start') this.close('not_started')
    if (application === 'abort_signalled') abort()
    await this.publish(record => ({ ...record, cancellation: this.cancellation }))
  }
  fenceNoStart(): void {
    if (!this.canSettle) throw new Error('Workspace execution is still active')
    this.fenced = true
    const identity = this.configuration.identity
    const currentFreshOwner = this.configuration.origin === 'fresh' && (!this.configuration.recover ||
      (identity.admissionGeneration === null && identity.sourceGeneration === this.configuration.observerGeneration))
    if (!this.frozen && !this.claimed && currentFreshOwner) this.close('not_started')
    else if (!this.frozen) { this.observation = 'unconfirmed'; this.announce() }
  }
  async notice(notice: NonNullable<WorkspaceHandoffExecutionRecord['notice']>): Promise<void> {
    if (!this.canSettle) throw new Error('Workspace execution is still active')
    this.fenceNoStart()
    await this.publish(record => ({ ...record, notice,
      ...(!record.consumed && !record.terminal && this.frozen?.outcome === 'not_started'
        ? { terminal: { ...this.frozen, checkpoint: notice.checkpoint } } : {}) }))
  }
  async reconcile(reconciliation: NonNullable<WorkspaceHandoffExecutionRecord['reconciliation']>): Promise<void> {
    await this.publish(record => ({ ...record, reconciliation }))
  }
}
