import { expect, test } from 'bun:test'
import { deriveUnfinishedTaskFacts } from './unfinishedWork.js'

const task = (type: string, status = 'running', extra: Record<string, unknown> = {}) =>
  ({ type, status, ...extra })

test('counts raw foreground and background subagents, including children after parent end', () => {
  const facts = deriveUnfinishedTaskFacts({
    parent: task('local_agent', 'completed'),
    child: task('local_agent', 'running', { isBackgrounded: false }),
    grandchild: task('local_agent', 'pending'),
  })
  expect(facts).toMatchObject({ available: true, activeSubagents: 2, activeBackgroundTasks: 0 })
})

test('synthetic main turn and unfinished shell lifetime are classified separately', () => {
  const facts = deriveUnfinishedTaskFacts({
    synthetic: task('local_agent', 'running', { agentType: 'main-session' }),
    shell: task('local_bash'),
    service: task('local_bash', 'running', { workLifetime: 'service' }),
    monitor: task('local_bash', 'running', { kind: 'monitor' }),
  })
  expect(facts).toMatchObject({ backgroundMainTurn: true, activeBackgroundTasks: 1, activeSubagents: 0 })
})

test('approval waits are distinguished from retained terminal handoffs', () => {
  const facts = deriveUnfinishedTaskFacts({
    blocked: task('local_agent', 'running', { agentId: 'agent-1', handoffStatus: 'blocked' }),
    retained: task('local_agent', 'completed', { handoffStatus: 'blocked' }),
  }, new Set(['agent-1']))
  expect(facts).toMatchObject({ activeSubagents: 1, waitingForApproval: true })
})

test('bare idle teammates and explicit services do not hold completion open', () => {
  expect(deriveUnfinishedTaskFacts({
    idle: task('in_process_teammate', 'running', { isIdle: true, pendingUserMessages: [] }),
    service: task('remote_agent', 'running', { isLongRunning: true }),
    monitor: task('monitor_mcp', 'running'),
  })).toMatchObject({ available: true, activeSubagents: 0, activeBackgroundTasks: 0 })
})

test('shutdown request does not make a still-live teammate terminal', () => {
  expect(deriveUnfinishedTaskFacts({
    teammate: task('in_process_teammate', 'running', {
      isIdle: true, shutdownRequested: true, pendingUserMessages: [],
    }),
  })).toMatchObject({ available: true, activeSubagents: 1 })
})

test('unknown live runtime variants count conservatively; malformed status is unavailable', () => {
  expect(deriveUnfinishedTaskFacts({ future: task('future_task') }).activeBackgroundTasks).toBe(1)
  expect(deriveUnfinishedTaskFacts({ malformed: { type: 'future_task' } }).available).toBe(false)
})
