import { expect, test } from 'bun:test'
import {
  DEFAULT_REASONING_LAYOUT,
  groupReasoningRuns,
  isHeadingLike,
  isReasoningLayoutMode,
  readReasoningLayoutFromStorage,
  reasoningStepsForRow,
  REASONING_HEADING_MAX_CHARS,
  REASONING_LAYOUT_STORAGE_KEY,
  toDisplayItems,
  writeReasoningLayoutToStorage,
  type ReasoningLayoutItem,
  type ReasoningRunMember,
  type ReasoningStepModel,
} from './reasoningLayout.js'
import type {
  NestedToolUseRow,
  NestedTranscriptRow,
} from './transcriptProjector.js'

function memoryStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    store,
  }
}

const blockSource = {
  sessionId: 's' as const,
  messageId: 'm',
  frameId: 'f',
  blockIndex: 0,
  parentToolUseId: null,
  children: [] as NestedTranscriptRow[],
}

function thinking(id: string, content = 'Checking the teardown path'): ReasoningRunMember {
  return { ...blockSource, id, kind: 'thinking', content }
}

function redacted(id: string): ReasoningRunMember {
  return { ...blockSource, id, kind: 'redacted-thinking', data: 'ENCRYPTED' }
}

function toolRow(id: string): NestedToolUseRow {
  return {
    ...blockSource,
    id,
    kind: 'tool-use',
    toolUseId: id,
    toolName: 'Read',
    toolFamily: 'read',
    input: {},
    status: 'success',
    result: null,
    children: [],
  }
}

test('the shipped default is the trail mode', () => {
  expect(DEFAULT_REASONING_LAYOUT).toBe('trail')
})

test('mode round-trips through storage', () => {
  const storage = memoryStorage()
  writeReasoningLayoutToStorage(storage, 'blocks')
  expect(readReasoningLayoutFromStorage(storage)).toBe('blocks')
  writeReasoningLayoutToStorage(storage, 'trail')
  expect(readReasoningLayoutFromStorage(storage)).toBe('trail')
})

test('an absent, foreign, or wrong-version value reads as null (caller falls back to the default)', () => {
  expect(readReasoningLayoutFromStorage(memoryStorage())).toBeNull()
  expect(readReasoningLayoutFromStorage(null)).toBeNull()
  expect(
    readReasoningLayoutFromStorage(
      memoryStorage({ [REASONING_LAYOUT_STORAGE_KEY]: 'not json' }),
    ),
  ).toBeNull()
  expect(
    readReasoningLayoutFromStorage(
      memoryStorage({
        [REASONING_LAYOUT_STORAGE_KEY]: JSON.stringify({ version: 2, mode: 'trail' }),
      }),
    ),
  ).toBeNull()
  expect(
    readReasoningLayoutFromStorage(
      memoryStorage({
        [REASONING_LAYOUT_STORAGE_KEY]: JSON.stringify({ version: 1, mode: 'neon' }),
      }),
    ),
  ).toBeNull()
})

test('a throwing storage never propagates (view persistence is best-effort)', () => {
  const hostile = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
    removeItem: () => {
      throw new Error('denied')
    },
  }
  expect(readReasoningLayoutFromStorage(hostile)).toBeNull()
  expect(() => writeReasoningLayoutToStorage(hostile, 'trail')).not.toThrow()
})

test('isReasoningLayoutMode is a closed check', () => {
  expect(isReasoningLayoutMode('trail')).toBe(true)
  expect(isReasoningLayoutMode('blocks')).toBe(true)
  expect(isReasoningLayoutMode('summary')).toBe(false)
  expect(isReasoningLayoutMode(null)).toBe(false)
})

function stepsOf(item: ReasoningLayoutItem | undefined): ReasoningStepModel[] {
  return item && item.kind === 'reasoning-run' ? item.steps : []
}

test('2+ adjacent reasoning rows coalesce into one run, keyed on the first member', () => {
  const rows = [thinking('a', 'One'), thinking('b', 'Two'), thinking('c', 'Three')]
  const grouped = groupReasoningRuns(toDisplayItems(rows))

  expect(grouped).toHaveLength(1)
  expect(grouped[0]).toMatchObject({ kind: 'reasoning-run', id: 'reasoning-run:a' })
  expect(stepsOf(grouped[0]).map(step => step.kind === 'heading' && step.text)).toEqual([
    'One',
    'Two',
    'Three',
  ])
})

test('a lone reasoning row is still a run — the view decides one step draws as one line', () => {
  const grouped = groupReasoningRuns(toDisplayItems([thinking('a', 'Only')]))
  expect(grouped).toHaveLength(1)
  expect(stepsOf(grouped[0])).toEqual([{ key: 'a:0', kind: 'heading', text: 'Only' }])
})

test('readable and encrypted-only rows group together when adjacent', () => {
  const grouped = groupReasoningRuns(toDisplayItems([thinking('a'), redacted('b')]))
  expect(grouped).toHaveLength(1)
  expect(stepsOf(grouped[0]).map(step => step.kind)).toEqual(['heading', 'withheld'])
})

// ── step derivation: the wire shapes (see the module doc) ───────────────────

test('the adapter\'s "\\n\\n"-merged summary parts become one step each', () => {
  // codex-fetch-adapter.ts:2018-2031 merges every summary PART of one reasoning
  // item into a single thinking block joined by a blank line.
  const row = thinking('a', 'Locating the teardown path\n\nChecking close-frame ordering')

  expect(reasoningStepsForRow(row)).toEqual([
    { key: 'a:0', kind: 'heading', text: 'Locating the teardown path' },
    { key: 'a:1', kind: 'heading', text: 'Checking close-frame ordering' },
  ])
})

test('a blank body is withheld, never an empty heading (the encrypted-only shape)', () => {
  // codex-fetch-adapter.ts:2229 sends encrypted-only reasoning as an EMPTY
  // thinking block carrying the signature.
  expect(reasoningStepsForRow(thinking('a', ''))).toEqual([
    { key: 'a:withheld', kind: 'withheld' },
  ])
  expect(reasoningStepsForRow(thinking('a', '   \n  '))).toEqual([
    { key: 'a:withheld', kind: 'withheld' },
  ])
  expect(reasoningStepsForRow(redacted('b'))).toEqual([
    { key: 'b:withheld', kind: 'withheld' },
  ])
})

test('a provider-stated raw trace is prose, however short', () => {
  const row: ReasoningRunMember = {
    ...blockSource,
    id: 'a',
    kind: 'thinking',
    content: 'Short raw trace.',
    reasoningKind: 'raw',
  }
  expect(reasoningStepsForRow(row)).toEqual([
    { key: 'a:0', kind: 'prose', text: 'Short raw trace.' },
  ])
})

test('a body is only split into headings when EVERY part is heading-length', () => {
  const long = 'x'.repeat(REASONING_HEADING_MAX_CHARS + 1)
  const row = thinking('a', `A short heading\n\n${long}`)

  expect(reasoningStepsForRow(row)).toEqual([
    { key: 'a:0', kind: 'prose', text: `A short heading\n\n${long}` },
  ])
})

test('the heading-length boundary is inclusive', () => {
  const atCap = 'x'.repeat(REASONING_HEADING_MAX_CHARS)
  expect(isHeadingLike(atCap)).toBe(true)
  expect(isHeadingLike(`${atCap}x`)).toBe(false)
  expect(isHeadingLike('one\ntwo')).toBe(false)
  expect(isHeadingLike('   ')).toBe(false)
})

test('grouping an empty list yields an empty list', () => {
  expect(groupReasoningRuns([])).toEqual([])
})

test('any row between two summaries starts a new run', () => {
  const rows = [thinking('a'), thinking('b'), toolRow('t'), thinking('c'), thinking('d')]
  const grouped = groupReasoningRuns(toDisplayItems(rows))

  expect(grouped.map(item => item.kind)).toEqual([
    'reasoning-run',
    'single',
    'reasoning-run',
  ])
})

test('an agent-group item passes through and breaks a run', () => {
  const members = [toolRow('x'), toolRow('y')]
  const grouped = groupReasoningRuns([
    { kind: 'single', row: thinking('a') },
    { kind: 'agent-group', id: 'agent-group:k', groupKey: 'k', members },
    { kind: 'single', row: thinking('b') },
  ])

  expect(grouped.map(item => item.kind)).toEqual([
    'reasoning-run',
    'agent-group',
    'reasoning-run',
  ])
  // Passed through BY REFERENCE, so the DelegateGroup keeps its identity.
  expect(grouped[1]).toMatchObject({ id: 'agent-group:k', members })
})

test('grouping never drops or reorders content', () => {
  const rows = [thinking('a', 'A'), redacted('b'), toolRow('t'), thinking('c', 'C')]
  const grouped = groupReasoningRuns(toDisplayItems(rows))
  const flattened = grouped.flatMap(item =>
    item.kind === 'reasoning-run'
      ? item.steps.map(step => step.key)
      : item.kind === 'single'
        ? [item.row.id]
        : item.members.map(member => member.id),
  )

  expect(flattened).toEqual(['a:0', 'b:withheld', 't', 'c:0'])
})
