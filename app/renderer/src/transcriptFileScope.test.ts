import { expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import { scopedTranscriptFilePath, transcriptFileScopes } from './transcriptFileScope.js'

type Transition = NonNullable<SessionDescriptor['contextTransitions']>[number]
function move(afterFrameId: string | null, cwd: string): Transition {
  return { id: cwd, afterFrameId, cwd, binding: { kind: 'project' } }
}
function row(id: string, frameId = id): NestedTranscriptRow {
  return { id, frameId, sessionId: 'session', messageId: frameId, blockIndex: 0, parentToolUseId: null,
    kind: 'assistant-text', role: 'assistant', content: 'See report.html', children: [] }
}

test('relative references use the workspace after the last row of a persisted boundary frame', () => {
  const rows = [row('before'), row('boundary-a', 'boundary'), row('boundary-b', 'boundary'), row('after')]
  const scopes = transcriptFileScopes(rows, [move('boundary', '/repo')])
  expect([...scopes]).toEqual([['after', '/repo']])
  expect(scopedTranscriptFilePath('docs/report.html', scopes.get('after'))).toBe('/repo/docs/report.html')
  expect(scopedTranscriptFilePath('docs/report.html', scopes.get('before'))).toBe('docs/report.html')
})

test('repeated moves do not retarget older replies to the latest project', () => {
  const rows = [row('before'), row('first'), row('middle'), row('second'), row('after')]
  const scopes = transcriptFileScopes(rows, [move('first', '/one'), move('second', '/two')])
  expect([...scopes]).toEqual([['middle', '/one'], ['second', '/one'], ['after', '/two']])
})

test('an omitted later boundary invalidates earlier scopes, while a loaded later boundary restores certainty', () => {
  const rows = [row('first'), row('middle'), row('last'), row('after')]
  expect([...transcriptFileScopes(rows, [move('first', '/one'), move('omitted', '/two')])]).toEqual([])
  expect([...transcriptFileScopes(rows, [move('omitted', '/two'), move('last', '/three')])]).toEqual([['after', '/three']])
})

test('a move before the first frame scopes an initially empty conversation', () => {
  expect([...transcriptFileScopes([row('first')], [move(null, '/repo')])]).toEqual([['first', '/repo']])
  expect([...transcriptFileScopes([row('first')])]).toEqual([])
})

test('scoping preserves absolute paths, locations, and web URLs without weakening containment', () => {
  for (const path of ['/elsewhere/report.html', 'http://localhost:3000/page', 'https://example.com/report.html']) {
    expect(scopedTranscriptFilePath(path, '/repo')).toBe(path)
  }
  expect(scopedTranscriptFilePath('./docs/../report.md:12:3', '/repo')).toBe('/repo/report.md:12:3')
  expect(scopedTranscriptFilePath('../other/report.html', '/repo')).toBe('/other/report.html')
})

test('worker origins survive parent moves and missing launch cards without inheriting a new folder', () => {
  const oldWorker = { ...row('old-worker'), parentToolUseId: 'launch', agentCwd: '/one' }
  const newWorker = { ...row('resumed-worker'), parentToolUseId: 'resume', agentCwd: '/two' }
  const legacyWorker = { ...row('legacy-worker'), parentToolUseId: 'launch' }
  const nested = { ...row('launch'), children: [oldWorker, legacyWorker, {
    ...row('nested-launch'), parentToolUseId: 'launch', agentCwd: '/one', children: [newWorker],
  }] }
  const scopes = transcriptFileScopes([row('move'), nested], [move('move', '/two')])
  expect(scopes.get('old-worker')).toBe('/one')
  expect(scopes.get('resumed-worker')).toBe('/two')
  expect(scopes.has('legacy-worker')).toBe(false)
  expect(transcriptFileScopes([oldWorker, legacyWorker], [move(null, '/two')]).get('old-worker')).toBe('/one')
  expect(transcriptFileScopes([oldWorker, legacyWorker], [move(null, '/two')]).has('legacy-worker')).toBe(false)
})

test('file URLs become absolute paths without decoding literal percent escapes twice', () => {
  for (const cwd of [undefined, '/different-project']) {
    expect(scopedTranscriptFilePath('file:///repo/report%2520final.html', cwd)).toBe('/repo/report%20final.html')
    expect(scopedTranscriptFilePath('/repo/report%20final.html', cwd)).toBe('/repo/report%20final.html')
  }
})
