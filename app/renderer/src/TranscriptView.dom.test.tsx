import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'

import { createDomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import type { DomTestHarness } from './domTestHarness.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  await harness.teardown()
})

const content = [
  'Copy this **raw source**.',
  '',
  '```ts',
  'const answer = 42',
  '```',
].join('\n')

const row: NestedTranscriptRow = {
  sessionId: 'session-42',
  messageId: 'message-42',
  frameId: 'frame-42',
  blockIndex: 0,
  parentToolUseId: null,
  id: 'session-42:message-42:0:user-text',
  kind: 'user-text',
  role: 'user',
  content,
  isReplay: false,
  children: [],
}

test('Copy message writes the original raw Markdown source', async () => {
  const writes: string[] = []
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    'clipboard',
  )
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        writes.push(value)
      },
    },
  })

  try {
    const tree = await harness.mount(
      <TranscriptRowsView rows={[row]} onMessageAction={() => {}} />,
    )
    const copyMessage = tree.container.querySelector<HTMLButtonElement>(
      '[aria-label="Copy message"]',
    )
    const copyCode = tree.container.querySelector<HTMLButtonElement>(
      '[aria-label="Copy code"]',
    )
    expect(copyCode).not.toBeNull()
    expect(copyMessage).not.toBeNull()

    await act(async () => {
      copyMessage?.click()
    })

    expect(writes).toEqual([content])
  } finally {
    if (descriptor === undefined) {
      delete (globalThis.navigator as Navigator & { clipboard?: unknown }).clipboard
    } else {
      Object.defineProperty(globalThis.navigator, 'clipboard', descriptor)
    }
  }
})

test('Edit and Branch report the row session, verb, and frame id', async () => {
  const actions: Array<[string, string, string]> = []
  const tree = await harness.mount(
    <TranscriptRowsView
      rows={[row]}
      onMessageAction={(sessionId, action, messageId) => {
        actions.push([sessionId, action, messageId])
      }}
    />,
  )

  const edit = tree.container.querySelector<HTMLButtonElement>(
    '[aria-label="Edit from here"]',
  )
  const branch = tree.container.querySelector<HTMLButtonElement>(
    '[aria-label="Branch from here"]',
  )
  expect(edit).not.toBeNull()
  expect(branch).not.toBeNull()

  await act(async () => {
    edit?.click()
    branch?.click()
  })

  expect(actions).toEqual([
    ['session-42', 'edit', 'frame-42'],
    ['session-42', 'branch', 'frame-42'],
  ])
})
