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
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../bootstrap/state.js'
import type { UUID } from 'crypto'
import { asSessionId } from '../types/ids.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { createUserMessage } from './messages.js'
import {
  clearSessionMessagesCache,
  flushSessionStorage,
  getSessionQueueOperations,
  getTranscriptPathForSession,
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

type QueueLog = Awaited<ReturnType<typeof getSessionQueueOperations>>

/**
 * Batched-write window in `sessionStorage` (`FLUSH_INTERVAL_MS`). An unflushed
 * read that waits less than this cannot be satisfied by the batch timer, so a
 * record it finds was pushed out by the writer itself.
 */
const UNFLUSHED_DEADLINE_MS = 60

/**
 * Run `body` against a real, isolated on-disk session and hand back the durable
 * queue-operation log the sidecar's resume would read.
 *
 * `unflushed` skips the explicit flush, which is what the engine's own shutdown
 * does not do either: it reads the file inside the batch window, so only a
 * record the write path forced out is visible.
 */
async function withDurableSession(
  // The session id is handed to the body because a durability test has to read
  // the transcript file directly rather than through the cache the helper warms.
  body: (sessionId: string) => void | Promise<void>,
  options: { unflushed?: boolean; until?: (log: QueueLog) => boolean } = {},
): Promise<QueueLog> {
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
    // Land the transcript now, so the batch timer the unflushed read races is
    // the one `body` starts and not one already half spent.
    await flushSessionStorage()
    await body(sessionId)
    if (!options.unflushed) {
      // `logOperation` records fire-and-forget (`void recordQueueOperation`),
      // the same way the engine writes them at runtime.
      await Bun.sleep(0)
      await flushSessionStorage()
      return await getSessionQueueOperations(sessionId)
    }
    const deadline = Date.now() + UNFLUSHED_DEADLINE_MS
    let log = await getSessionQueueOperations(sessionId)
    while (!(options.until?.(log) ?? true) && Date.now() < deadline) {
      await Bun.sleep(5)
      log = await getSessionQueueOperations(sessionId)
    }
    return log
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
    // NOT ESC, which pulls messages back into the composer via popAllEditable.
    // The second press of kill-agents (`src/hooks/useCancelRequest.ts:253`) and
    // the remote `queue_clear` (`src/hooks/usePtcloveBridge.ts:466`).
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

test('a prompt whose value carries image blocks records them verbatim', async () => {
  // True for the desktop and bridge paths, whose values ARE ContentBlockParam[].
  // The terminal's own pasted images are NOT covered: see the next test.
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

test("the terminal's pasted images are not in the record, only its text", async () => {
  // KNOWN GAP, deliberately pinned. `handlePromptSubmit` queues a string value
  // with the images alongside in `pastedContents`
  // (`src/utils/handlePromptSubmit.ts:414`), and only `value` is recorded. So a
  // restore of a terminal-queued image prompt brings back the text and its
  // `[Image #1]` reference with no image. Recording `pastedContents` would put
  // full-size, pre-resize base64 into the transcript on every enqueue including
  // the requeue path, and the transcript is read whole on every resume, so the
  // text-only record is the cheaper half-loaf. Change this test if that trade
  // is revisited.
  const uuid = randomUUID() as UUID
  const state = await withDurableSession(() => {
    enqueue({
      value: 'what is in [Image #1]',
      mode: 'prompt',
      uuid,
      pastedContents: {
        1: {
          id: 1,
          type: 'image',
          content: 'aGVsbG8=',
          mediaType: 'image/png',
        },
      },
    })
  })

  const enqueued = state.operations.find(op => op.operation === 'enqueue')
  expect(enqueued?.content).toBe('what is in [Image #1]')
  expect(JSON.stringify(enqueued)).not.toContain('aGVsbG8=')
})

test('a retraction record carries the uuid and nothing else', async () => {
  // Its ONLY job is to name what stopped waiting. Content on a retraction is a
  // duplicate copy of an image-bearing prompt that no reader consults, and
  // `mode` is read on the enqueue (`selectUndeliveredPrompts` filters
  // non-prompts there) and by nobody here.
  const uuid = randomUUID() as UUID
  const state = await withDurableSession(() => {
    enqueue({ value: 'the only copy that matters', mode: 'prompt', uuid })
    dequeueAllMatching(cmd => cmd.uuid === uuid)
  })

  const enqueued = state.operations.find(op => op.operation === 'enqueue')
  expect(enqueued?.content).toBe('the only copy that matters')
  const retracted = state.operations.find(op => op.operation !== 'enqueue')
  expect(Object.keys(retracted ?? {}).sort()).toEqual([
    'operation',
    'sessionId',
    'timestamp',
    'uuid',
  ])
  expect(retracted?.uuid).toBe(uuid)
})

test('a prompt requeued under the same uuid lands as enqueue, retraction, enqueue', async () => {
  // The order restore depends on. `drainOneQueuedPrompt` puts the SAME command
  // object back after a turn that rejected before durable acceptance
  // (`app/sidecar/sidecarServer.ts`), so the log holds a retraction BETWEEN two
  // enqueues of one uuid. Read out of order, that message is destroyed on
  // restore, so the writer's push order is a load-bearing contract.
  const uuid = randomUUID() as UUID
  const command: QueuedCommand = { value: 'retry me', mode: 'prompt', uuid }
  const state = await withDurableSession(() => {
    enqueue(command)
    dequeueAllMatching(cmd => cmd.uuid === uuid)
    enqueue(command)
  })

  expect(state.operations.map(op => op.operation)).toEqual([
    'enqueue',
    'dequeue',
    'enqueue',
  ])
  expect(state.operations.every(op => op.uuid === uuid)).toBe(true)
})

test('a retraction is durable without waiting for the batched write', async () => {
  // A lost enqueue costs nothing: the message simply is not recovered. A lost
  // RETRACTION resurrects a message the user took back, on this restore and
  // every later one. Clearing the queue and quitting inside the batch window is
  // an ordinary sequence, so retractions cannot wait for the timer.
  const uuid = randomUUID() as UUID
  const state = await withDurableSession(
    () => {
      enqueue({ value: 'take this back', mode: 'prompt', uuid })
      dequeueAllMatching(cmd => cmd.uuid === uuid)
    },
    {
      unflushed: true,
      until: log => log.operations.some(op => op.operation !== 'enqueue'),
    },
  )

  const retracted = state.operations.filter(op => op.operation !== 'enqueue')
  expect(retracted.map(op => op.uuid)).toEqual([uuid])
})

test('a flush that overlaps another one still waits for the record to land', async () => {
  // The retraction flush above makes overlapping flushes ordinary: QueryEngine
  // flushes at turn end, the desktop handoff flushes, and now every retraction
  // does. A flush that returns while another drain already holds the batch
  // reports a durability it does not have, and a caller that exits right after
  // it loses the record. That is not theoretical: adding the retraction flush
  // emptied the transcript in the two-process resume probe until this held.
  const uuid = randomUUID() as UUID
  await withDurableSession(
    async sessionId => {
      enqueue({ value: 'the record that must survive', mode: 'prompt', uuid })
      // Let the record reach the per-file write queue.
      await Bun.sleep(0)
      // Deliberately not awaited: this drain takes the batch and is still
      // writing when the next flush arrives.
      void flushSessionStorage()
      await flushSessionStorage()
      // Synchronously, the way `process.exit` is synchronous. Any await here
      // gives the in-flight write time to land and hides the early return.
      expect(
        readFileSync(getTranscriptPathForSession(sessionId), 'utf8'),
      ).toContain(uuid)
    },
    { unflushed: true },
  )
})

test('popAllEditable retracts only the commands it took', async () => {
  // A false retraction here is the inverse failure: it marks a command that is
  // STILL on the queue as taken back, so a restore drops a message that was
  // genuinely waiting.
  const pulled = randomUUID() as UUID
  const left = randomUUID() as UUID
  const state = await withDurableSession(() => {
    enqueue({ value: 'pull me into the composer', mode: 'prompt', uuid: pulled })
    enqueue({ value: 'agent finished', mode: 'task-notification', uuid: left })
    const result = popAllEditable('', 0)
    expect(result?.text).toBe('pull me into the composer')
    // The non-editable one is auto-processed later, so it must still be queued.
    expect(getCommandQueue().map(cmd => cmd.uuid)).toEqual([left])
  })

  const retracted = state.operations.filter(op => op.operation !== 'enqueue')
  expect(retracted.map(op => op.uuid)).toEqual([pulled])
})

test('popAllEditable with nothing editable retracts nothing', async () => {
  const uuid = randomUUID() as UUID
  const state = await withDurableSession(() => {
    enqueue({ value: 'agent finished', mode: 'task-notification', uuid })
    expect(popAllEditable('', 0)).toBeUndefined()
    expect(getCommandQueue().map(cmd => cmd.uuid)).toEqual([uuid])
  })

  expect(state.operations.map(op => op.operation)).toEqual(['enqueue'])
})
