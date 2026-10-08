import type { LeaseSnapshot, LiveWorkerItem, TasksSnapshot } from '../../shared/protocol.js'
import type { NestedTranscriptRow, NestedToolUseRow } from './transcriptProjector.js'
import { deriveAgentToolState } from './agentIdentity.js'
import { selectWorkerDisplayName, workerState } from './workersState.js'
import { agentAccountLabel, agentActivityOf, agentIdOf, agentModelOf, agentProgressBadge, agentToolSourceOf, agentUsageOf } from './transcriptAgent.js'
import { leaseAccountShortLabel, leaseHeldLabel, selectLeaseForOwner } from './leaseState.js'
import { formatModelDisplayName } from './statsState.js'
export type SubagentDockClearMarker = { agentId: string; runKey: string }

export type SubagentDockStatus = 'waiting' | 'running' | 'background' | 'resumed' | 'completed' | 'failed' | 'stopped'
export type SubagentDockEntry = {
  agentId: string
  runKey: string
  toolUseId: string | null
  name: string | null
  task: string
  type: string | null
  state: SubagentDockStatus
  model: string | null
  recordedAccount: string | null
  usageLabel: string | null
  verdict: string | null
  resultSummary: string | null
  blockReason: string | null
  launchOrder: number
  terminalAt: number | null
  resumedAt: number | null
  lastSeenAt: number
  missingSince: number | null
  settleUntil: number | null
}
export type SubagentDockState = {
  entries: Record<string, SubagentDockEntry>
  nextLaunchOrder: number
  initialized: boolean
}
export type SubagentDockInput = {
  workers: readonly LiveWorkerItem[]
  tasks: TasksSnapshot | null
  transcriptRows: readonly NestedTranscriptRow[]
  leases: LeaseSnapshot | null
  clearMarkers?: readonly SubagentDockClearMarker[]
  nowMs: number
  parentModel?: string | null
  reducedMotion?: boolean
}
export type SubagentDockRow = SubagentDockEntry & {
  stateWord: string
  account: string | null
  rowModel: string | null
  stripLines: [string | null, string | null]
  chipLines: [string | null, string | null]
  settling: boolean
}
export type DerivedSubagentDock = {
  active: SubagentDockRow[]
  finished: SubagentDockRow[]
  chipFaces: SubagentDockRow[]
  nextUpdateAt: number | null
}

const DISAPPEARANCE_GRACE_MS = 2000
export function isSubagentDockTerminal(state: SubagentDockStatus): boolean {
  return state === 'completed' || state === 'failed' || state === 'stopped'
}

/** Restored terminal history is already settled, so reload never replays motion. */
export function createSubagentDockState(restoredEntries: readonly SubagentDockEntry[] = []): SubagentDockState {
  const entries: Record<string, SubagentDockEntry> = {}
  for (const entry of restoredEntries) {
    if (!isSubagentDockTerminal(entry.state)) continue
    entries[entry.agentId] = { ...entry, settleUntil: null, missingSince: null }
  }
  return { entries, initialized: false, nextLaunchOrder: Math.max(0, ...restoredEntries.map(entry => entry.launchOrder + 1)) }
}

function latestAgentRows(rows: readonly NestedTranscriptRow[], tasks: TasksSnapshot | null): Map<string, NestedToolUseRow> {
  const agentByToolUseId = new Map((tasks?.subagents ?? []).map(agent => [agent.toolUseId, agent.agentId]))
  const byId = new Map<string, NestedToolUseRow>()
  // Only parent agent cards belong in the parent's dock; nested agents have their own owner.
  for (const row of rows) {
    if (row.kind !== 'tool-use' || row.toolFamily !== 'agent') continue
    const agentId = agentIdOf(row) ?? agentByToolUseId.get(row.toolUseId) ?? null
    if (agentId !== null) byId.set(agentId, row)
  }
  return byId
}
function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Retains observed terminal evidence after workers.snapshot evicts it. */
export function reconcileSubagentDockState(previous: SubagentDockState, input: SubagentDockInput): SubagentDockState {
  const rows = latestAgentRows(input.transcriptRows, input.tasks)
  const workers = new Map(input.workers.map(worker => [worker.agentId, worker]))
  const tasks = new Map((input.tasks?.items ?? []).filter(task => task.type === 'local_agent').map(task => [task.id, task]))
  const entries: Record<string, SubagentDockEntry> = {}
  let nextLaunchOrder = previous.nextLaunchOrder
  const ids = new Set([...Object.keys(previous.entries), ...workers.keys(), ...rows.keys()])
  for (const agentId of ids) {
    const old = previous.entries[agentId]
    const worker = workers.get(agentId)
    const row = rows.get(agentId)
    const task = tasks.get(agentId)
    const rowState = row ? deriveAgentToolState(agentToolSourceOf(row)) : null
    const transcriptTerminal = rowState === 'completed' || rowState === 'failed' || rowState === 'stopped'
    const resumeTime = task?.resumedAt ?? null
    const freshResume = worker?.status === 'running' && resumeTime !== null &&
      (old?.terminalAt === null || old?.terminalAt === undefined || resumeTime > old.terminalAt)
    const rowBelongsToResume = row?.toolName === 'ResumeAgent'
    const currentRunResumed = resumeTime !== null || old?.resumedAt !== null && old?.resumedAt !== undefined
    const olderTranscript = currentRunResumed && (!rowBelongsToResume ||
      !!old && row?.toolUseId === old.toolUseId &&
        (freshResume && isSubagentDockTerminal(old.state) || old.runKey.startsWith('resume:')))
    const evidenceRow = olderTranscript ? undefined : row
    let state: SubagentDockStatus | undefined
    if (worker?.handoffStatus === 'blocked') state = 'waiting'
    else if (transcriptTerminal && !olderTranscript) state = rowState
    else if (worker?.status === 'running' && freshResume) state = 'resumed'
    else if (worker) state = workerState(worker) as SubagentDockStatus
    else if (old && isSubagentDockTerminal(old.state)) state = old.state
    else if (old && (!transcriptTerminal || olderTranscript)) {
      const missingSince = old.missingSince ?? input.nowMs
      if (input.nowMs - missingSince < DISAPPEARANCE_GRACE_MS) {
        entries[agentId] = { ...old, missingSince }
      }
      continue
    } else continue
    const terminal = isSubagentDockTerminal(state)
    const resumedAt = freshResume ? resumeTime : old?.resumedAt ?? null
    const runChanged = !!old && (freshResume && resumeTime !== old.resumedAt ||
      evidenceRow?.toolName === 'ResumeAgent' && evidenceRow.toolUseId !== old.toolUseId &&
        !(isSubagentDockTerminal(old.state) && old.runKey.startsWith('resume:')))
    const transcriptRunKey = evidenceRow?.toolUseId
    // Once terminal evidence was observed its identity must stay stable across enrichment and Clear.
    const runKey = old && !runChanged && isSubagentDockTerminal(old.state)
      ? old.runKey
      : transcriptRunKey ?? (freshResume ? `resume:${resumeTime}` : old?.runKey ?? `start:${task?.startTime ?? input.nowMs}`)
    const newlyTerminal = terminal && (!old || !isSubagentDockTerminal(old.state) || runChanged)
    const terminalAt = terminal ? newlyTerminal ? task?.endTime ?? input.nowMs : old?.terminalAt ?? task?.endTime ?? input.nowMs : null
    const settledUsage = evidenceRow && terminal ? evidenceRow.toolName === 'ResumeAgent'
      ? usageLabel(agentUsageOf(evidenceRow), state)
      : agentProgressBadge(evidenceRow, state) : null
    const entry: SubagentDockEntry = {
      agentId, runKey,
      toolUseId: evidenceRow?.toolUseId ?? old?.toolUseId ?? null,
      name: worker ? selectWorkerDisplayName(worker) : stringField(evidenceRow?.result?.agentName) ?? old?.name ?? null,
      task: stringField(worker?.description) ?? stringField(evidenceRow?.input.description) ?? stringField(evidenceRow?.input.prompt) ?? old?.task ?? 'Agent',
      type: stringField(worker?.role) ?? stringField(evidenceRow?.input.subagent_type) ?? old?.type ?? null,
      state,
      model: row ? agentModelOf(row) ?? old?.model ?? null : old?.model ?? null,
      recordedAccount: evidenceRow ? agentAccountLabel(evidenceRow, null) ?? (runChanged ? null : old?.recordedAccount ?? null) : runChanged ? null : old?.recordedAccount ?? null,
      usageLabel: settledUsage ?? (runChanged ? null : old?.usageLabel ?? null),
      verdict: worker?.verdict ?? (runChanged ? null : old?.verdict ?? null),
      resultSummary: worker?.resultSummary ?? evidenceRow?.agentCompletion?.result ?? (runChanged ? null : old?.resultSummary ?? null),
      blockReason: worker?.blockReason ?? (runChanged ? null : old?.blockReason ?? null),
      launchOrder: old && !(freshResume && resumeTime !== old.resumedAt) ? old.launchOrder : nextLaunchOrder++, terminalAt, resumedAt,
      lastSeenAt: worker ? input.nowMs : old?.lastSeenAt ?? input.nowMs,
      missingSince: null,
      settleUntil: terminal ? newlyTerminal && previous.initialized && !input.reducedMotion
        ? input.nowMs + (state === 'failed' ? 1500 : 700)
        : newlyTerminal ? null : old?.settleUntil ?? null : null,
    }
    entries[agentId] = entry
  }
  return { entries, nextLaunchOrder, initialized: true }
}

function join(parts: (string | null | undefined)[]): string | null {
  const present = parts.filter((part): part is string => !!part)
  return present.length ? present.join(' · ') : null
}
export function selectSubagentDock(state: SubagentDockState, input: SubagentDockInput): DerivedSubagentDock {
  const rows = latestAgentRows(input.transcriptRows, input.tasks)
  const active: SubagentDockRow[] = []
  const finished: SubagentDockRow[] = []
  let nextUpdateAt: number | null = null
  for (const entry of Object.values(state.entries)) {
    const terminal = isSubagentDockTerminal(entry.state)
    if (terminal && input.clearMarkers?.some(marker => marker.agentId === entry.agentId && marker.runKey === entry.runKey)) continue
    const lease = terminal || entry.state === 'waiting' ? null : selectLeaseForOwner(input.leases, entry.agentId)
    const account = lease ? leaseAccountShortLabel(lease) : entry.recordedAccount
    const model = entry.model ? formatModelDisplayName(entry.model) : null
    const rowModel = !terminal && entry.state !== 'waiting' && entry.model && entry.model !== input.parentModel ? model : null
    const liveRow = rows.get(entry.agentId)
    let lineA: string | null
    let lineB: string | null
    if (entry.state === 'completed') {
      lineA = join([model, entry.usageLabel])
      lineB = join([entry.verdict, entry.resultSummary])
    } else if (entry.state === 'failed' || entry.state === 'stopped') {
      lineA = join([model, entry.recordedAccount])
      lineB = null
    } else if (entry.state === 'waiting') {
      lineA = join([model, entry.recordedAccount])
      lineB = entry.blockReason
    } else if (entry.state === 'background' || entry.state === 'resumed') {
      const failover = lease && lease.failoverCount > 0 ? `moved ${lease.failoverCount === 1 ? 'once' : `${lease.failoverCount} times`}` : null
      lineA = join([model, account, failover])
      lineB = lease?.state === 'active' ? `held ${leaseHeldLabel(lease.createdAt, input.nowMs)}` : null
    } else {
      lineA = join([model, account])
      lineB = liveRow ? agentActivityOf(liveRow) : null
    }
    const settling = terminal && !input.reducedMotion && entry.settleUntil !== null && entry.settleUntil > input.nowMs
    const stateWord = entry.state === 'completed' ? 'done' : entry.state
    const dockRow: SubagentDockRow = {
      ...entry, model, account, rowModel, stateWord, settling,
      chipLines: [lineA, lineB],
      stripLines: [rowModel && model ? join(lineA?.split(' · ').filter(part => part !== model) ?? []) : lineA, lineB],
    }
    if (!terminal || settling) active.push(dockRow)
    else finished.push(dockRow)
    const deadline = settling ? entry.settleUntil : entry.missingSince !== null ? entry.missingSince + DISAPPEARANCE_GRACE_MS : null
    if (deadline !== null && deadline > input.nowMs) nextUpdateAt = Math.min(nextUpdateAt ?? deadline, deadline)
  }
  active.sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting') || a.launchOrder - b.launchOrder)
  finished.sort((a, b) => (b.terminalAt ?? 0) - (a.terminalAt ?? 0) || b.launchOrder - a.launchOrder)
  return { active, finished, chipFaces: active.length ? active : finished, nextUpdateAt }
}

function usageLabel(usage: ReturnType<typeof agentUsageOf>, state: SubagentDockStatus): string | null {
  if (usage === null) return null
  const tokens = usage.totalTokens >= 1000 ? `${(usage.totalTokens / 1000).toFixed(1)}k` : String(usage.totalTokens)
  return join([
    usage.toolUses > 0 ? `${usage.toolUses} tool ${usage.toolUses === 1 ? 'call' : 'calls'}` : null,
    state === 'completed' && usage.totalTokens > 0 ? `${tokens} tokens` : null,
  ])
}
