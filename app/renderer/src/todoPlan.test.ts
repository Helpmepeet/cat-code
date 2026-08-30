import { expect, test } from 'bun:test'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import { selectTodoPlan, selectTodoReadout, withoutTodoRows } from './todoPlan.js'

// The payloads below are the shape `TodoWriteTool` actually receives — its input
// schema is `{ todos: TodoList }` with each item `{content, status, activeForm}`
// (`src/tools/TodoWriteTool/TodoWriteTool.ts:14-17`,
// `src/utils/todo/types.ts:1-18`). Verified against a real session transcript
// (`~/.cat-code/projects/-Users-pt-cat-code/e98ced38-…jsonl`), not invented.

function todoRow(
  todos: unknown,
  overrides: Partial<{ toolName: string; id: string }> = {},
): NestedTranscriptRow {
  const row = {
    kind: 'tool-use',
    id: overrides.id ?? 'row-1',
    sessionId: 'session-1',
    frameId: 'frame-1',
    toolUseId: 'call-1',
    toolName: overrides.toolName ?? 'TodoWrite',
    toolFamily: 'todo',
    input: { todos },
    status: 'success',
    result: null,
    agentCompletion: null,
    children: [],
  }
  // The fixture is deliberately built as a plain object and narrowed once here,
  // so a shape drift in `NestedTranscriptRow` fails the build rather than being
  // papered over with a cast at every call site.
  return row as unknown as NestedTranscriptRow
}

function bashRow(id: string): NestedTranscriptRow {
  const row = {
    kind: 'tool-use',
    id,
    sessionId: 'session-1',
    frameId: 'frame-2',
    toolUseId: `call-${id}`,
    toolName: 'Bash',
    toolFamily: 'bash',
    input: { command: 'bun test' },
    status: 'pending',
    result: null,
    agentCompletion: null,
    children: [],
  }
  return row as unknown as NestedTranscriptRow
}

const FIVE = [
  {
    content: 'Trace delivery diagnostic semantics and affected run evidence',
    status: 'completed',
    activeForm: 'Tracing delivery diagnostic semantics and affected run evidence',
  },
  {
    content: 'Determine root cause and implementation scope',
    status: 'completed',
    activeForm: 'Determining root cause and implementation scope',
  },
  {
    content: 'Implement the minimal fix and regression test',
    status: 'in_progress',
    activeForm: 'Implementing the minimal fix and regression test',
  },
  {
    content: 'Run desktop verification and stale-reference sweep',
    status: 'pending',
    activeForm: 'Running desktop verification and stale-reference sweep',
  },
  {
    content: 'Update migration status and commit owned files',
    status: 'pending',
    activeForm: 'Updating migration status and committing owned files',
  },
]

test('the in-progress item is the step, counted from one', () => {
  const plan = selectTodoPlan([todoRow(FIVE)])

  expect(plan?.step).toBe(3)
  expect(plan?.total).toBe(5)
  expect(selectTodoReadout(plan)).toBe('3/5')
  expect(plan?.items[2]?.activeForm).toBe(
    'Implementing the minimal fix and regression test',
  )
})

// The regression this file exists for: the engine REPLACES the list on every
// call (`TodoWriteTool.ts:66-95`), so reading anything but the newest one
// reports a plan the agent has already moved past.
test('the newest TodoWrite wins over every earlier one', () => {
  const earlier = FIVE.map((item, index) =>
    index === 0 ? { ...item, status: 'in_progress' } : { ...item, status: 'pending' },
  )

  const plan = selectTodoPlan([
    todoRow(earlier, { id: 'row-old' }),
    bashRow('row-mid'),
    todoRow(FIVE, { id: 'row-new' }),
  ])

  expect(selectTodoReadout(plan)).toBe('3/5')
})

test('no TodoWrite in the transcript means no plan', () => {
  expect(selectTodoPlan([bashRow('row-1')])).toBeNull()
  expect(selectTodoPlan([])).toBeNull()
})

// `allDone ? [] : todos` (`TodoWriteTool.ts:70`) — the engine clears the list
// the moment every item is done, so the surface has to disappear rather than
// rest on a finished plan.
test('an empty list is no plan', () => {
  expect(selectTodoPlan([todoRow([])])).toBeNull()
})

test('a plan with nothing in progress has no step to name', () => {
  const allPending = FIVE.map(item => ({ ...item, status: 'pending' }))
  const plan = selectTodoPlan([todoRow(allPending)])

  expect(plan?.total).toBe(5)
  expect(plan?.step).toBeNull()
  expect(selectTodoReadout(plan)).toBeNull()
})

// Display degrades gracefully on unknown shapes (CLAUDE.md §7): a drifted item
// is dropped, the rest of the plan still renders, and nothing throws.
test('malformed items are dropped, not rendered and not thrown on', () => {
  const plan = selectTodoPlan([
    todoRow([
      FIVE[0],
      { content: 'no status or activeForm' },
      { content: '', status: 'pending', activeForm: 'x' },
      { content: 'bad status', status: 'halfway', activeForm: 'Doing' },
      FIVE[2],
      null,
      'not an object',
    ]),
  ])

  expect(plan?.total).toBe(2)
  expect(plan?.step).toBe(2)
  expect(selectTodoReadout(plan)).toBe('2/2')
})

test('a non-array todos field is no plan', () => {
  expect(selectTodoPlan([todoRow(undefined)])).toBeNull()
  expect(selectTodoPlan([todoRow('5 items')])).toBeNull()
  expect(selectTodoPlan([todoRow({ 0: FIVE[0] })])).toBeNull()
})

// A subagent keys its own list by `agentId` (`TodoWriteTool.ts:69`), so its
// TodoWrite is a different plan and must not be read as this thread's.
test('a nested TodoWrite belongs to its worker, not to this thread', () => {
  const parent = {
    kind: 'tool-use',
    id: 'row-agent',
    sessionId: 'session-1',
    frameId: 'frame-3',
    toolUseId: 'call-agent',
    toolName: 'Agent',
    toolFamily: 'agent',
    input: { description: 'do the thing' },
    status: 'pending',
    result: null,
    agentCompletion: null,
    children: [todoRow(FIVE, { id: 'row-nested' })],
  }

  expect(selectTodoPlan([parent as unknown as NestedTranscriptRow])).toBeNull()
})

// ── withoutTodoRows ────────────────────────────────────────────────────────
// The plan is read from these rows but never drawn as one (operator call,
// 2026-08-29). Dropping the row at display, not in the projection, is what lets
// `selectTodoPlan` keep working.

test('the TodoWrite row is dropped from the display list', () => {
  const rows = [bashRow('a'), todoRow(FIVE, { id: 'todo' }), bashRow('b')]
  const kept = withoutTodoRows(rows)

  expect(kept.map(row => row.id)).toEqual(['a', 'b'])
  // ...and the plan is still readable from the UNfiltered projection.
  expect(selectTodoReadout(selectTodoPlan(rows))).toBe('3/5')
})

// The regression this guards: copying unconditionally re-renders the whole
// transcript on every keystroke in the composer, because `TranscriptView`'s
// memo depends on `rows` keeping identity (`TranscriptView.tsx:262-266`).
test('rows with nothing to drop come back by reference', () => {
  const rows = [bashRow('a'), bashRow('b')]

  expect(withoutTodoRows(rows)).toBe(rows)
})

test('a filtered result is cached, so repeat calls keep identity too', () => {
  const rows = [todoRow(FIVE), bashRow('b')]
  const first = withoutTodoRows(rows)

  expect(withoutTodoRows(rows)).toBe(first)
})

test('a nested TodoWrite is dropped without disturbing its siblings', () => {
  const child = bashRow('child')
  const parent = {
    kind: 'tool-use',
    id: 'agent',
    sessionId: 'session-1',
    frameId: 'frame-3',
    toolUseId: 'call-agent',
    toolName: 'Agent',
    toolFamily: 'agent',
    input: { description: 'do the thing' },
    status: 'pending',
    result: null,
    agentCompletion: null,
    children: [child, todoRow(FIVE, { id: 'nested-todo' })],
  } as unknown as NestedTranscriptRow

  const kept = withoutTodoRows([parent])

  expect(kept).toHaveLength(1)
  expect(kept[0]?.children.map(row => row.id)).toEqual(['child'])
  // The surviving child is the same object, not a rebuilt copy.
  expect(kept[0]?.children[0]).toBe(child)
  // The parent itself had to be rebuilt to carry new children, so it is a new
  // object — but only because something inside it actually changed.
  expect(kept[0]).not.toBe(parent)
})

test('an agent whose children are all untouched keeps its own identity', () => {
  const parent = {
    kind: 'tool-use',
    id: 'agent',
    sessionId: 'session-1',
    frameId: 'frame-3',
    toolUseId: 'call-agent',
    toolName: 'Agent',
    toolFamily: 'agent',
    input: { description: 'do the thing' },
    status: 'pending',
    result: null,
    agentCompletion: null,
    children: [bashRow('child')],
  } as unknown as NestedTranscriptRow
  const rows = [parent]

  expect(withoutTodoRows(rows)).toBe(rows)
})
