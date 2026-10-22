import { isMainSessionTask } from '../../src/tasks/LocalMainSessionTask.js'

export type UnfinishedTaskFacts = {
  available: boolean
  backgroundMainTurn: boolean
  activeSubagents: number
  activeBackgroundTasks: number
  waitingForApproval: boolean
}

type RuntimeTask = {
  type?: unknown
  status?: unknown
  kind?: unknown
  workLifetime?: unknown
  agentId?: unknown
  identity?: { agentId?: unknown }
  isLongRunning?: unknown
  isIdle?: unknown
  pendingUserMessages?: unknown
  awaitingPlanApproval?: unknown
  shutdownRequested?: unknown
}

/**
 * Classifies raw engine task records, not the display-filtered task snapshot.
 * Unrecognized live variants count conservatively as background work.
 */
export function deriveUnfinishedTaskFacts(
  tasks: Record<string, unknown> | undefined,
  permissionActorIds: ReadonlySet<string> = new Set(),
): UnfinishedTaskFacts {
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
    return {
      available: false, backgroundMainTurn: false, activeSubagents: 0,
      activeBackgroundTasks: 0, waitingForApproval: false,
    }
  }
  let backgroundMainTurn = false
  let activeSubagents = 0
  let activeBackgroundTasks = 0
  let waitingForApproval = false
  for (const value of Object.values(tasks)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        available: false, backgroundMainTurn, activeSubagents,
        activeBackgroundTasks, waitingForApproval,
      }
    }
    const task = value as RuntimeTask
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'killed') continue
    if (task.status !== 'pending' && task.status !== 'running') {
      return {
        available: false, backgroundMainTurn, activeSubagents,
        activeBackgroundTasks, waitingForApproval,
      }
    }
    if (isMainSessionTask(task)) {
      backgroundMainTurn = true
      continue
    }
    switch (task.type) {
      case 'local_agent':
        activeSubagents++
        if (typeof task.agentId === 'string' && permissionActorIds.has(task.agentId)) waitingForApproval = true
        break
      case 'in_process_teammate': {
        const hasPending = Array.isArray(task.pendingUserMessages) && task.pendingUserMessages.length > 0
        const hasAssignedWork = task.isIdle !== true
        const shutdownPending = task.shutdownRequested === true
        const planApproval = task.awaitingPlanApproval === true
        if (hasPending || hasAssignedWork || shutdownPending || planApproval) activeSubagents++
        const actorId = typeof task.identity?.agentId === 'string'
          ? task.identity.agentId
          : task.agentId
        if (planApproval || (typeof actorId === 'string' && permissionActorIds.has(actorId))) {
          waitingForApproval = true
        }
        break
      }
      case 'remote_agent':
        if (task.isLongRunning !== true) activeSubagents++
        break
      case 'local_bash':
        if (task.kind !== 'monitor' && task.workLifetime !== 'service') activeBackgroundTasks++
        break
      case 'dream':
      case 'local_workflow':
        activeBackgroundTasks++
        break
      case 'monitor_mcp':
        break
      default:
        activeBackgroundTasks++
        break
    }
  }
  return { available: true, backgroundMainTurn, activeSubagents, activeBackgroundTasks, waitingForApproval }
}
