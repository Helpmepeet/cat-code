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
