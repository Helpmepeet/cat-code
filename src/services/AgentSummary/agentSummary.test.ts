import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Periodic sub-agent summarization used to re-fork on every 30s tick with the
// only guard being `messages.length < 3`. Each tick sends the sub-agent's
// ENTIRE transcript, so an idle sub-agent paid for a full-context request
// forever on byte-identical input. These tests drive the real timer loop with
// the model call stubbed and assert on how many requests actually go out.

type FakeMessage = {
  type: string
  uuid: string
  message: { role: string; content: unknown }
}

const actualSessionStorage = await import('../../utils/sessionStorage.js')
const actualForkedAgent = await import('../../utils/forkedAgent.js')
const actualLocalAgentTask = await import(
  '../../tasks/LocalAgentTask/LocalAgentTask.js'
)
const actualLog = await import('../../utils/log.js')

let transcriptMessages: FakeMessage[] = []
let forkCallCount = 0
let forkShouldThrow = false

function userMsg(uuid: string): FakeMessage {
  return { type: 'user', uuid, message: { role: 'user', content: `m-${uuid}` } }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(r => setTimeout(r, 5))
  }
  return predicate()
}

beforeEach(async () => {
  transcriptMessages = [userMsg('a'), userMsg('b'), userMsg('c')]
  forkCallCount = 0
  forkShouldThrow = false

  await mock.module('src/utils/sessionStorage.js', () => ({
    ...actualSessionStorage,
    getAgentTranscript: async () => ({
      messages: transcriptMessages,
      contentReplacements: [],
    }),
  }))
  await mock.module('src/utils/forkedAgent.js', () => ({
    ...actualForkedAgent,
    runForkedAgent: async () => {
      forkCallCount++
      if (forkShouldThrow) throw new Error('summary request failed')
      return {
        messages: [
          {
            type: 'assistant',
            uuid: `s-${forkCallCount}`,
            message: { content: [{ type: 'text', text: 'Reading foo.ts' }] },
          },
        ],
      }
    },
  }))
  await mock.module('src/tasks/LocalAgentTask/LocalAgentTask.js', () => ({
    ...actualLocalAgentTask,
    updateAgentSummary: () => {},
  }))
  await mock.module('src/utils/log.js', () => ({
    ...actualLog,
    logError: () => {},
  }))
})

afterEach(() => {
  mock.restore()
})

async function start() {
  const { startAgentSummarization } = await import('./agentSummary.js')
  return startAgentSummarization(
    'task-1',
    'agent-1' as never,
    { forkContextMessages: [] } as never,
    (() => {}) as never,
    { intervalMs: 5 },
  )
}

describe('startAgentSummarization request suppression', () => {
  test('does not re-request while the transcript is unchanged', async () => {
    const { stop } = await start()
    try {
      expect(await waitUntil(() => forkCallCount >= 1)).toBe(true)
      // ~40 further ticks at intervalMs 5. Before the signature check this
      // fired a full-context request on every one of them.
      await new Promise(r => setTimeout(r, 200))
      expect(forkCallCount).toBe(1)
    } finally {
      stop()
    }
  })

  test('re-requests once the transcript actually changes', async () => {
    const { stop } = await start()
    try {
      expect(await waitUntil(() => forkCallCount >= 1)).toBe(true)
      transcriptMessages = [...transcriptMessages, userMsg('d')]
      expect(await waitUntil(() => forkCallCount >= 2)).toBe(true)
    } finally {
      stop()
    }
  })

  test('retries after a failed request instead of wedging', async () => {
    forkShouldThrow = true
    const { stop } = await start()
    try {
      // Transcript never changes. If the signature were kept on the error
      // path, this state could never be summarized again.
      expect(await waitUntil(() => forkCallCount >= 2)).toBe(true)
    } finally {
      stop()
    }
  })

  test('stops requesting after stop()', async () => {
    const { stop } = await start()
    expect(await waitUntil(() => forkCallCount >= 1)).toBe(true)
    stop()
    const afterStop = forkCallCount
    await new Promise(r => setTimeout(r, 60))
    expect(forkCallCount).toBe(afterStop)
  })
})
