import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'child_process'
import { asAgentId } from '../types/ids.js'
import {
  killDelegatedChildrenForAgent,
  registerDelegatedChild,
} from './processTree.js'

// Real spawned processes throughout: the risk here is a process boundary
// (does a signal actually reach the child?), which a fake ChildProcess can't
// exercise. `spawnedPids` bounds cleanup to what each test itself started —
// never a process-table sweep, since other sessions and the operator share
// this machine.
const spawnedPids: number[] = []

function spawnSleeper(): { pid: number } {
  const child = spawn('/bin/sh', ['-c', 'sleep 20'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  if (child.pid === undefined) {
    throw new Error('failed to spawn test process')
  }
  spawnedPids.push(child.pid)
  return { pid: child.pid }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return !isAlive(pid)
}

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone, which several of these tests assert.
    }
  }
})

describe('delegated-child registry', () => {
  test('a child registered to an agent is killed when that agent is reaped', async () => {
    const agentId = asAgentId('a0000000000000001')
    const child = spawnSleeper()
    registerDelegatedChild(agentId, child)

    killDelegatedChildrenForAgent(agentId)

    expect(await waitUntilGone(child.pid)).toBe(true)
  })

  test('unregistering removes the child, so a later reap leaves it alone', async () => {
    const agentId = asAgentId('a0000000000000002')
    const child = spawnSleeper()
    const unregister = registerDelegatedChild(agentId, child)

    unregister()
    killDelegatedChildrenForAgent(agentId)

    expect(isAlive(child.pid)).toBe(true)
  })

  test('reaping one agent does not touch a child registered to another', async () => {
    const owner = asAgentId('a0000000000000003')
    const other = asAgentId('a0000000000000004')
    const child = spawnSleeper()
    registerDelegatedChild(owner, child)

    killDelegatedChildrenForAgent(other)

    expect(isAlive(child.pid)).toBe(true)
  })

  test('reaping an agent with nothing registered is a harmless no-op', () => {
    expect(() =>
      killDelegatedChildrenForAgent(asAgentId('a0000000000000005')),
    ).not.toThrow()
  })

  test('a main-thread registration (no agentId) is a no-op with a safe unregister', () => {
    const child = spawnSleeper()
    const unregister = registerDelegatedChild(undefined, child)

    expect(typeof unregister).toBe('function')
    expect(() => unregister()).not.toThrow()
    // Nothing to reap it by, since it was never filed under an agentId — the
    // process-exit reaper in ClaudeCliTool.tsx is what catches this case.
    expect(isAlive(child.pid)).toBe(true)
  })
})
