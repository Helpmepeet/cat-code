import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { parseMoveSessionCommand, parseSessionRelocationRequest } from './sessionRelocationWorker.js'

test('manual move boundaries accept only a picker token and a closed worker request', () => {
  const appSessionId = randomUUID()
  const engineSessionId = randomUUID()
  const token = randomUUID()
  expect(parseMoveSessionCommand({ appSessionId, cwdToken: token })).toEqual({ appSessionId, cwdToken: token })
  expect(parseMoveSessionCommand({ appSessionId, cwdToken: null })).toEqual({ appSessionId, cwdToken: null })
  for (const invalid of [
    { appSessionId, cwdToken: '/tmp/project' },
    { appSessionId, cwdToken: token, cwd: '/tmp/project' },
    { appSessionId: 'not-an-id', cwdToken: null },
    { appSessionId, cwdToken: undefined },
  ]) expect(parseMoveSessionCommand(invalid)).toBeNull()

  const source = { cwd: '/tmp/chat', binding: { kind: 'managed', storageRootId: randomUUID(), storageId: randomUUID() } }
  const target = { cwd: '/tmp/project', binding: { kind: 'project' } }
  const request = { type: 'session-relocation', version: 1, appSessionId, engineSessionId, source, target,
    controls: { mode: 'plan', model: 'gpt-6-sol', effort: 'high' } }
  expect(parseSessionRelocationRequest(request)?.engineSessionId).toBe(engineSessionId)
  expect(parseSessionRelocationRequest({ ...request, rollback: true })?.rollback).toBe(true)
  expect(parseSessionRelocationRequest({ ...request, rollback: false })).toBeNull()
  expect(parseSessionRelocationRequest({ ...request, target: { ...target, binding: { kind: 'project', extra: true } } })).toBeNull()
  expect(parseSessionRelocationRequest({ ...request, source: { ...source, cwd: '../chat' } })).toBeNull()
  expect(parseSessionRelocationRequest({ ...request, undo: true })).toBeNull()
  expect(parseSessionRelocationRequest({ ...request, controls: { mode: 'bypassPermissions' } })).toBeNull()
})
