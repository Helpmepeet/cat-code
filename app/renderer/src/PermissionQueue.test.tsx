import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
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
const REFUSE_ROW = 'No, and tell Cat Code what to do differently'

test('an ordinary request keeps both rows', () => {
  const html = renderToStaticMarkup(
    <PermissionQueue
      items={[queueItem(BASH)]}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
    />,
  )
  expect(html).toContain(ALLOW_ROW)
  expect(html).toContain(REFUSE_ROW)
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
  expect(html.split(ALLOW_ROW).length - 1).toBe(1)
  expect(html.split(REFUSE_ROW).length - 1).toBe(2)
})

test('only the keyboard card gets the cursor, and every card gets the count', () => {
  const html = renderToStaticMarkup(
    <PermissionQueue
      cursor={0}
      items={[queueItem(BASH), queueItem(MALFORMED_ASK)]}
      keyboardTargetRequestId={BASH.requestId}
      onAllow={() => {}}
      onCursorChange={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
    />,
  )
  // The ↵ chip rides the cursor, and only one card has one.
  expect(html.split('>↵<').length - 1).toBe(1)
  // The prototype puts the pending count in each card's own header row
  // (`Permissions.jsx:452-456`), not in a line above the stack.
  expect(html.split('pending').length - 1).toBe(2)
  expect(html).not.toContain('permission requests pending')
})

test('the Keep pending lane appears only when the queue offers it', () => {
  const withLane = renderToStaticMarkup(
    <PermissionQueue
      items={[queueItem(BASH)]}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
      onSnooze={() => {}}
    />,
  )
  expect(withLane).toContain('Keep pending')

  const withoutLane = renderToStaticMarkup(
    <PermissionQueue
      items={[queueItem(BASH)]}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
    />,
  )
  expect(withoutLane).not.toContain('Keep pending')
})
