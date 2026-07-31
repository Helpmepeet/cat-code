import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TaskSnapshotItem, TasksSnapshot } from '../../shared/protocol.js'
import { TasksDialog } from './TasksDialog.js'
import { tasksDialogKeyAction } from './tasksState.js'

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

test('emits the modal focus container attributes', () => {
  const html = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={true} snapshot={null} />,
  )
  expect(html).toContain('role="dialog"')
  expect(html).toContain('aria-modal="true"')
  expect(html).toContain('tabindex="-1"')
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

test('P4-8b — the "K stop" footer hint appears ONLY when a stop handler is wired (no dead affordance)', () => {
  const snapshot: TasksSnapshot = {
    items: [item({ id: 'a1', type: 'local_agent', status: 'running', label: 'Wire the auth flow' })],
  }
  const withStop = renderToStaticMarkup(
    <TasksDialog
      hasActiveSession={true}
      onClose={noop}
      open={true}
      snapshot={snapshot}
      onStopTask={noop}
    />,
  )
  expect(withStop).toContain('stop')
  // ↑↓ select and esc close are always present; K stop only with a handler.
  const withoutStop = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={true} snapshot={snapshot} />,
  )
  expect(withoutStop).toContain('select')
  expect(withoutStop).toContain('close')
  expect(withoutStop).not.toContain('stop')
})

/**
 * The dialog's keyboard contract. The component reads it through
 * `tasksDialogKeyAction`, which lives in `tasksState.ts` because a `.tsx` may
 * only export components (`lint:fast-refresh`); the dialog's own window listener
 * is installed in an effect, and this suite renders with `renderToStaticMarkup`,
 * which never runs effects.
 */
test('⌘K reaches the command palette instead of stopping the selected task', () => {
  // The bug: `event.key` is still 'k' while Meta is held, so opening the palette
  // from the dialog ALSO killed the first running task, with no confirmation.
  expect(tasksDialogKeyAction({ key: 'k', metaKey: true })).toBeNull()
  expect(tasksDialogKeyAction({ key: 'K', metaKey: true })).toBeNull()
  expect(tasksDialogKeyAction({ key: 'k', ctrlKey: true })).toBeNull()
  expect(tasksDialogKeyAction({ key: 'k', altKey: true })).toBeNull()
  // Chorded navigation/dismissal is the app's too (⌥↑/⌥↓ reorder workspaces).
  expect(tasksDialogKeyAction({ key: 'Escape', metaKey: true })).toBeNull()
  expect(tasksDialogKeyAction({ key: 'ArrowDown', altKey: true })).toBeNull()
  expect(tasksDialogKeyAction({ key: 'ArrowUp', ctrlKey: true })).toBeNull()
  // Unchorded keys still do exactly what the footer advertises.
  expect(tasksDialogKeyAction({ key: 'k' })).toBe('stop')
  expect(tasksDialogKeyAction({ key: 'K' })).toBe('stop')
  expect(tasksDialogKeyAction({ key: 'Escape' })).toBe('close')
  expect(tasksDialogKeyAction({ key: 'ArrowDown' })).toBe('next')
  expect(tasksDialogKeyAction({ key: 'ArrowUp' })).toBe('previous')
  expect(tasksDialogKeyAction({ key: 'x' })).toBeNull()
})
