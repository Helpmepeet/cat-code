import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TaskSnapshotItem, TasksSnapshot } from '../../shared/protocol.js'
import { TasksDialog } from './TasksDialog.js'

/**
 * This package has no DOM test harness (see AccountsPage.test.tsx's header) —
 * SSR string assertions + the pure `tasksState.ts` logic (covered directly in
 * tasksState.test.ts) is the established convention for this renderer.
 */

function item(over: Partial<TaskSnapshotItem> = {}): TaskSnapshotItem {
  return {
    id: 'b1',
    type: 'local_bash',
    status: 'running',
    label: 'npm test',
    startTime: 1,
    ...over,
  }
}

const noop = () => {}

test('renders nothing when closed', () => {
  const html = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={false} snapshot={null} />,
  )
  expect(html).toBe('')
})

test('renders the empty state, branched on active-session scope', () => {
  const withSession = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={true} snapshot={null} />,
  )
  expect(withSession).toContain('No tasks in this session')

  const withoutSession = renderToStaticMarkup(
    <TasksDialog hasActiveSession={false} onClose={noop} open={true} snapshot={null} />,
  )
  expect(withoutSession).toContain('No background tasks')
})

test('renders active and completed task rows with their labels and kind badge', () => {
  const snapshot: TasksSnapshot = {
    items: [
      item({ id: 'r1', type: 'remote_agent', status: 'running', label: 'Cloud PR review' }),
      item({ id: 'c1', type: 'dream', status: 'completed', label: 'Nightly cleanup' }),
    ],
  }
  const html = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={true} snapshot={snapshot} />,
  )
  expect(html).toContain('Cloud PR review')
  expect(html).toContain('Nightly cleanup')
  expect(html).toContain('Remote')
  expect(html).toContain('Dream')
  expect(html).toContain('1 active')
  expect(html).toContain('1 completed')
})

test('a needs-input local_agent row surfaces the real handoffStatus-derived state label', () => {
  const snapshot: TasksSnapshot = {
    items: [
      item({
        id: 'a1',
        type: 'local_agent',
        status: 'running',
        label: 'Fix the flaky test',
        handoffStatus: 'blocked',
      }),
    ],
  }
  const html = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={true} snapshot={snapshot} />,
  )
  expect(html).toContain('Fix the flaky test')
  expect(html).toContain('Needs you')
})
