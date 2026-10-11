import type { LeaseSnapshot, LiveWorkerItem, TasksSnapshot } from '../../shared/protocol.js'
import type { NestedTranscriptRow, NestedToolUseRow } from './transcriptProjector.js'
import { deriveAgentToolState } from './agentIdentity.js'
import { selectWorkerDisplayName, workerState } from './workersState.js'
import { agentAccountLabel, agentActivityOf, agentIdOf, agentModelOf, agentProgressBadge, agentToolSourceOf, agentUsageOf } from './transcriptAgent.js'
import { leaseAccountShortLabel, leaseHeldLabel, selectLeaseForOwner } from './leaseState.js'
import { formatModelDisplayName } from './statsState.js'
import { MAX_PERSISTED_DOCK_FINISHED } from './subagentDockPersistence.js'
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
// A capped entry can still have a terminal card in the current transcript.
// Remember its run identity for this observation, without retaining another
// completion record or carrying this evidence across reloads. Each replacement
// contains only runs in its current input or retained entries; old state keys
// and their source evidence are weakly held.
const terminalRunsByState = new WeakMap<SubagentDockState, ReadonlyMap<string, string>>()
export function isSubagentDockTerminal(state: SubagentDockStatus): boolean {
  return state === 'completed' || state === 'failed' || state === 'stopped'
}

function boundFinishedEntries(state: SubagentDockState): SubagentDockState {
  const terminal = Object.values(state.entries).filter(entry => isSubagentDockTerminal(entry.state))
    .sort((a, b) => (b.terminalAt ?? 0) - (a.terminalAt ?? 0) || b.launchOrder - a.launchOrder)
  if (terminal.length <= MAX_PERSISTED_DOCK_FINISHED) return state
  const entries = { ...state.entries }
  for (const entry of terminal.slice(MAX_PERSISTED_DOCK_FINISHED)) delete entries[entry.agentId]
  return { ...state, entries }
}

/** Keep a stale pane observation from replacing a newer resumed run. */
export function mergeSubagentDockObservation(state: SubagentDockState, prior?: SubagentDockState): SubagentDockState {
  const entries = { ...state.entries }
  const terminalRuns = new Map(terminalRunsByState.get(state))
  if (prior) for (const [agentId, current] of Object.entries(prior.entries)) {
    const candidate = entries[agentId]
    if (current.resumedAt !== null && candidate &&
        (candidate.resumedAt ?? 0) < current.resumedAt &&
        (candidate.terminalAt ?? 0) < current.resumedAt) {
      entries[agentId] = current
      if (isSubagentDockTerminal(current.state)) terminalRuns.set(agentId, current.runKey)
      else terminalRuns.delete(agentId)
    }
  }
  const bounded = boundFinishedEntries({ ...state, entries, nextLaunchOrder: Math.max(state.nextLaunchOrder, prior?.nextLaunchOrder ?? 0) })
  terminalRunsByState.set(bounded, terminalRuns)
  return bounded
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

function latestAgentRows(input: Pick<SubagentDockInput, 'transcriptRows' | 'tasks' | 'workers'>, state: SubagentDockState): Map<string, NestedToolUseRow> {
  const { transcriptRows: rows, tasks, workers } = input
  const agentByToolUseId = new Map((tasks?.subagents ?? []).map(agent => [agent.toolUseId, agent.agentId]))
  const knownAgents = new Map(Object.values(state.entries).map(entry => [entry.agentId, entry.name]))
  const rememberedByToolUseId = new Map(Object.values(state.entries).filter(entry => entry.toolUseId !== null).map(entry => [entry.toolUseId!, entry.agentId]))
  for (const worker of workers) knownAgents.set(worker.agentId, selectWorkerDisplayName(worker))
  for (const agent of tasks?.subagents ?? []) knownAgents.set(agent.agentId, agent.agentName ?? null)
  for (const row of rows) {
    if (row.kind === 'tool-use' && row.toolFamily === 'agent' && row.toolName !== 'ResumeAgent' && row.result?.agentId) {
      knownAgents.set(row.result.agentId, row.result.agentName ?? knownAgents.get(row.result.agentId) ?? null)
    }
  }
  const idsByName = new Map<string, string[]>()
  for (const [id, name] of knownAgents) {
    if (name === null) continue
    const key = name.replace(/^@/, '')
    idsByName.set(key, [...idsByName.get(key) ?? [], id])
  }
  const byId = new Map<string, NestedToolUseRow>()
  // Only parent agent cards belong in the parent's dock; nested agents have their own owner.
  for (const row of rows) {
    if (row.kind !== 'tool-use' || row.toolFamily !== 'agent') continue
    if (row.toolName === 'ResumeAgent' && row.result) {
      // A rejected resume is a successful tool invocation with success:false.
      // It cannot replace the last actual run or its Clear marker.
      try {
        const result: unknown = JSON.parse(row.result.content)
        if (typeof result === 'object' && result !== null && 'success' in result && result.success === false) continue
      } catch { /* Older/non-JSON display results carry no rejection evidence. */ }
    }
    const target = agentIdOf(row)
    // Resume targets may be aliases. Engine metadata owns the canonical join;
    // remembered tool-use bindings and unique recorded names survive eviction.
    const named = target ? idsByName.get(target.replace(/^@/, '')) : undefined
    const fallback = row.toolName !== 'ResumeAgent' ? target : target && knownAgents.has(target) ? target
      : named?.length === 1 ? named[0]! : target && /^a(?:[\w-]+-)?[0-9a-f]{16}$/.test(target) ? target : null
    const agentId = agentByToolUseId.get(row.toolUseId) ?? rememberedByToolUseId.get(row.toolUseId) ?? fallback
    if (agentId !== null) {
      byId.delete(agentId)
      byId.set(agentId, row)
    }
  }
  return byId
}
function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Retains observed terminal evidence after workers.snapshot evicts it. */
export function reconcileSubagentDockState(previous: SubagentDockState, input: SubagentDockInput): SubagentDockState {
  const rows = latestAgentRows(input, previous)
  const workers = new Map(input.workers.map(worker => [worker.agentId, worker]))
  const tasks = new Map((input.tasks?.items ?? []).filter(task => task.type === 'local_agent').map(task => [task.id, task]))
  const entries: Record<string, SubagentDockEntry> = {}
  const previousTerminalRuns = terminalRunsByState.get(previous)
  const terminalRuns = new Map<string, string>()
  // On reload there is no runtime observation of capped runs. The retained
  // transcript identities still establish the observed source range. Launch
  // order does not imply completion order, so use its last retained position
  // and the newest saved completion; newer evidence remains eligible.
  const rowOrder = new Map([...rows.keys()].map((agentId, index) => [agentId, index]))
  let retainedRowCeiling = Number.NEGATIVE_INFINITY
  let retainedCompletionCeiling = 0
  const restoringCappedHistory = !previousTerminalRuns && previous.nextLaunchOrder >= MAX_PERSISTED_DOCK_FINISHED
  for (const entry of Object.values(previous.entries)) {
    if (!isSubagentDockTerminal(entry.state)) continue
    retainedCompletionCeiling = Math.max(retainedCompletionCeiling, entry.terminalAt ?? 0)
    if (restoringCappedHistory && entry.toolUseId !== null && rows.get(entry.agentId)?.toolUseId === entry.toolUseId) {
      retainedRowCeiling = Math.max(retainedRowCeiling, rowOrder.get(entry.agentId) ?? Number.NEGATIVE_INFINITY)
    }
  }
  let nextLaunchOrder = previous.nextLaunchOrder
  const ids = new Set([...Object.keys(previous.entries), ...workers.keys(), ...rows.keys()])
  for (const agentId of ids) {
    const old = previous.entries[agentId]
    const worker = workers.get(agentId)
    const row = rows.get(agentId)
    const task = tasks.get(agentId)
    const rowState = row ? deriveAgentToolState(agentToolSourceOf(row)) : null
    // Engine-selected background agents can launch without an explicit input flag.
    // Their successful tool result acknowledges dispatch, not completion.
    const backgroundLaunch = row?.status === 'success' && (row.toolName === 'Agent' || row.toolName === 'Task') && row.agentCompletion === null && (
      worker?.isBackgrounded === true || task?.isBackgrounded === true ||
      input.tasks?.subagents?.some(agent => agent.agentId === agentId && agent.isBackgrounded) ||
      old?.state === 'background' || old?.state === 'resumed')
    const transcriptTerminal = !backgroundLaunch && (rowState === 'completed' || rowState === 'failed' || rowState === 'stopped')
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
      : transcriptRunKey ?? (freshResume || !old && resumeTime !== null ? `resume:${resumeTime}` : old?.runKey ?? previousTerminalRuns?.get(agentId) ?? `start:${task?.startTime ?? input.nowMs}`)
    if (terminal) terminalRuns.set(agentId, runKey)
    // A capped completion is historical unless independent newer task evidence
    // arrives, even after the first cold observation. Running/new resume runs
    // and terminal transitions from retained active entries remain eligible.
    const newerTaskEvidence = (task?.endTime ?? 0) > retainedCompletionCeiling || (resumeTime ?? 0) > retainedCompletionCeiling
    if (terminal && !old && !newerTaskEvidence && previousTerminalRuns?.get(agentId) === runKey) continue
    if (terminal && !old && row && Number.isFinite(retainedRowCeiling) &&
        (rowOrder.get(agentId) ?? Number.POSITIVE_INFINITY) <= retainedRowCeiling &&
        !newerTaskEvidence) continue
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
  const bounded = boundFinishedEntries({ entries, nextLaunchOrder, initialized: true })
  terminalRunsByState.set(bounded, terminalRuns)
  return bounded
}

function join(parts: (string | null | undefined)[]): string | null {
  const present = parts.filter((part): part is string => !!part)
  return present.length ? present.join(' · ') : null
}
export function selectSubagentDock(state: SubagentDockState, input: SubagentDockInput): DerivedSubagentDock {
  const rows = latestAgentRows(input, state)
  const active: SubagentDockRow[] = []
  const finished: SubagentDockRow[] = []
  let nextUpdateAt: number | null = null
  for (const entry of Object.values(state.entries)) {
    const terminal = isSubagentDockTerminal(entry.state)
    if (terminal && input.clearMarkers?.some(marker => marker.agentId === entry.agentId && marker.runKey === entry.runKey)) continue
    const observedLease = terminal || entry.state === 'waiting' ? null : selectLeaseForOwner(input.leases, entry.agentId)
    const lease = observedLease?.state === 'active' ? observedLease : null
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
