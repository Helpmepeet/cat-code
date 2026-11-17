import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LiveWorkerItem } from '../../shared/protocol.js'
import { PermissionQueue } from './PermissionQueue.js'
import type { PermissionQueueItem, PermissionRequest } from './permissionState.js'

/**
 * The queue's own wiring, over static markup (this package has no DOM harness —
 * see AccountsPage.test.tsx's header). What matters here is which controls each
 * card is allowed to render, which IS visible in the markup.
 */

function queueItem(request: PermissionRequest): PermissionQueueItem {
  return { request, submitted: false, dismissed: false }
}

const BASH: PermissionRequest = {
  requestId: 'perm-bash',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: { command: 'date' },
    tool_use_id: 'toolu-1',
  },
}

/**
 * An AskUserQuestion reaches the GENERIC queue only when its questions could not
 * be read (`selectGenericPermissionQueue`); the readable ones are owned by
 * AskQuestionFlow. This one's `questions` is not an array.
 */
const MALFORMED_ASK: PermissionRequest = {
  requestId: 'perm-ask',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    input: { questions: 'not an array' },
    tool_use_id: 'toolu-2',
  },
}

const ALLOW_ROW = '>Yes<'
const REFUSE_ROW = '>No<'

const WORKER: LiveWorkerItem = {
  agentId: 'worker-42',
  handle: 'Vale',
  role: 'coding-worker',
  status: 'running',
  description: 'Check the failing test',
}

test('an ordinary command offers Run and Deny', () => {
  const html = renderToStaticMarkup(
    <PermissionQueue
      items={[queueItem(BASH)]}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
    />,
  )
  expect(html).toContain('>Run</span>')
  expect(html).toContain('>Deny</span>')
})

test('threads the engine worker snapshot to a relayed card', () => {
  const html = renderToStaticMarkup(
    <PermissionQueue
      items={[
        queueItem({
          ...BASH,
          request: { ...BASH.request, agent_id: 'worker-42' },
        }),
      ]}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
      workers={[WORKER]}
    />,
  )

  expect(html).toContain('>Vale<')
  expect(html).not.toContain('@Vale')
  expect(html).toContain('Relayed from Vale')
  expect(html).not.toContain('worker-42')
})

test('an unreadable AskUserQuestion card cannot be allowed by mouse either', () => {
  // The keyboard path already refuses these (`selectVisiblePermission` excludes
  // AskUserQuestion), but the card's own Allow button used to send
  // `{behavior:'allow', updatedInput:{}}`, running the tool with NO answers.
  // Mouse and keyboard must agree, and they now read the same option list.
  const html = renderToStaticMarkup(
    <PermissionQueue
      items={[queueItem(MALFORMED_ASK)]}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
    />,
  )
  expect(html).not.toContain(ALLOW_ROW)
  expect(html).toContain(REFUSE_ROW)
  expect(html).toContain('it can only be denied')
})

test('a mixed queue restricts only the AskUserQuestion card', () => {
  const html = renderToStaticMarkup(
    <PermissionQueue
      items={[queueItem(BASH), queueItem(MALFORMED_ASK)]}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
    />,
  )
  // Exactly one allow row (the Bash card) and two refusals.
  expect(html.split('>Run</span>').length - 1).toBe(1)
  expect(html.split(REFUSE_ROW).length - 1).toBe(1)
  expect(html.split('>Deny</span>').length - 1).toBe(1)
})

test('only the keyboard card gets the cursor, and only the head card counts', () => {
  const html = renderToStaticMarkup(
    <PermissionQueue
      items={[queueItem(BASH), queueItem(MALFORMED_ASK)]}
      keyboardTargetRequestId={BASH.requestId}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
    />,
  )
  // The ↵ chip rides the cursor, and only one card has one.
  expect(html.split('>↵<').length - 1).toBe(1)
  // The count is the prototype's per-card header element (`Permissions.jsx:452-456`),
  // not a line above the stack — but it belongs to the ONE head card. Printing
  // "2 pending" beside each of two visible cards is an artefact of stacking.
  expect(html.split('aria-label="2 pending requests"').length - 1).toBe(1)
  expect(html).not.toContain('permission requests pending')
})

test('the header count excludes requests that are already answered', () => {
  // `items` carries submitted requests until `permission.resolved` lands, so
  // counting the raw list said "2 pending" with one of them already decided.
  const html = renderToStaticMarkup(
    <PermissionQueue
      items={[
        queueItem(BASH),
        { ...queueItem(MALFORMED_ASK), submitted: true },
      ]}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
    />,
  )
  // One request still needs an answer, and the count hides itself at 1.
  expect(html).not.toContain('pending')
})

test('the head-card count includes snoozed requests, which are still live', () => {
  // A snoozed request is hidden from the stack but NOT answered: it sits in the
  // lane below and is still pending engine-side, so the header counts it.
  const html = renderToStaticMarkup(
    <PermissionQueue
      items={[
        queueItem(BASH),
        { ...queueItem(MALFORMED_ASK), dismissed: true },
      ]}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
    />,
  )
  expect(html).toContain('aria-label="2 pending requests"')
  expect(html).toContain('Snoozed:')
})

test('Later appears only when the queue offers snooze', () => {
  const withLane = renderToStaticMarkup(
    <PermissionQueue
      items={[queueItem(BASH)]}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
      onSnooze={() => {}}
    />,
  )
  expect(withLane).toContain('>Later<')

  const withoutLane = renderToStaticMarkup(
    <PermissionQueue
      items={[queueItem(BASH)]}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
    />,
  )
  expect(withoutLane).not.toContain('>Later<')
})
