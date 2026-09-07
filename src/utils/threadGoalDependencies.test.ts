import { afterEach, describe, expect, mock, test } from 'bun:test'

type Worker = { agentId: string; status: string; handle?: string }

// `mock.module` is global to the whole `bun test` process, so this stays a
// PASSTHROUGH unless a test in this file opts in. An unconditional stub here
// silently replaced readSessionState for every other suite in the same run.
let override: { workers: Worker[] | null } | null = null
let readShouldThrow = false

const realSessionState = await import('./workerState.js')
const realReadSessionState = realSessionState.readSessionState

mock.module('./workerState.js', () => ({
  ...realSessionState,
  readSessionState: async (...args: Parameters<typeof realReadSessionState>) => {
    if (readShouldThrow) throw new Error('session state unreadable')
    if (!override) return realReadSessionState(...args)
    return override.workers === null ? null : { knownWorkers: override.workers }
  },
}))

const { createThreadGoalDependencyCache } = await import(
  './threadGoalDependencies.js'
)

afterEach(() => {
  override = null
  readShouldThrow = false
})

describe('the goal dependency cache', () => {
  test('only running workers park the goal', async () => {
    override = { workers: [
      { agentId: 'a-1', status: 'running', handle: 'reviewer' },
      { agentId: 'a-2', status: 'completed' },
    ] }
    const cache = createThreadGoalDependencyCache()
    await cache.refresh()

    expect(cache.read()).toEqual([
      { kind: 'worker', subjectId: 'a-1', label: 'reviewer' },
    ])
  })

  test('a completed worker does not deadlock the goal against itself', async () => {
    // A completed worker's result is delivered to the parent session on its
    // next turn. Parking on completed work made the goal wait for something
    // only the turn it refused to take could clear.
    override = { workers: [{ agentId: 'a-1', status: 'completed' }] }
    const cache = createThreadGoalDependencyCache()
    await cache.refresh()

    expect(cache.read()).toEqual([])
  })

  test('a worker with no distinct handle falls back to its id', async () => {
    override = { workers: [{ agentId: 'a-1', status: 'running', handle: 'a-1' }] }
    const cache = createThreadGoalDependencyCache()
    await cache.refresh()

    expect(cache.read()[0]!.label).toBe('a-1')
  })

  test('expansion counts every worker, not just the running ones', async () => {
    // A goal that spawns and resolves one worker per turn is still fanning out
    // without bound, so the child budget counts arrivals rather than survivors.
    override = { workers: [
      { agentId: 'a-1', status: 'completed' },
      { agentId: 'a-2', status: 'running' },
    ] }
    const cache = createThreadGoalDependencyCache()
    await cache.refresh()

    expect(cache.readChildAgentIds()).toEqual(['a-1', 'a-2'])
    expect(cache.read()).toHaveLength(1)
  })

  test('an unreadable session parks on nothing but keeps the children seen', async () => {
    override = { workers: [{ agentId: 'a-1', status: 'running' }] }
    const cache = createThreadGoalDependencyCache()
    await cache.refresh()
    expect(cache.readChildAgentIds()).toEqual(['a-1'])

    readShouldThrow = true
    await cache.refresh()

    // Imagined work must not park the goal...
    expect(cache.read()).toEqual([])
    // ...and a transient read failure must not hand back the expansion budget.
    expect(cache.readChildAgentIds()).toEqual(['a-1'])
  })

  test('a session with no state reads as no dependencies', async () => {
    override = { workers: null }
    const cache = createThreadGoalDependencyCache()
    await cache.refresh()

    expect(cache.read()).toEqual([])
    expect(cache.readChildAgentIds()).toEqual([])
  })

  test('reads before the first refresh are empty, never undefined', async () => {
    const cache = createThreadGoalDependencyCache()
    expect(cache.read()).toEqual([])
    expect(cache.readChildAgentIds()).toEqual([])
  })
})
