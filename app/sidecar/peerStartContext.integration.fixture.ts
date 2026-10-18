import { expect, spyOn } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const root = process.argv[2]!
const populated = process.argv[3] === 'true'
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = { VERSION: 'peer-start-test' }
const { createSidecarSessionController } = await import('./sessionController.js')
const { setPeerHostRequester } = await import('./peerHostRequester.js')
const bootstrap = await import('../../src/bootstrap/state.js')
const { asSessionId } = await import('../../src/types/ids.js')
const storage = await import('../../src/utils/sessionStorage.js')
const { releaseActiveTranscriptLease } = await import('../../src/utils/transcriptLease.js')
const claude = await import('../../src/services/api/claude.js')
const { createAssistantMessage, normalizeMessagesForAPI } = await import('../../src/utils/messages.js')
bootstrap.switchSession(asSessionId(randomUUID()), join(root, 'transcript'))
bootstrap.setSessionProvider('openai')
let rosterCalls = 0
setPeerHostRequester(async () => {
  rosterCalls++
  return { ok: true, value: { peers: populated ? [{
    name: 'UniquePeerRosterTest', status: 'live', presence: 'running', title: 'Other work',
    lastActivity: 0, appSessionId: 'peer-app', engineSessionId: 'peer-engine',
  }] : [] } } as never
})
const requests: Array<{ messages: string; system: string }> = []
const model = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* ({ messages, tools, systemPrompt }) {
  requests.push({ messages: JSON.stringify(normalizeMessagesForAPI(messages, tools)), system: JSON.stringify(systemPrompt) })
  yield createAssistantMessage({ content: 'First turn complete.' })
})
const session = await createSidecarSessionController({ probe: false, cwd: join(root, 'workspace'), appSessionId: randomUUID() })
try {
  await session.controller.submit('Start work here')
  expect(requests).toHaveLength(1)
  expect(rosterCalls).toBe(1)
  expect(requests[0]!.system).not.toContain('UniquePeerRosterTest')
  expect(requests[0]!.system).not.toContain('Other sessions open in this workspace')
  if (populated) {
    expect(requests[0]!.messages).toContain('UniquePeerRosterTest')
    expect(requests[0]!.messages).toContain('Other sessions open in this workspace')
  } else {
    expect(requests[0]!.messages).not.toContain('Other sessions open in this workspace')
  }
  await session.controller.submit('Continue')
  expect(rosterCalls).toBe(1)
} finally {
  await session.disposeMcpLifecycle?.()
  session.lidWork?.dispose()
  model.mockRestore()
  setPeerHostRequester(null)
  await storage.flushSessionStorage()
  await releaseActiveTranscriptLease()
}
console.log('peer start controller passed')
process.exit(0)
