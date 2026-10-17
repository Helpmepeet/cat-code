import type { OperationalRecordInput } from './operationalLog.js'

export const WORKSPACE_JUMP_STAGES = [
  'first_submit_to_catalog', 'first_submit_to_provider_response', 'catalog', 'accepted_to_source_boundary',
  'park_to_clean_exit', 'relocation_worker', 'replacement_to_controls',
  'replacement_to_runtime_init', 'resume', 'controller', 'query_config',
  'settings_options', 'diagnostics', 'display_history', 'subagent_history',
  'listening_to_ready_frame', 'ready_to_controls', 'admission_to_continuation',
  'continuation_to_provider_request', 'provider_request_to_response',
  'accepted_to_provider_request_observed',
] as const
export type WorkspaceJumpStage = typeof WORKSPACE_JUMP_STAGES[number]
export type WorkspaceJumpTimingIdentity = { appSessionId: string; engineSessionId?: string; operationId?: string; generation?: string }
export type WorkspaceJumpTimingSink = (input: OperationalRecordInput) => void

/** Durations belong to the caller's process. Sink failures never affect work. */
export function createWorkspaceJumpTiming(sink: WorkspaceJumpTimingSink = () => {}, now: () => number = () => performance.now()) {
  function write(identity: WorkspaceJumpTimingIdentity, phase: WorkspaceJumpStage, outcome: 'started' | 'completed' | 'failed' | 'unavailable', durationMs: number): void {
    const { appSessionId, engineSessionId, operationId, generation } = identity
    try {
      sink({ process: 'sidecar', level: 'info', event: 'workspace.jump.timing', appSessionId,
        ...(engineSessionId ? { engineSessionId } : {}), fields: { phase, outcome, durationMs: Math.max(0, durationMs),
          ...(operationId ? { operationId } : {}), ...(generation ? { generation } : {}) } })
    } catch { /* Observation must not change admission or recovery. */ }
  }
  function start(identity: WorkspaceJumpTimingIdentity, stage: WorkspaceJumpStage) {
    const started = now()
    write(identity, stage, 'started', 0)
    let finished = false
    return (outcome: 'completed' | 'failed' | 'unavailable' = 'completed') => {
      if (finished) return
      finished = true
      write(identity, stage, outcome, now() - started)
    }
  }
  async function span<T>(identity: WorkspaceJumpTimingIdentity, stage: WorkspaceJumpStage, work: () => T | Promise<T>): Promise<T> {
    const end = start(identity, stage)
    try { const result = await work(); end(); return result } catch (error) { end('failed'); throw error }
  }
  return { start, span, write }
}
