import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKMessage } from '@cat-code/engine/sdk'
import type { ThreadGoalSnapshot } from '../../shared/protocol.js'
import type { RawMessageSessionLog } from './rawMessageLog.js'
import type { SessionMetadataView } from './messageMetadata.js'
import { SDK_MESSAGE_FIXTURE } from './sdkMessageFixtures.js'
import { MetadataInspector } from './MetadataInspector.js'

const assistant: SDKMessage = {
  ...SDK_MESSAGE_FIXTURE.assistant[0]!.message,
  uuid: 'a1',
  requestId: 'req_9',
}
const result: SDKMessage = { ...SDK_MESSAGE_FIXTURE.result[0]!.message, uuid: 'r1' }

function log(messages: SDKMessage[]): RawMessageSessionLog {
  return {
    inputEnabled: true,
    messages,
    retainedBytes: 0,
    truncated: false,
    error: null,
    messageBytes: [],
  }
}

const goal: ThreadGoalSnapshot = {
  threadId: 't',
  goalId: 'goal-42',
  objective: 'Ship the inspector',
  status: 'active',
  tokensUsed: 12000,
  tokenBudget: 50000,
  timeUsedSeconds: 125,
  createdAtMs: 0,
  updatedAtMs: 1,
  summary: '',
}

const session: SessionMetadataView = {
  sessionId: 'engine-xyz',
  mode: 'agent',
  permissionMode: 'acceptEdits',
  tag: 'p4-6b',
  threadGoal: goal,
}

const noop = () => {}

test('renders the read-only drawer with the session + goal sections', () => {
  const html = renderToStaticMarkup(
    <MetadataInspector session={session} log={log([assistant, result])} onClose={noop} />,
  )
  expect(html).toContain('read-only')
  expect(html).toContain('role="dialog"')
  expect(html).toContain('engine-xyz')
  expect(html).toContain('acceptEdits')
  expect(html).toContain('#p4-6b')
  expect(html).toContain('Ship the inspector')
  expect(html).toContain('goal-42')
})

test('defaults the selected message to the last one (the result frame + its usage)', () => {
  const html = renderToStaticMarkup(
    <MetadataInspector session={session} log={log([assistant, result])} onClose={noop} />,
  )
  // Result frame is last → Usage & cost section shows its real numbers.
  expect(html).toContain('Usage &amp; cost')
  expect(html).toContain('$0.0421')
  expect(html).toContain('5321 ms')
})

test('shows the honest "Not available" deferral note, never mocked worktree/file data', () => {
  const html = renderToStaticMarkup(
    <MetadataInspector session={session} log={log([assistant])} onClose={noop} />,
  )
  expect(html).toContain('Not available')
  expect(html).toContain('No per-message account is recorded upstream')
  expect(html).toContain('no transcript-by-id read seam')
})

test('degrades cleanly with an empty log and no session', () => {
  const html = renderToStaticMarkup(
    <MetadataInspector session={null} log={log([])} onClose={noop} />,
  )
  expect(html).toContain('No messages retained')
  expect(html).toContain('No goal on this thread.')
})
