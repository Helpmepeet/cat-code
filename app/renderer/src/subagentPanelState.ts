import { deriveAgentToolState } from './agentIdentity.js'
import { isSubagentDockTerminal, type SubagentDockRow, type SubagentDockStatus } from './subagentDockState.js'
import { agentIdOf, agentToolSourceOf } from './transcriptAgent.js'
import type { NestedToolUseRow, NestedTranscriptRow } from './transcriptProjector.js'

const EMPTY_STEPS: NestedTranscriptRow[] = []
// Joined steps keep one identity per transcript snapshot, so the panel's
// follow effect and row rendering only react to real changes.
const joinedStepsByRows = new WeakMap<readonly NestedTranscriptRow[], Map<string, NestedTranscriptRow[]>>()

function findBranch(rows: readonly NestedTranscriptRow[], toolUseId: string) {
  return rows.find(row =>
    row.kind === 'tool-use' && row.toolFamily === 'agent' && row.toolUseId === toolUseId ||
    row.kind === 'orphaned-agent' && row.missingToolUseId === toolUseId)
}

/**
 * A resume runs under its own tool use, so the agent's earlier runs are joined
 * above the current one. Runs recorded after the current one are excluded.
 */
export function selectSubagentPanelBranch(rows: readonly NestedTranscriptRow[], toolUseId: string | null, runToolUseIds: readonly string[] = []) {
  const branch = toolUseId === null ? undefined : findBranch(rows, toolUseId)
  const current = runToolUseIds.indexOf(toolUseId ?? '')
  const earlier = toolUseId === null ? [] : (current === -1 ? runToolUseIds : runToolUseIds.slice(0, current))
    .filter(id => id !== toolUseId).map(id => findBranch(rows, id))
  let steps = branch?.children ?? EMPTY_STEPS
  if (earlier.some(run => run?.children.length)) {
    const cache = joinedStepsByRows.get(rows) ?? new Map<string, NestedTranscriptRow[]>()
    joinedStepsByRows.set(rows, cache)
    const key = [...runToolUseIds, toolUseId].join('\n')
    const joined = cache.get(key) ?? [...earlier.flatMap(run => run?.children ?? []), ...steps]
    cache.set(key, joined)
    steps = joined
  }
  return {
    agent: branch?.kind === 'tool-use' ? branch : null,
    steps,
    incomplete: [branch, ...earlier].some(run => run === undefined || run.kind === 'orphaned-agent' ||
      run.kind === 'tool-use' && run.stepsNotLoaded === true),
  }
}

/**
 * Every Agent and ResumeAgent run publishes its steps under its own tool use,
 * foreground or background (`runAgent` `publishDisplaySteps`), so a live run
 * opens before its first step arrives.
 */
export function canOpenSubagentPanel(row: SubagentDockRow, rows: readonly NestedTranscriptRow[]): boolean {
  if (row.toolUseId === null) return false
  // A synthetic resume key has no run-owned transcript correlation. Its reveal
  // target can still point at the previous run.
  if (row.runKey.startsWith('resume:') && row.runKey !== row.toolUseId) return false
  const branch = selectSubagentPanelBranch(rows, row.toolUseId, row.runToolUseIds)
  // A finished run recorded before steps were published has only its launch
  // acknowledgement, and keeps the reveal fallback.
  return !isSubagentDockTerminal(row.state) || branch.steps.length > 0 || branch.incomplete
}

/**
 * The dock row an Agent card opens: the dock's own row for any of the agent's
 * runs, or one read from the card when the dock no longer holds the agent.
 */
export function selectSubagentPanelRowForCard(card: NestedToolUseRow, dockRows: readonly SubagentDockRow[]): SubagentDockRow {
  const known = dockRows.find(row => row.toolUseId === card.toolUseId || row.runToolUseIds.includes(card.toolUseId))
  if (known) return known
  const derived = deriveAgentToolState(agentToolSourceOf(card))
  const state: SubagentDockStatus = derived === 'completed' || derived === 'result-ready' || derived === 'reviewed' ? 'completed'
    : derived === 'failed' ? 'failed'
    : derived === 'stopped' || derived === 'paused' ? 'stopped'
    : derived === 'waiting' || derived === 'needs-you' || derived === 'attention' ? 'waiting'
    : derived === 'background' ? 'background' : 'running'
  const description = card.input.description
  const type = card.input.subagent_type
  return {
    agentId: agentIdOf(card) ?? card.toolUseId, runKey: card.toolUseId, toolUseId: card.toolUseId,
    name: card.result?.agentName ?? null,
    task: typeof description === 'string' && description.trim() ? description.trim() : 'Agent',
    type: typeof type === 'string' && type.trim() ? type.trim() : null,
    state, model: null, recordedAccount: null, usageLabel: null, verdict: null, resultSummary: null, blockReason: null,
    launchOrder: 0, terminalAt: null, resumedAt: null, lastSeenAt: 0, missingSince: null, settleUntil: null,
    stateWord: state === 'completed' ? 'done' : state, account: null, rowModel: null,
    stripLines: [null, null], chipLines: [null, null], settling: false, runToolUseIds: [card.toolUseId],
  }
}
