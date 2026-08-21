import { DIAMOND_FILLED, DIAMOND_OPEN } from '../constants/figures.js'
import { isBlockedLocalAgent, isUltraplanAttentionPhase } from './attention.js'
import { count } from '../utils/array.js'
import figures from 'figures'
import type {
  LocalAgentTaskState,
  VerificationVerdict,
} from './LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from './types.js'

/**
 * Produces the compact footer-pill label for a set of background tasks.
 * Used by both the footer pill and the turn-duration transcript line so the
 * two surfaces agree on terminology.
 */
export function getPillLabel(tasks: TaskState[]): string {
  const n = tasks.length
  const allSameType = tasks.every(t => t.type === tasks[0]!.type)

  if (allSameType) {
    switch (tasks[0]!.type) {
      case 'local_bash': {
        const monitors = count(
          tasks,
          t => t.type === 'local_bash' && t.kind === 'monitor',
        )
        const shells = n - monitors
        const parts: string[] = []
        if (shells > 0)
          parts.push(shells === 1 ? '1 shell' : `${shells} shells`)
        if (monitors > 0)
          parts.push(monitors === 1 ? '1 monitor' : `${monitors} monitors`)
        return parts.join(', ')
      }
      case 'in_process_teammate': {
        const teamCount = new Set(
          tasks.map(t =>
            t.type === 'in_process_teammate' ? t.identity.teamName : '',
          ),
        ).size
        return teamCount === 1 ? '1 team' : `${teamCount} teams`
      }
      case 'local_agent':
        return getLocalAgentPillLabel(
          tasks.filter((t): t is LocalAgentTaskState => t.type === 'local_agent'),
        )
      case 'remote_agent': {
        const first = tasks[0]!
        // Per design mockup: ◇ open diamond while running/needs-input,
        // ◆ filled once ExitPlanMode is awaiting approval.
        if (n === 1 && first.type === 'remote_agent' && first.isUltraplan) {
          switch (first.ultraplanPhase) {
            case 'plan_ready':
              return `${DIAMOND_FILLED} ultraplan ready`
            case 'needs_input':
              return `${DIAMOND_OPEN} ultraplan needs your input`
            default:
              return `${DIAMOND_OPEN} ultraplan`
          }
        }
        return n === 1
          ? `${DIAMOND_OPEN} 1 cloud session`
          : `${DIAMOND_OPEN} ${n} cloud sessions`
      }
      case 'local_workflow':
        return n === 1 ? '1 background workflow' : `${n} background workflows`
      case 'monitor_mcp':
        return n === 1 ? '1 monitor' : `${n} monitors`
      case 'dream':
        return 'dreaming'
    }
  }

  const localAgents = tasks.filter(
    (t): t is LocalAgentTaskState => t.type === 'local_agent',
  )
  if (localAgents.length > 0) {
    const blockedCount = localAgents.filter(isBlockedLocalAgent).length
    const failedCount = localAgents.filter(t => t.status === 'failed').length
    if (blockedCount > 0) {
      const runningCount = localAgents.filter(t => t.status === 'running').length
      return [
        `${figures.questionMarkPrefix} ${blockedCount} needs input`,
        runningCount > 0 ? `${runningCount} running` : undefined,
      ]
        .filter(Boolean)
        .join(' · ')
    }
    if (failedCount > 0) return `${figures.cross} ${failedCount} failed`
  }

  return `${n} background ${n === 1 ? 'task' : 'tasks'}`
}

/**
 * True when the pill should show the dimmed " · ↓ to view" call-to-action.
 * Per the state diagram: only the two attention states (needs_input,
 * plan_ready) surface the CTA; plain running shows just the diamond + label.
 */
export function pillNeedsCta(tasks: TaskState[]): boolean {
  if (tasks.some(t => t.type === 'local_agent' && isBlockedLocalAgent(t))) {
    return true
  }
  if (tasks.length !== 1) return false
  const t = tasks[0]!
  return (
    t.type === 'remote_agent' &&
    t.isUltraplan === true &&
    isUltraplanAttentionPhase(t.ultraplanPhase)
  )
}

export function pillCtaText(tasks: TaskState[]): string | undefined {
  if (tasks.some(t => t.type === 'local_agent' && isBlockedLocalAgent(t))) {
    return '↵ to open'
  }
  if (pillNeedsCta(tasks)) return `${figures.arrowDown} to view`
  return undefined
}

export function localAgentStatusIcon(task: LocalAgentTaskState): string {
  if (isBlockedLocalAgent(task)) return figures.questionMarkPrefix
  if (task.agentType === 'verification' && task.verdict) {
    return verdictIcon(task.verdict)
  }
  if (task.status === 'running') {
    return task.progress?.recentActivities?.length ? figures.play : figures.ellipsis
  }
  if (task.status === 'completed') return figures.tick
  if (task.status === 'failed' || task.status === 'killed') return figures.cross
  return figures.bullet
}

function verdictIcon(verdict: VerificationVerdict): string {
  switch (verdict) {
    case 'PASS':
      return figures.tick
    case 'FAIL':
      return figures.cross
    case 'PARTIAL':
      return figures.questionMarkPrefix
  }
}

function getLocalAgentPillLabel(tasks: LocalAgentTaskState[]): string {
  if (tasks.length === 1) return getSingleLocalAgentPillLabel(tasks[0]!)

  if (tasks.length <= 2 && tasks.every(t => t.status !== 'running')) {
    return tasks.map(getSingleLocalAgentPillLabel).join(' · ')
  }

  const blockedCount = tasks.filter(isBlockedLocalAgent).length
  if (blockedCount > 0) {
    const runningCount = tasks.filter(t => t.status === 'running').length
    return [
      `${figures.questionMarkPrefix} ${blockedCount} needs input`,
      runningCount > 0 ? `${runningCount} running` : undefined,
    ]
      .filter(Boolean)
      .join(' · ')
  }

  return `${tasks.length} subagents`
}

function getSingleLocalAgentPillLabel(task: LocalAgentTaskState): string {
  const icon = localAgentStatusIcon(task)
  const identity = task.agentName
    ? `@${task.agentName} · ${task.agentType}`
    : task.agentType
  const blockedSuffix = isBlockedLocalAgent(task) ? ' — needs input' : ''
  const verdictSuffix =
    task.agentType === 'verification' && task.verdict ? ` — ${task.verdict}` : ''
  return `${icon} ${identity}${blockedSuffix}${verdictSuffix}`
}
