import { expect, test } from 'bun:test'
import { consumeSDKHistoryMessage } from './print.js'
import { toInternalMessages, toSDKMessages } from '../utils/messages/mappers.js'
import { createAssistantMessage, createUserMessage, normalizeMessages, normalizeMessagesForAPI } from '../utils/messages.js'
import type { Message } from '../types/message.js'

function fixture() {
  const codeMode = { cellId: 'outer', generation: 'gen' }
  const outer = createAssistantMessage({ content: [{ type: 'tool_use', id: 'outer', name: 'REPL', input: { code: 'outer source' } }] })
  const child = createAssistantMessage({ codeMode, content: [{ type: 'tool_use', id: 'child', name: 'Read', input: { file_path: 'privatechildmarker' } }] })
  const audit = createUserMessage({ codeMode, content: [{ type: 'tool_result', tool_use_id: 'child', content: 'privatechildmarker' }] })
  const selected = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'outer', content: 'selected output' }] })
  const human = createUserMessage({ content: 'normal human input' })
  return { outer, child, audit, selected, human, frames: toSDKMessages([outer, child, audit, selected, human]) }
}

test('SDK export/import excludes display audits without fabricating authentication', () => {
  const { frames, outer, selected, human } = fixture()
  const imported = toInternalMessages(frames)
  expect(imported.map(m => m.uuid)).toEqual([outer.uuid, selected.uuid, human.uuid])
  expect(imported.map(m => 'message' in m ? m.message : null)).toEqual([outer.message, selected.message, human.message])
  const provider = normalizeMessagesForAPI(normalizeMessages(imported))
  expect(JSON.stringify(provider)).not.toContain('privatechildmarker')
  expect(JSON.stringify(provider)).toContain('selected output')
  for (const message of imported) {
    expect(message).not.toHaveProperty('permissionDecision')
    expect(message).not.toHaveProperty('sourceToolAssistantUUID')
  }
})

test('actual structured input consumer consumes both audit halves before the human queue', () => {
  const { frames, outer, selected, human } = fixture()
  const history: Message[] = []
  const echoed: unknown[] = []
  const queued: unknown[] = []
  for (const frame of frames) {
    if (!consumeSDKHistoryMessage(frame, history, frame => echoed.push(frame))) queued.push(frame)
  }
  expect(history.map(m => m.uuid)).toEqual([outer.uuid])
  expect(echoed).toEqual([frames[0]])
  expect(queued).toEqual([frames[3], frames[4]])
  const importedQueue = toInternalMessages(queued as typeof frames)
  expect(importedQueue.map(m => m.uuid)).toEqual([selected.uuid, human.uuid])
  expect(JSON.stringify(normalizeMessagesForAPI(normalizeMessages([...history, ...importedQueue])))).not.toContain('privatechildmarker')
  // Older display-only virtual frames and untrusted metadata-only audits also stop here.
  expect(consumeSDKHistoryMessage({ ...frames[2]!, code_mode: undefined, isVirtual: true } as typeof frames[number], history)).toBe(true)
  expect(consumeSDKHistoryMessage({ ...frames[2]!, isVirtual: undefined } as typeof frames[number], history)).toBe(true)
})
