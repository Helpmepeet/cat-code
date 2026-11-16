import { expect, test } from 'bun:test'
import { codeModeBackgroundFixture } from './codeModeBackgroundFixture.js'
import { codeModeChildView } from './codeModeChildView.js'
import { codeModeLiveView } from './codeModeLiveView.js'
import { findToolOutputRow } from './toolOutputRow.js'
import type { NestedToolUseRow } from './transcriptProjector.js'
import { codeModeInputWasOmitted } from './codeMode.js'

const child = (parent: NestedToolUseRow, id: string) => parent.children.find((row): row is NestedToolUseRow => row.kind === 'tool-use' && row.toolUseId === id)!

test('canonical host input overlays submitted history while retaining real result, IDs and sibling identity', () => {
  const fixture = codeModeBackgroundFixture('canonical-child')
  fixture.start('command', 'Bash', 2)
  fixture.finish('command', 'Permission declined', true)
  fixture.start('sibling', 'Read', 4)
  fixture.finish('sibling', 'Genuine sibling output')
  const before = fixture.row()
  const submitted = child(before, 'command')
  const sibling = child(before, 'sibling')
  const observed = codeModeLiveView(before)!.calls
  const final = { ...observed[0]!, input: { command: 'printf hook-final-command' }, status: 'blocked' }
  fixture.receipt('blocked', [final, observed[1]!])
  const parent = fixture.row()
  const ledger = parent.result!.codeMode!.calls
  const projected = codeModeChildView(parent, ledger[0]!, child(parent, 'command'))
  expect(projected.input.command).toBe('printf hook-final-command')
  expect(submitted.input.command).toBe('test -e /repo/a')
  expect(child(parent, 'command')).toBe(submitted)
  expect(projected.id).toBe(submitted.id)
  expect(projected.status).toBe(submitted.status)
  expect(projected.result).toBe(submitted.result)
  expect(projected.children).toBe(submitted.children)
  expect(child(parent, 'sibling')).toBe(sibling)
  expect(codeModeChildView(parent, ledger[1]!, sibling)).toBe(sibling)
  expect(codeModeChildView(parent, ledger[0]!, submitted)).toBe(projected)
  expect(findToolOutputRow(fixture.rows(), submitted.id)).toBe(projected)
  expect(findToolOutputRow(fixture.rows(), `${parent.id}:audit:command`)).toBe(projected)
})

test('canonical Agent input retains nested Agent history and no-host-evidence keeps submitted input', () => {
  const fixture = codeModeBackgroundFixture('canonical-agent')
  fixture.start('agent', 'Agent', 2)
  fixture.agentChild('agent', 'nested-read')
  const before = fixture.row()
  const raw = child(before, 'agent')
  const observed = codeModeLiveView(before)!.calls[0]!
  expect(codeModeChildView(before, observed, raw)).toBe(raw)
  fixture.receipt('completed', [{ ...observed, status: 'completed', input: { prompt: 'Final hook-approved task' } }])
  const parent = fixture.row()
  const view = codeModeChildView(parent, parent.result!.codeMode!.calls[0]!, child(parent, 'agent'))
  expect(view.input.prompt).toBe('Final hook-approved task')
  expect(view.children).toBe(raw.children)
  expect(view.children[0]!.id).toContain('nested-read')
  expect(view.result).toBe(raw.result)
  expect(view.agentCompletion).toBe(raw.agentCompletion)
})

test('running partial host ledgers keep final input when SDK results advance and omissions never restore originals', () => {
  const fixture = codeModeBackgroundFixture('canonical-running')
  fixture.start('command', 'Bash', 2)
  fixture.finish('command', 'Actual output')
  const raw = child(fixture.row(), 'command')
  const observed = codeModeLiveView(fixture.row())!.calls[0]!
  fixture.receipt('running', [{ ...observed, status: 'running', input: { command: 'printf final-running' } }])
  const running = fixture.row()
  expect(codeModeLiveView(running)!.calls[0]!.input).toEqual({ command: 'printf final-running' })
  expect(codeModeChildView(running, codeModeLiveView(running)!.calls[0]!, raw).input.command).toBe('printf final-running')
  fixture.receipt('completed', [{ ...observed, input: { omitted: true, reason: 'Final executable input display limit', bytes: 70000 }, inputOmission: { bytes: 70000 } }])
  const parent = fixture.row()
  const omitted = codeModeChildView(parent, parent.result!.codeMode!.calls[0]!, raw)
  expect(omitted.input.command).toBeUndefined()
  expect(omitted.codeModeInputOmitted).toBe(true)
  expect(raw.input.command).toBe('test -e /repo/a')
  expect(findToolOutputRow(fixture.rows(), raw.id)).toBe(omitted)
  const boundedAway = findToolOutputRow([{ ...parent, children: [] }], `${parent.id}:audit:command`)!
  expect(boundedAway.codeModeInputOmitted).toBe(true)
  expect(boundedAway.input.command).toBeUndefined()
})

test('sentinel-looking MCP arguments remain data, including real target fields and nested fake control', () => {
  const fixture = codeModeBackgroundFixture('guest-omission-spoof')
  fixture.start('save', 'mcp__fixture__save', 2)
  fixture.finish('save', 'Saved target')
  const raw = child(fixture.row(), 'save')
  const observed = codeModeLiveView(fixture.row())!.calls[0]!
  const input = { omitted: true, reason: 'Final executable input display limit', bytes: 1, file_path: '/actual-target', inputOmission: { bytes: 90000 } }
  fixture.receipt('completed', [{ ...observed, input }])
  const parent = fixture.row()
  const call = parent.result!.codeMode!.calls[0]!
  const view = codeModeChildView(parent, call, raw)
  expect(codeModeInputWasOmitted(call)).toBe(false)
  expect(view.codeModeInputOmitted).toBeUndefined()
  expect(view.input).toEqual(input)
  expect(view.input.file_path).toBe('/actual-target')
  expect(findToolOutputRow(fixture.rows(), raw.id)).toBe(view)
  expect(view.result).toBe(raw.result)
  expect(raw.input).toEqual({ command: 'test -e /repo/a' })
  const restored = findToolOutputRow([{ ...parent, children: [] }], `${parent.id}:audit:save`)!
  expect(restored.codeModeInputOmitted).toBeUndefined()
  expect(restored.input).toEqual(input)
})

test('host omission metadata survives running merges and clears when a small canonical input arrives', () => {
  const fixture = codeModeBackgroundFixture('host-omission-clear')
  fixture.start('save', 'Bash', 2)
  fixture.finish('save', 'Actual output')
  const raw = child(fixture.row(), 'save')
  const observed = codeModeLiveView(fixture.row())!.calls[0]!
  fixture.receipt('running', [{ ...observed, status: 'running', input: raw.input, inputOmission: { bytes: 90000 } }])
  const running = fixture.row()
  const merged = codeModeLiveView(running)!.calls[0]!
  expect(merged.inputOmission).toEqual({ bytes: 90000 })
  const omitted = codeModeChildView(running, merged, raw)
  expect(omitted.codeModeInputOmitted).toBe(true)
  fixture.receipt('completed', [{ ...observed, input: { command: 'printf small-final-input' } }])
  const parent = fixture.row()
  const call = parent.result!.codeMode!.calls[0]!
  const small = codeModeChildView(parent, call, raw)
  expect(small.codeModeInputOmitted).toBeUndefined()
  expect(small.input.command).toBe('printf small-final-input')
  expect(codeModeChildView(parent, call, omitted).codeModeInputOmitted).toBeUndefined()
  expect(omitted.codeModeInputOmitted).toBe(true)
  expect(raw.codeModeInputOmitted).toBeUndefined()
  expect(findToolOutputRow(fixture.rows(), raw.id)).toBe(small)
})
