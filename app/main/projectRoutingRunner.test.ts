import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'

import { runProjectRoutingWorker } from './projectRoutingRunner.js'

const request = {
  type: 'project-route' as const,
  version: 1 as const,
  text: 'Work in cat-code',
  previousUserMessages: [],
  knownProjectRoots: ['/Users/pt/cat-code'],
  suppressedRoots: [],
  model: null,
}

function fakeSpawn(script: { stdout?: string; exitCode?: number }): typeof spawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill: (signal?: NodeJS.Signals) => boolean
      stdout: EventEmitter
      stderr: EventEmitter
      stdin: EventEmitter & { end: (input?: string) => void }
    }
    child.exitCode = null
    child.signalCode = null
    child.kill = signal => {
      child.signalCode = signal ?? 'SIGTERM'
      return true
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter() as EventEmitter & { end: (input?: string) => void }
    child.stdin.end = () => {}
    setTimeout(() => {
      if (script.stdout !== undefined) child.stdout.emit('data', Buffer.from(script.stdout))
      child.exitCode = script.exitCode ?? 0
      child.emit('close', child.exitCode, null)
    }, 0)
    return child
  }) as unknown as typeof spawn
}

function run(stdout: string, exitCode?: number) {
  return runProjectRoutingWorker({
    command: 'bun',
    args: [],
    cwd: process.cwd(),
    request,
    spawnWorker: fakeSpawn({ stdout, exitCode }),
  })
}

describe('runProjectRoutingWorker', () => {
  test.each([
    'Fix the issue',
    'Explain cat-code architecture',
    'Fix the issue\n> Work in cat-code',
  ])('keeps ordinary chat local without starting a worker: %s', async text => {
    let spawned = false
    const spawnWorker = (() => {
      spawned = true
      throw new Error('Unexpected project routing worker')
    }) as unknown as typeof spawn

    await expect(runProjectRoutingWorker({
      command: 'bun', args: [], cwd: process.cwd(),
      request: { ...request, text }, spawnWorker,
    })).resolves.toEqual({ kind: 'stay' })
    expect(spawned).toBe(false)
  })

  test('returns its single validated decision', async () => {
    await expect(run(
      '{"type":"project-route-result","version":1,"decision":{"kind":"ask","cwd":"/Users/pt/cat-code","name":"cat-code","explicit":false}}\n',
    )).resolves.toEqual({
      kind: 'ask',
      cwd: '/Users/pt/cat-code',
      name: 'cat-code',
      explicit: false,
    })
  })

  test('rejects malformed or duplicate worker records', async () => {
    await expect(run('not json\n')).rejects.toThrow('Project routing did not complete')
    const record = '{"type":"project-route-result","version":1,"decision":{"kind":"stay"}}\n'
    await expect(run(record + record)).rejects.toThrow('Project routing did not complete')
  })

  test('rejects a valid record from a failed worker', async () => {
    await expect(run(
      '{"type":"project-route-result","version":1,"decision":{"kind":"stay"}}\n',
      1,
    )).rejects.toThrow('Project routing did not complete')
  })
})


test.each([
  { kind: 'auto', cwd: '/unlisted', name: 'unlisted', explicit: true },
  { kind: 'auto', cwd: '/Users/pt/cat-code', name: 'cat-code', explicit: false },
])('rejects an unlisted destination or automatic inference', async decision => {
  await expect(run(JSON.stringify({ type: 'project-route-result', version: 1, decision }) + '\n')).rejects.toThrow('Invalid project routing destination')
})
