import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getSessionId, getSessionProjectDir, switchSession } from '../bootstrap/state.js'
import { asAgentId, asSessionId } from '../types/ids.js'
import {
  getAgentTranscriptForSession,
  getAgentTranscriptPathForSession,
  getDisplayAgentTranscriptForSession,
} from './sessionStorage.js'

// Real JSONL reads guard the display/resume separation; mock byte receipts in
// the branch-budget tests cannot establish this storage contract.
describe('bounded agent display history', () => {
  const originalId = getSessionId()
  const originalProject = getSessionProjectDir()
  let directory: string
  let sessionId: string
  const agentId = asAgentId('display-fixture')

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cc-agent-display-'))
    sessionId = randomUUID()
    switchSession(asSessionId(sessionId), directory)
  })
  afterEach(() => {
    switchSession(originalId, originalProject)
    rmSync(directory, { recursive: true, force: true })
  })

  function writeChain(contents: string[]): { path: string; uuids: string[]; lines: string[] } {
    const uuids = contents.map(() => randomUUID())
    const lines = contents.map((content, index) => JSON.stringify({
      parentUuid: index === 0 ? null : uuids[index - 1],
      type: 'assistant', isSidechain: true, agentId, sessionId,
      uuid: uuids[index], timestamp: `2026-10-04T00:00:0${index}.000Z`,
      message: { role: 'assistant', content: [{ type: 'text', text: content }] },
    }))
    const path = getAgentTranscriptPathForSession(sessionId, agentId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, lines.join('\n') + '\n')
    return { path, uuids, lines }
  }

  test('bounded display leaves the full agent resume reader intact', async () => {
    const { uuids, lines } = writeChain(['x'.repeat(8 * 1024 * 1024), 'recent answer'])
    const tailBytes = Buffer.byteLength(lines[1]! + '\n')
    const display = await getDisplayAgentTranscriptForSession(sessionId, agentId, {
      maxBytes: tailBytes, maxMessages: 100,
    })
    expect(display?.messages.map(message => message.uuid)).toEqual(uuids.slice(-1))
    expect(display?.truncated).toBe(true)
    expect(display?.bytesRead).toBe(tailBytes + 1)
    const resumed = await getAgentTranscriptForSession(sessionId, agentId)
    expect(resumed?.messages.map(message => message.uuid)).toEqual(uuids)
  })

  test('complete branches remain ordered and a message cap announces truncation', async () => {
    const { uuids, lines } = writeChain(['first', 'second', 'third'])
    const bytes = Buffer.byteLength(lines.join('\n') + '\n')
    const complete = await getDisplayAgentTranscriptForSession(sessionId, agentId, {
      maxBytes: bytes, maxMessages: 3,
    })
    expect(complete?.messages.map(message => message.uuid)).toEqual(uuids)
    expect(complete?.truncated).toBe(false)
    expect(complete?.bytesRead).toBe(bytes)
    const capped = await getDisplayAgentTranscriptForSession(sessionId, agentId, {
      maxBytes: bytes, maxMessages: 1,
    })
    expect(capped?.messages.map(message => message.uuid)).toEqual(uuids.slice(-1))
    expect(capped?.truncated).toBe(true)
  })
})
