/**
 * Durable queue-operation records (`logOperation` → `recordQueueOperation`).
 *
 * The records are the ONLY thing that survives the process, and restore rebuilds
 * the queue from them (`app/sidecar/sessionResume.ts`): every enqueue with no
 * matching retraction is replayed as a message that was still waiting. A
 * retraction that records no uuid is therefore indistinguishable from no
 * retraction at all, which is how a taken-back message came back as a transcript
 * row on every later restore.
 *
 * Written against the REAL persistence path (`TEST_ENABLE_SESSION_PERSISTENCE`
 * plus an isolated config home) and read back through the same
 * `getSessionQueueOperations` the sidecar's resume calls — a mocked recorder
 * would prove only that a function was called.
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import type { UUID } from '../types/ids.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { createUserMessage } from './messages.js'
import {
  clearSessionMessagesCache,
  flushSessionStorage,
  getSessionQueueOperations,
  recordTranscript,
  resetProjectForTesting,
} from './sessionStorage.js'
import {
  clearCommandQueue,
  dequeueAll,
  dequeueAllMatching,
  enqueue,
  getCommandQueue,
  popAllEditable,
  remove,
  removeByFilter,
  resetCommandQueue,
} from './messageQueueManager.js'

const cleanup: string[] = []

afterEach(async () => {
  resetCommandQueue()
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * Run `body` against a real, isolated on-disk session and hand back the durable
 * queue-operation log the sidecar's resume would read.
 */
async function withDurableSession(
  body: () => void,
): Promise<Awaited<ReturnType<typeof getSessionQueueOperations>>> {
  const root = await mkdtemp('/tmp/cat-code-queue-ops-cfg-')
  const sessionDir = await mkdtemp('/tmp/cat-code-queue-ops-session-')
  cleanup.push(root, sessionDir)
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const previousTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  const previousSessionId = getSessionId()
  const previousSessionProjectDir = getSessionProjectDir()
  const sessionId = randomUUID()
  try {
    process.env.CLAUDE_CONFIG_DIR = root
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    resetProjectForTesting()
    switchSession(asSessionId(sessionId), sessionDir)
    clearSessionMessagesCache()
    // A command is only ever queued INTO a running turn, so the transcript
    // always exists by then. It is also what materializes the session file:
    // queue records written before it stay buffered in memory.
    await recordTranscript([createUserMessage({ content: 'the running turn' })])
    body()
    // `logOperation` records fire-and-forget (`void recordQueueOperation`), the
    // same way the engine writes them at runtime.
    await Bun.sleep(0)
    await flushSessionStorage()
    return await getSessionQueueOperations(sessionId)
  } finally {
    clearSessionMessagesCache()
    resetProjectForTesting()
    switchSession(asSessionId(previousSessionId), previousSessionProjectDir)
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    if (previousTestPersistence === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousTestPersistence
    }
  }
}

/** Every primitive that can take a still-queued command back off the queue. */
const RETRACTIONS: Array<{
  name: string
  retract: (command: QueuedCommand) => void
}> = [
  {
    // The desktop's Take back (`app/sidecar/sidecarServer.ts` handlePromptRecall)
    // and the SDK's cancel_async_message (`src/cli/print.ts:3128`).
    name: 'dequeueAllMatching',
    retract: command => {
      dequeueAllMatching(cmd => cmd.uuid === command.uuid)
    },
  },
  {
    name: 'dequeueAll',
    retract: () => {
      dequeueAll()
    },
  },
  {
    // `src/screens/REPL.tsx:2808` hands task notifications to a backgrounded
    // session this way.
    name: 'removeByFilter',
    retract: command => {
      removeByFilter(cmd => cmd.uuid === command.uuid)
    },
  },
  {
    // `remove` matches by reference identity, and `enqueue` stores a copy, so
    // the caller passes the objects it read back out of the queue.
    name: 'remove',
    retract: command => {
      remove(getCommandQueue().filter(cmd => cmd.uuid === command.uuid))
    },
  },
  {
    // The terminal's UP-arrow pull-back into the composer.
    name: 'popAllEditable',
    retract: () => {
      popAllEditable('', 0)
    },
  },
  {
    // ESC while messages are waiting (`src/hooks/useCancelRequest.ts:253`).
    name: 'clearCommandQueue',
    retract: () => {
      clearCommandQueue()
    },
  },
]

for (const { name, retract } of RETRACTIONS) {
  test(`${name} records the uuid of what it took off the queue`, async () => {
    const uuid = randomUUID() as UUID
    const command: QueuedCommand = {
      value: 'take this back',
      mode: 'prompt',
      uuid,
    }
    const state = await withDurableSession(() => {
      enqueue(command)
      retract(command)
    })

    const enqueued = state.operations.filter(op => op.operation === 'enqueue')
    expect(enqueued.map(op => op.uuid)).toEqual([uuid])
    const retracted = state.operations.filter(op => op.operation !== 'enqueue')
    expect(retracted.length).toBe(1)
    expect(retracted[0]?.uuid).toBe(uuid)
  })
}

test('an image-bearing prompt records the content a restore would need', async () => {
  const uuid = randomUUID() as UUID
  const value = [
    { type: 'text' as const, text: 'what is in this?' },
    {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: 'aGVsbG8=',
      },
    },
  ]
  const state = await withDurableSession(() => {
    enqueue({ value, mode: 'prompt', uuid })
  })

  const enqueued = state.operations.find(op => op.operation === 'enqueue')
  expect(enqueued?.uuid).toBe(uuid)
  expect(enqueued?.content).toEqual(value)
})

test('content rides on the enqueue record only, never on the retraction', async () => {
  const uuid = randomUUID() as UUID
  const state = await withDurableSession(() => {
    enqueue({ value: 'the only copy that matters', mode: 'prompt', uuid })
    dequeueAllMatching(cmd => cmd.uuid === uuid)
  })

  const enqueued = state.operations.find(op => op.operation === 'enqueue')
  expect(enqueued?.content).toBe('the only copy that matters')
  const retracted = state.operations.find(op => op.operation !== 'enqueue')
  expect(retracted?.uuid).toBe(uuid)
  expect(retracted?.content).toBeUndefined()
})
