import { expect, test } from 'bun:test'
import { codeModeBackgroundFixture } from './codeModeBackgroundFixture.js'
import { codeModeLiveView } from './codeModeLiveView.js'
import { codeModeDigest } from './codeMode.js'
import { summarizeFocusedWork } from './focusedTranscriptLayout.js'
import { focusedCallLine } from './focusedCallText.js'
import type { NestedToolUseRow } from './transcriptProjector.js'

test('running receipt advances from real child frames without another wrapper activity stream', () => {
  const fixture = codeModeBackgroundFixture()
  const initial = fixture.row()
  const originalAudit = initial.result!.codeMode!
  expect(originalAudit.calls).toEqual([])
  expect(codeModeLiveView(initial)).toBe(originalAudit)
  fixture.start('read', 'Read', 2)
  const pending = fixture.row()
  expect(codeModeLiveView(pending)!.calls).toHaveLength(1)
  expect(summarizeFocusedWork([pending]).toolCalls).toBe(0)
  fixture.finish('read')
  const read = fixture.row()
  const readView = codeModeLiveView(read)!
  expect(read.result!.codeMode).toBe(originalAudit)
  expect(originalAudit.calls).toEqual([])
  expect(readView.calls[0]!.status).toBe('completed')
  expect(codeModeDigest(readView)).toBe('1 file read')
  expect(summarizeFocusedWork([read]).toolCalls).toBe(1)
  expect(focusedCallLine(read, { signalled: false, cwd: null, tasks: null, turnRows: [read] }).detail).toBe('1 file read')
  expect(readView.output).toBe('Background started')
  expect(codeModeLiveView(read)).toBe(readView)
  expect(codeModeLiveView({ ...read })).toBe(readView)
  fixture.start('check', 'Bash', 4)
  const checking = fixture.row()
  expect(codeModeLiveView(checking)!.calls[0]).toBe(readView.calls[0])
  expect(summarizeFocusedWork([checking]).commands).toBe(0)
  fixture.finish('check')
  expect(summarizeFocusedWork([fixture.row()]).commands).toBe(1)
  // A partial host snapshot and live SDK frames identify the same calls.
  fixture.receipt('running', [{ toolUseId: 'read', name: 'Read', input: { file_path: '/repo/a' }, status: 'running', line: 2 }])
  const partial = fixture.row()
  const merged = codeModeLiveView(partial)!
  expect(merged.calls.map(call => call.toolUseId)).toEqual(['read', 'check'])
  expect(merged.calls[0]!.status).toBe('completed')
  expect(partial.result!.codeMode!.calls[0]!.status).toBe('running')
  expect(summarizeFocusedWork([partial]).toolCalls).toBe(2)
  // Terminal host receipts replace the derived view verbatim, not an append.
  fixture.receipt('completed', [merged.calls[0]!])
  const final = fixture.row()
  expect(codeModeLiveView(final)).toBe(final.result!.codeMode)
  expect(codeModeLiveView(final)!.calls.map(call => call.toolUseId)).toEqual(['read'])
  expect(summarizeFocusedWork([final]).toolCalls).toBe(1)
})

test('running views exclude mismatched generation/session and retain unrelated identities', () => {
  const fixture = codeModeBackgroundFixture('generation-session')
  fixture.start('read', 'Read', 2)
  fixture.finish('read')
  const row = fixture.row()
  const view = codeModeLiveView(row)!
  fixture.start('stale', 'Read', 2, 'old-generation')
  expect(fixture.row()).toBe(row)
  expect(codeModeLiveView(fixture.row())).toBe(view)
  const child = row.children[0] as NestedToolUseRow
  const emptyReceipt = { ...row.result!, codeMode: { ...row.result!.codeMode!, calls: [] } }
  for (const foreign of [{ ...child, sessionId: 'another-session' }, { ...child, codeMode: { ...child.codeMode!, generation: 'another-generation' } }]) {
    const mixed = { ...row, result: emptyReceipt, children: [foreign] }
    expect(codeModeLiveView(mixed)).toBe(emptyReceipt.codeMode)
    expect(summarizeFocusedWork([mixed]).toolCalls).toBe(0)
  }
})
