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

test('an ordinary request keeps both controls', () => {
  const html = renderToStaticMarkup(
    <PermissionQueue
      items={[queueItem(BASH)]}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
    />,
  )
  expect(html).toContain('>Allow<')
  expect(html).toContain('>Deny<')
})

test('an unreadable AskUserQuestion card cannot be allowed by mouse either', () => {
  // The keyboard path already refuses these (`selectVisiblePermission` excludes
  // AskUserQuestion), but the card's own Allow button used to send
  // `{behavior:'allow', updatedInput:{}}`, running the tool with NO answers.
  // Mouse and keyboard must agree.
  const html = renderToStaticMarkup(
    <PermissionQueue
      items={[queueItem(MALFORMED_ASK)]}
      onAllow={() => {}}
      onDeny={() => {}}
      onRestore={() => {}}
    />,
  )
  expect(html).not.toContain('>Allow<')
  expect(html).toContain('>Deny<')
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
  // Exactly one Allow (the Bash card) and two Deny buttons.
  expect(html.split('>Allow<').length - 1).toBe(1)
  expect(html.split('>Deny<').length - 1).toBe(2)
})
