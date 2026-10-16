import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { createTurnFrameOwnership } from './turnFrameOwnership.js'

const launch = (id: string) => ({
  type: 'assistant', uuid: `launch-${id}`, parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id, name: 'Agent', input: {} }] },
}) as unknown as SDKMessage
const result = (id: string) => ({
  type: 'user', uuid: `result-${id}`, parent_tool_use_id: null,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
}) as unknown as SDKMessage
const step = (parent: string) => ({
  type: 'assistant', uuid: `step-${parent}`, parent_tool_use_id: parent,
  message: { content: [{ type: 'text', text: 'working' }] },
}) as unknown as SDKMessage

describe('turn frame ownership', () => {
  test('a foreground run is the turn\'s activity until it returns', () => {
    const turn = createTurnFrameOwnership()
    expect(turn.observe(launch('fg'))).toBe(true)
    expect(turn.observe(step('fg'))).toBe(true)
    turn.observe(result('fg'))
    expect(turn.observe(step('fg'))).toBe(false)
  })

  test('a background launch stops counting once its acknowledgement arrives', () => {
    const turn = createTurnFrameOwnership()
    turn.observe(launch('bg'))
    turn.observe(result('bg'))
    expect(turn.observe(step('bg'))).toBe(false)
  })

  test('a worker launched by an earlier turn never counts for a later one', () => {
    const turn = createTurnFrameOwnership()
    turn.observe(launch('old'))
    turn.reset()
    expect(turn.observe(step('old'))).toBe(false)
    expect(turn.observe(launch('new'))).toBe(true)
  })
})
