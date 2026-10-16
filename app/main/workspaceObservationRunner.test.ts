import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSavedWorkspaceObservationReader, runWorkspaceObservationWorker } from './workspaceObservationRunner.js'
import { parseWorkspaceObservation, parseWorkspaceObservationRequest } from '../shared/workspaceObservation.js'

test('workspace observation boundary accepts only a conversation identity and bounded display metadata', () => {
  const engineSessionId = randomUUID()
  expect(parseWorkspaceObservationRequest({ engineSessionId })).toEqual({ engineSessionId })
  expect(parseWorkspaceObservationRequest({ engineSessionId, cwd: '/elsewhere' })).toBeNull()
  expect(parseWorkspaceObservationRequest({ engineSessionId: '--help' })).toBeNull()
  expect(parseWorkspaceObservation({ cwd: '/project', lastWorkingBranch: 'feature/日本語(v2)' })).toEqual({ cwd: '/project', lastWorkingBranch: 'feature/日本語(v2)' })
  for (const value of [{ cwd: '/project', extra: true }, { cwd: 7 }, { cwd: '' }, { cwd: 'relative/project' }, { cwd: '/x\0y' }, { cwd: '/project', lastWorkingBranch: {} }, { cwd: '/project', lastWorkingBranch: 'x'.repeat(4097) }]) {
    expect(parseWorkspaceObservation(value)).toBeNull()
  }
})

test('saved workspace reads coalesce, cache unchanged transcripts, and serialize worker starts', async () => {
  const root = mkdtempSync('/private/tmp/workspace-observation-cache-')
  const file = join(root, 'session.jsonl')
  writeFileSync(file, 'original')
  let reads = 0
  let finish: ((value: { cwd: string; lastWorkingBranch: string }) => void) | undefined
  let began = () => {}
  const nextStart = () => new Promise<void>(resolve => { began = resolve })
  const read = createSavedWorkspaceObservationReader(() => {
    reads++
    began()
    return new Promise(resolve => { finish = resolve })
  })
  try {
    const firstStart = nextStart()
    const one = read(root, 'session', file)
    const two = read(root, 'session', file)
    await firstStart
    expect(reads).toBe(1)
    finish!({ cwd: root, lastWorkingBranch: 'main' })
    expect(await one).toEqual(await two)
    expect(await read(root, 'session', file)).toEqual({ cwd: root, lastWorkingBranch: 'main' })
    expect(reads).toBe(1)
    writeFileSync(file, 'changed transcript')
    const secondStart = nextStart()
    const updated = read(root, 'session', file)
    await secondStart
    expect(reads).toBe(2)
    await expect(read(root, 'different-session', file)).rejects.toThrow('Another conversation')
    finish!({ cwd: root, lastWorkingBranch: 'changed' })
    expect((await updated).lastWorkingBranch).toBe('changed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('worker output is screened and malformed or duplicate records fail closed', async () => {
  const root = mkdtempSync('/private/tmp/workspace-observation-wire-')
  const script = join(root, 'worker.ts')
  try {
    for (const [output, accepted] of [
      [JSON.stringify({ cwd: root, lastWorkingBranch: 'main' }), true],
      [JSON.stringify({ cwd: root, extra: true }), false],
      [JSON.stringify({ cwd: root, lastWorkingBranch: { accessToken: 'never-emit' } }), false],
      [`${JSON.stringify({ cwd: root })}\n${JSON.stringify({ cwd: root })}`, false],
    ] as const) {
      writeFileSync(script, `await Bun.stdin.text(); process.stdout.write(${JSON.stringify(output + '\n')});`)
      const promise = runWorkspaceObservationWorker({ command: process.execPath, args: [script], cwd: root, engineSessionId: randomUUID() })
      if (accepted) expect(await promise).toEqual({ cwd: root, lastWorkingBranch: 'main' })
      else await expect(promise).rejects.toThrow('Could not read')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
