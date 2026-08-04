import { expect, test } from 'bun:test'
import {
  createContextBreakdownState,
  reduceContextBreakdownState,
  selectBreakdownRows,
  selectContextBreakdown,
  selectFreeTokens,
} from './contextBreakdownState.js'
import type {
  ContextBreakdownSnapshot,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

const SID = 'sess-1' as SessionId

const BREAKDOWN: ContextBreakdownSnapshot = {
  categories: [
    { label: 'System prompt', tokens: 4_200, colorKey: 'promptBorder', deferred: false },
    { label: 'System tools', tokens: 8_600, colorKey: 'inactive', deferred: false },
    { label: 'Skills', tokens: 1_200, colorKey: 'warning', deferred: false },
    // Deferred: shown by /context for visibility, but occupies nothing.
    { label: 'MCP tools (deferred)', tokens: 9_000, colorKey: 'inactive', deferred: true },
    // A category the engine may add later, with a key this renderer has no hue for.
    { label: 'Future thing', tokens: 500, colorKey: 'brand-new-key', deferred: false },
    { label: 'Empty bucket', tokens: 0, colorKey: 'claude', deferred: false },
  ],
  usedTokens: 14_500,
  contextWindow: 200_000,
  model: 'gpt-5.6-luna',
}

function frame(breakdown: ContextBreakdownSnapshot): ServerFrame {
  return {
    kind: 'context-breakdown.snapshot',
    protocolVersion: 1,
    sessionId: SID,
    breakdown,
  } as ServerFrame
}

test('a snapshot frame lands under its own session', () => {
  const state = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: frame(BREAKDOWN),
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)
  expect(selectContextBreakdown(state, 'other' as SessionId)).toBeNull()
})

test('a lifecycle reset drops the stale snapshot for a tracked session only', () => {
  let state = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: frame(BREAKDOWN),
  })
  const before = state
  // An untracked session is left alone (no slice created).
  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: { kind: 'lifecycle', sessionId: 'other' } as unknown as ServerFrame,
  })
  expect(state).toBe(before)

  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: { kind: 'lifecycle', sessionId: SID } as unknown as ServerFrame,
  })
  expect(selectContextBreakdown(state, SID)).toBeNull()
})

test('rows drop deferred and zero categories, keeping the engine order', () => {
  const rows = selectBreakdownRows(BREAKDOWN)
  expect(rows.map(r => r.label)).toEqual([
    'System prompt',
    'System tools',
    'Skills',
    'Future thing',
  ])
})

// Tailwind v4: an unknown engine colour key must still paint SOMETHING static —
// a row that silently vanished would under-report the window.
test('an unknown colour key falls back to a static swatch class', () => {
  const rows = selectBreakdownRows(BREAKDOWN)
  const future = rows.find(r => r.label === 'Future thing')
  expect(future?.swatch).toBe('bg-white/25')
  // The prototype's per-category identity hue (data.js:3316), not a status tone.
  expect(rows.find(r => r.label === 'System prompt')?.swatch).toBe('bg-[#a1a1aa]')
  for (const row of rows) {
    expect(row.swatch).not.toContain('${')
  }
})

test('segment widths are a share of the window, not of the used total', () => {
  const rows = selectBreakdownRows(BREAKDOWN)
  const systemPrompt = rows.find(r => r.label === 'System prompt')
  expect(systemPrompt?.percentOfWindow).toBeCloseTo((4_200 / 200_000) * 100, 6)
})

test('free space is the unused window, never negative', () => {
  expect(selectFreeTokens(BREAKDOWN)).toBe(185_500)
  expect(
    selectFreeTokens({ ...BREAKDOWN, usedTokens: 250_000 }),
  ).toBe(0)
  expect(selectFreeTokens(null)).toBeNull()
})

test('no snapshot yields no rows (the popover keeps its aggregate row alone)', () => {
  expect(selectBreakdownRows(null)).toEqual([])
})
