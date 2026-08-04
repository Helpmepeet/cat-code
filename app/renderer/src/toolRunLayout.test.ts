import { expect, test } from 'bun:test'
import {
  groupToolRuns,
  toolRunFamily,
  TOOL_RUN_MIN_MEMBERS,
  type TranscriptLayoutItem,
} from './toolRunLayout.js'
import type {
  NestedTranscriptRow,
  ToolFamily,
} from './transcriptProjector.js'

const blockSource = {
  sessionId: 's' as const,
  messageId: 'm',
  frameId: 'f',
  blockIndex: 0,
  parentToolUseId: null,
  children: [] as NestedTranscriptRow[],
}

const TOOL_NAME: Partial<Record<ToolFamily, string>> = {
  read: 'Read',
  grep: 'Grep',
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
}

function toolRow(
  id: string,
  toolFamily: ToolFamily,
  over: Partial<NestedTranscriptRow> = {},
): NestedTranscriptRow {
  return {
    ...blockSource,
    id,
    kind: 'tool-use',
    toolUseId: `toolu_${id}`,
    toolName: TOOL_NAME[toolFamily] ?? 'Tool',
    toolFamily,
    agentCompletion: null,
    input: { file_path: `/repo/${id}.ts`, pattern: id },
    status: 'success',
    result: null,
    children: [],
    ...over,
  } as NestedTranscriptRow
}

function textRow(id: string): NestedTranscriptRow {
  return {
    ...blockSource,
    id,
    kind: 'assistant-text',
    content: 'hello',
  } as NestedTranscriptRow
}

function single(row: NestedTranscriptRow): TranscriptLayoutItem {
  return { kind: 'single', row }
}

function kinds(items: readonly TranscriptLayoutItem[]): string[] {
  return items.map(item =>
    item.kind === 'single'
      ? item.row.kind
      : item.kind === 'tool-run'
        ? `tool-run:${item.family}`
        : item.kind,
  )
}

test('folds adjacent reads into one run at the position of the first member', () => {
  const grouped = groupToolRuns([
    single(toolRow('a', 'read')),
    single(toolRow('b', 'read')),
    single(toolRow('c', 'read')),
  ])

  expect(kinds(grouped)).toEqual(['tool-run:read'])
  const run = grouped[0]
  if (run?.kind !== 'tool-run') throw new Error('expected a tool run')
  expect(run.id).toBe('read-run:a')
  expect(run.members.map(member => member.id)).toEqual(['a', 'b', 'c'])
})

test('folds adjacent searches the same way, under their own family', () => {
  const grouped = groupToolRuns([
    single(toolRow('p1', 'grep')),
    single(toolRow('p2', 'grep')),
  ])

  expect(kinds(grouped)).toEqual(['tool-run:grep'])
  const run = grouped[0]
  if (run?.kind !== 'tool-run') throw new Error('expected a tool run')
  expect(run.id).toBe('grep-run:p1')
})

test('a run changes family instead of merging two kinds under one head', () => {
  // The engine puts reads and searches in ONE accumulator; the prototype has a
  // separate card per kind, and so does this.
  const grouped = groupToolRuns([
    single(toolRow('a', 'read')),
    single(toolRow('b', 'read')),
    single(toolRow('p1', 'grep')),
    single(toolRow('p2', 'grep')),
  ])

  expect(kinds(grouped)).toEqual(['tool-run:read', 'tool-run:grep'])
})

test('a single member of the other family does not join, and does not group alone', () => {
  const grouped = groupToolRuns([
    single(toolRow('a', 'read')),
    single(toolRow('b', 'read')),
    single(toolRow('p1', 'grep')),
  ])

  expect(kinds(grouped)).toEqual(['tool-run:read', 'tool-use'])
})

test('a lone call keeps its own card', () => {
  const items = [single(toolRow('a', 'read'))]

  const grouped = groupToolRuns(items)

  expect(kinds(grouped)).toEqual(['tool-use'])
  // Nothing grouped, so the input array itself comes back — the identity the
  // upstream derivations cached must survive this pass.
  expect(grouped).toBe(items)
})

test('TOOL_RUN_MIN_MEMBERS is the threshold, not an off-by-one', () => {
  const under = groupToolRuns(
    Array.from({ length: TOOL_RUN_MIN_MEMBERS - 1 }, (_, i) =>
      single(toolRow(`u${i}`, 'read')),
    ),
  )
  const at = groupToolRuns(
    Array.from({ length: TOOL_RUN_MIN_MEMBERS }, (_, i) =>
      single(toolRow(`a${i}`, 'read')),
    ),
  )

  expect(kinds(under)).not.toContain('tool-run:read')
  expect(kinds(at)).toEqual(['tool-run:read'])
})

test('a non-groupable tool breaks the run, exactly like the engine collapse rule', () => {
  const grouped = groupToolRuns([
    single(toolRow('a', 'read')),
    single(toolRow('b', 'read')),
    single(toolRow('cmd', 'bash')),
    single(toolRow('c', 'read')),
    single(toolRow('d', 'read')),
  ])

  expect(kinds(grouped)).toEqual(['tool-run:read', 'tool-use', 'tool-run:read'])
})

test('edit and write never group — the engine breaks its groups on them', () => {
  expect(toolRunFamily(toolRow('e', 'edit'))).toBeNull()
  expect(toolRunFamily(toolRow('w', 'write'))).toBeNull()
  expect(
    kinds(groupToolRuns([single(toolRow('e1', 'edit')), single(toolRow('e2', 'edit'))])),
  ).toEqual(['tool-use', 'tool-use'])
})

test('assistant text breaks the run', () => {
  const grouped = groupToolRuns([
    single(toolRow('a', 'read')),
    single(toolRow('b', 'read')),
    single(textRow('t')),
    single(toolRow('c', 'read')),
    single(toolRow('d', 'read')),
  ])

  expect(kinds(grouped)).toEqual([
    'tool-run:read',
    'assistant-text',
    'tool-run:read',
  ])
})

test('a call carrying children never groups — the run body has nowhere to put them', () => {
  const withChild = toolRow('a', 'read', {
    children: [toolRow('child', 'bash')],
  } as Partial<NestedTranscriptRow>)

  expect(toolRunFamily(withChild)).toBeNull()
  expect(
    kinds(groupToolRuns([single(withChild), single(toolRow('b', 'read'))])),
  ).toEqual(['tool-use', 'tool-use'])
})

test('non-single items pass through by reference and break a run', () => {
  const agentGroup = {
    kind: 'agent-group',
    id: 'agent-group:x',
    members: [],
  } as unknown as TranscriptLayoutItem
  const grouped = groupToolRuns([
    single(toolRow('a', 'read')),
    single(toolRow('b', 'read')),
    agentGroup,
    single(toolRow('c', 'read')),
    single(toolRow('d', 'read')),
  ])

  expect(kinds(grouped)).toEqual([
    'tool-run:read',
    'agent-group',
    'tool-run:read',
  ])
  expect(grouped[1]).toBe(agentGroup)
})

test('the same input array yields the identical output (WeakMap cache)', () => {
  const items = [single(toolRow('a', 'read')), single(toolRow('b', 'read'))]

  expect(groupToolRuns(items)).toBe(groupToolRuns(items))
})

test('a trailing run is flushed', () => {
  const grouped = groupToolRuns([
    single(toolRow('cmd', 'bash')),
    single(toolRow('a', 'read')),
    single(toolRow('b', 'read')),
  ])

  expect(kinds(grouped)).toEqual(['tool-use', 'tool-run:read'])
})
