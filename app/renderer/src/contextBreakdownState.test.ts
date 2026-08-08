import { expect, test } from 'bun:test'
import {
  createContextBreakdownState,
  isBreakdownTrustworthy,
  reduceContextBreakdownState,
  selectBreakdownRows,
  selectContextBreakdown,
  selectDonutView,
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
  freeTokens: 185_500,
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

// `Free` is the engine's own `Free space` category, passed through the wire —
// NOT `contextWindow - usedTokens`, which is a different basis (usedTokens is the
// API fresh-input count when one exists, the segments are estimates).
test('free space is the engine remainder, never negative, null when absent', () => {
  expect(selectFreeTokens(BREAKDOWN)).toBe(185_500)
  // A changed usedTokens must NOT move Free — that was the old subtraction bug.
  // Kept within the trust guard's range: a usedTokens far above what the
  // categories account for is, by definition, a collapsed analysis.
  expect(selectFreeTokens({ ...BREAKDOWN, usedTokens: 20_000 })).toBe(185_500)
  expect(selectFreeTokens({ ...BREAKDOWN, freeTokens: -5 })).toBe(0)
  expect(selectFreeTokens({ ...BREAKDOWN, freeTokens: null })).toBeNull()
  expect(selectFreeTokens(null)).toBeNull()
})

test('no snapshot yields no rows (the popover keeps its aggregate row alone)', () => {
  expect(selectBreakdownRows(null)).toEqual([])
})

/**
 * The shape the engine actually returned on a Codex-only session: every
 * API-counted category dropped, leaving only the locally-counted Skills, while
 * the headline still reported 262k used. Rendering that produced a panel whose
 * three numbers contradicted each other.
 */
const COLLAPSED: ContextBreakdownSnapshot = {
  categories: [
    { label: 'Skills', tokens: 2_600, colorKey: 'warning', deferred: false },
  ],
  usedTokens: 262_000,
  freeTokens: 318_000,
  contextWindow: 372_000,
  model: 'gpt-5.6-terra',
}

test('a collapsed analysis renders no rows and no Free, rather than a wrong panel', () => {
  expect(isBreakdownTrustworthy(COLLAPSED)).toBe(false)
  expect(selectBreakdownRows(COLLAPSED)).toEqual([])
  expect(selectFreeTokens(COLLAPSED)).toBeNull()
})

test('a complete analysis is trusted even when the estimate undershoots the header', () => {
  // A local estimate legitimately disagrees with the API-derived headline (they
  // have different bases: fresh-input vs estimate), so the guard must not fire on
  // a wide but honest gap. It catches near-total collapse only.
  const estimated: ContextBreakdownSnapshot = {
    ...COLLAPSED,
    categories: [
      { label: 'System prompt', tokens: 20_000, colorKey: 'promptBorder', deferred: false },
      { label: 'Messages', tokens: 30_000, colorKey: 'purple_FOR_SUBAGENTS_ONLY', deferred: false },
    ],
  }
  expect(isBreakdownTrustworthy(estimated)).toBe(true)
  expect(selectBreakdownRows(estimated)).toHaveLength(2)
})

test('a fresh session with no usage yet is still shown', () => {
  expect(
    isBreakdownTrustworthy({ ...COLLAPSED, usedTokens: 0 }),
  ).toBe(true)
})

test('an analysis accounting for nothing is never shown', () => {
  expect(
    isBreakdownTrustworthy({ ...COLLAPSED, categories: [] }),
  ).toBe(false)
})

// The engine reuses the `inactive` colour key for both `System tools` and the
// manual `Compact buffer`, so keying on colour alone painted two unrelated legend
// rows and bar segments the same blue.
test('reserved space does not borrow the System tools hue', () => {
  const rows = selectBreakdownRows({
    ...BREAKDOWN,
    categories: [
      { label: 'System tools', tokens: 8_600, colorKey: 'inactive', deferred: false },
      { label: 'Compact buffer', tokens: 3_000, colorKey: 'inactive', deferred: false },
    ],
  })
  expect(rows.find(r => r.label === 'System tools')?.swatch).toBe('bg-[#60a5fa]')
  expect(rows.find(r => r.label === 'Compact buffer')?.swatch).toBe('bg-white/25')
})

/* ---------------------------------------------------------------------------
 * The donut's hover view. This is where the hover BEHAVIOUR is covered: the
 * renderer suite has no DOM, so a mouse event cannot be dispatched, and the
 * component deliberately holds nothing but the two pointer wires.
 * ------------------------------------------------------------------------- */

const CIRCUMFERENCE = 2 * Math.PI * 30

test('at rest every arc is drawn at full opacity and the base stroke', () => {
  const view = selectDonutView(selectBreakdownRows(BREAKDOWN), null)
  expect(view.segments).toHaveLength(4)
  for (const segment of view.segments) {
    expect(segment.opacity).toBe(1)
    expect(segment.strokeWidth).toBe(6)
  }
  // Center shows the aggregate, so the caller keeps its own percent and tone.
  expect(view.centerTokens).toBeNull()
  expect(view.centerClass).toBeNull()
})

// The gap is taken out of each arc's own length and paid back as a half-gap of
// offset, so the notch sits between neighbours instead of shortening the ring.
test('arcs are notched apart without moving where the next one starts', () => {
  const rows = selectBreakdownRows(BREAKDOWN)
  const view = selectDonutView(rows, null)
  const firstArc = (rows[0]!.percentOfWindow / 100) * CIRCUMFERENCE
  expect(view.segments[0]!.dash).toBeCloseTo(firstArc - 3, 6)
  expect(view.segments[0]!.offset).toBeCloseTo(-1.5, 6)
  // The second arc still begins where the first one's FULL share ended.
  expect(view.segments[1]!.offset).toBeCloseTo(-(firstArc + 1.5), 6)
})

// An arc shorter than the gap must not invert into a negative dash, which SVG
// renders as a full ring.
test('a category smaller than the gap collapses to nothing, never to a full ring', () => {
  const view = selectDonutView(
    selectBreakdownRows({
      ...BREAKDOWN,
      categories: [
        { label: 'System prompt', tokens: 14_000, colorKey: 'promptBorder', deferred: false },
        { label: 'Sliver', tokens: 1, colorKey: 'warning', deferred: false },
      ],
    }),
    null,
  )
  expect(view.segments[1]!.dash).toBe(0)
})

test('hovering a category emphasises its arc and dims the others', () => {
  const view = selectDonutView(selectBreakdownRows(BREAKDOWN), 1)
  expect(view.segments[1]!.strokeWidth).toBe(9)
  expect(view.segments[1]!.opacity).toBe(1)
  expect(view.segments[0]!.strokeWidth).toBe(6)
  expect(view.segments[0]!.opacity).toBe(0.3)
  expect(view.segments[2]!.opacity).toBe(0.3)
})

// The center readout is the whole point of the hover: it answers "how much is
// that slice?" without a tooltip, tinted in the slice's own hue.
test('hovering swaps the center readout to that category, in its own colour', () => {
  const view = selectDonutView(selectBreakdownRows(BREAKDOWN), 1)
  expect(view.centerTokens).toBe(8_600)
  expect(view.centerClass).toBe('text-[#60a5fa]')
})

test('an unknown colour key still tints the center readout with something static', () => {
  const view = selectDonutView(selectBreakdownRows(BREAKDOWN), 3)
  expect(view.centerClass).toBe('text-white/25')
  expect(view.centerClass).not.toContain('${')
})

// Ring and legend are ONE target set: the same index drives both, which is what
// makes hovering a legend row light up its arc.
test('the hovered legend row lifts while its siblings recede', () => {
  const view = selectDonutView(selectBreakdownRows(BREAKDOWN), 1)
  expect(view.legend[1]!.rowClass).toBe('bg-white/5')
  expect(view.legend[1]!.labelClass).toBe('text-text-primary')
  expect(view.legend[1]!.valueClass).toBe('text-text-primary')
  expect(view.legend[0]!.rowClass).toBe('bg-transparent')
  expect(view.legend[0]!.labelClass).toBe('text-text-ghost')
  expect(view.legend[0]!.valueClass).toBe('text-text-ghost')
})

test('leaving restores the resting legend, dimming nothing', () => {
  const view = selectDonutView(selectBreakdownRows(BREAKDOWN), null)
  for (const row of view.legend) {
    expect(row.rowClass).toBe('bg-transparent')
    expect(row.labelClass).toBe('text-text-muted')
    expect(row.valueClass).toBe('text-text-subtle')
  }
})

// A snapshot with fewer categories can land while the pointer is inside a row
// that no longer exists. That must read as "nothing hovered", not throw or dim
// the whole ring against a hover target that is gone.
test('a hover index left over from a bigger snapshot reads as no hover', () => {
  const view = selectDonutView(selectBreakdownRows(BREAKDOWN), 9)
  expect(view.centerTokens).toBeNull()
  for (const segment of view.segments) expect(segment.opacity).toBe(1)
})
