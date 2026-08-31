/**
 * Real-DOM proof that a roster click OPENS the dialog on that worker (CC-84).
 *
 * The SSR suite can only render a dialog that is already open, which exercises
 * the state initializers. The shipped app never does that: `TasksDialog` is
 * mounted shut and `open` flips to true later, so the path that actually runs is
 * the `open` EFFECT, and no effect runs under `renderToStaticMarkup`. That
 * transition is the whole fix, so it needs a real DOM.
 *
 * No JSX and no component export, so this file stays `.ts` and out of the Fast
 * Refresh component-boundary rule (`paneStructure.dom.test.ts` idiom).
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createElement } from 'react'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness } from './domTestHarness.js'
import { TasksDialog } from './TasksDialog.js'
import type {
  AgentModeSnapshot,
  AgentModeWorkerItem,
} from '../../shared/protocol.js'

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

const noop = () => {}

function worker(over: Partial<AgentModeWorkerItem> = {}): AgentModeWorkerItem {
  return {
    agentId: 'agent_a',
    handle: '@scout',
    role: 'coding-worker',
    status: 'running',
    description: 'audit the auth path',
    origin: 'current',
    ...over,
  }
}

const agentMode: AgentModeSnapshot = {
  active: true,
  objective: '',
  phase: 'executing',
  workers: [
    worker(),
    worker({
      agentId: 'agent_b',
      handle: '@probe',
      description: 'trace the dropped frame',
    }),
  ],
}

const snapshot = {
  items: [
    {
      id: 'b1',
      type: 'local_bash' as const,
      status: 'running' as const,
      label: 'bun test app/',
      startTime: 1,
    },
  ],
}

function dialog(props: { open: boolean; focusAgentId?: string | null }) {
  return createElement(TasksDialog, {
    agentMode,
    hasActiveSession: true,
    onClose: noop,
    snapshot,
    ...props,
  })
}

test('opening on a named worker lands on that worker, not the task list', async () => {
  // Mounted SHUT, exactly like the shipped App, so the `open` effect is the path
  // under test.
  const tree = await harness.mount(dialog({ open: false }))
  expect(tree.container.textContent).toBe('')

  await tree.render(dialog({ open: true, focusAgentId: 'agent_b' }))

  const text = tree.container.textContent ?? ''
  expect(text).toContain('All workers')
  expect(text).toContain('trace the dropped frame')
  expect(text).not.toContain('bun test app/')
})

test('opening with no named worker still lands on the task list', async () => {
  const tree = await harness.mount(dialog({ open: false }))

  await tree.render(dialog({ open: true }))

  const text = tree.container.textContent ?? ''
  expect(text).toContain('bun test app/')
  expect(text).not.toContain('All workers')
})

// A worker that finished between the click and the open must not render a stale
// row; the roster the click came from is the honest fallback.
test('a named worker missing from the snapshot falls back to the workers list', async () => {
  const tree = await harness.mount(dialog({ open: false }))

  await tree.render(dialog({ open: true, focusAgentId: 'agent_that_finished' }))

  const text = tree.container.textContent ?? ''
  expect(text).not.toContain('All workers')
  expect(text).toContain('audit the auth path')
  expect(text).toContain('trace the dropped frame')
})

// Reopening from ⌘K or the footer pill must not be stuck on the worker the
// previous roster click named.
test('a later open with no worker clears the previous focus', async () => {
  const tree = await harness.mount(dialog({ open: false }))
  await tree.render(dialog({ open: true, focusAgentId: 'agent_b' }))
  expect(tree.container.textContent ?? '').toContain('All workers')

  await tree.render(dialog({ open: false, focusAgentId: null }))
  await tree.render(dialog({ open: true, focusAgentId: null }))

  const text = tree.container.textContent ?? ''
  expect(text).toContain('bun test app/')
  expect(text).not.toContain('All workers')
})
