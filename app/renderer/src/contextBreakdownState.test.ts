import { expect, test } from 'bun:test'
import {
  createContextBreakdownState,
  isBreakdownTrustworthy,
  reduceContextBreakdownState,
  selectBreakdownRows,
  selectContextBreakdown,
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
    protocolVersion: 2,
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
  expect(rows.find(r => r.label === 'System prompt')?.swatch).toBe('bg-[light-dark(#52525b,#a1a1aa)]')
  for (const row of rows) {
    expect(row.swatch).not.toContain('${')
  }
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

test('a collapsed analysis renders no rows, rather than a wrong panel', () => {
  expect(isBreakdownTrustworthy(COLLAPSED)).toBe(false)
  expect(selectBreakdownRows(COLLAPSED)).toEqual([])
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
  expect(rows.find(r => r.label === 'System tools')?.swatch).toBe('bg-[light-dark(#2563eb,#60a5fa)]')
  expect(rows.find(r => r.label === 'Compact buffer')?.swatch).toBe('bg-white/25')
})

/* ---------------------------------------------------------------------------
 * Breakdown invalidation rules in reduceContextBreakdownState.
 * ------------------------------------------------------------------------- */

test('transcript.reset drops the cached snapshot for the session', () => {
  let state = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: frame(BREAKDOWN),
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)

  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: { kind: 'transcript.reset', protocolVersion: 2, sessionId: SID } as unknown as ServerFrame,
  })
  expect(selectContextBreakdown(state, SID)).toBeNull()
})

test('turn.status event drops the cached snapshot', () => {
  let state = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: frame(BREAKDOWN),
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)

  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: {
      kind: 'event',
      protocolVersion: 2,
      sessionId: SID,
      event: { type: 'turn.status', status: 'running' },
    } as unknown as ServerFrame,
  })
  expect(selectContextBreakdown(state, SID)).toBeNull()
})

test('main-thread compact_boundary event drops the cached snapshot', () => {
  let state = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: frame(BREAKDOWN),
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)

  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: {
      kind: 'event',
      protocolVersion: 2,
      sessionId: SID,
      event: {
        type: 'message',
        message: {
          type: 'system',
          subtype: 'compact_boundary',
          parent_tool_use_id: null,
        },
      },
    } as unknown as ServerFrame,
  })
  expect(selectContextBreakdown(state, SID)).toBeNull()
})

test('subagent compact_boundary event retains the cached snapshot', () => {
  let state = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: frame(BREAKDOWN),
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)

  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: {
      kind: 'event',
      protocolVersion: 2,
      sessionId: SID,
      event: {
        type: 'message',
        message: {
          type: 'system',
          subtype: 'compact_boundary',
          parent_tool_use_id: 'tool_call_subagent_1',
        },
      },
    } as unknown as ServerFrame,
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)
})

test('run-controls.snapshot model or window change drops the cached snapshot', () => {
  // First, record initial run-controls
  let state = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: {
      kind: 'run-controls.snapshot',
      protocolVersion: 2,
      sessionId: SID,
      runControls: {
        model: { current: 'claude-3-5-sonnet', selected: 'claude-3-5-sonnet', contextWindow: 200_000 },
      },
    } as unknown as ServerFrame,
  })

  // Next, breakdown arrives
  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: frame(BREAKDOWN),
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)

  // Changing model drops snapshot
  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: {
      kind: 'run-controls.snapshot',
      protocolVersion: 2,
      sessionId: SID,
      runControls: {
        model: { current: 'gpt-4o', selected: 'gpt-4o', contextWindow: 128_000 },
      },
    } as unknown as ServerFrame,
  })
  expect(selectContextBreakdown(state, SID)).toBeNull()
})

test('run-controls.snapshot with identical model and window retains the cached snapshot', () => {
  let state = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: {
      kind: 'run-controls.snapshot',
      protocolVersion: 2,
      sessionId: SID,
      runControls: {
        model: { current: 'claude-3-5-sonnet', selected: 'claude-3-5-sonnet', contextWindow: 200_000 },
      },
    } as unknown as ServerFrame,
  })

  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: frame(BREAKDOWN),
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)

  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: {
      kind: 'run-controls.snapshot',
      protocolVersion: 2,
      sessionId: SID,
      runControls: {
        model: { current: 'claude-3-5-sonnet', selected: 'claude-3-5-sonnet', contextWindow: 200_000 },
      },
    } as unknown as ServerFrame,
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)
})

test('permission.context mode change drops the cached snapshot', () => {
  let state = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: {
      kind: 'permission.context',
      protocolVersion: 2,
      sessionId: SID,
      context: { mode: 'ask' },
    } as unknown as ServerFrame,
  })

  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: frame(BREAKDOWN),
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)

  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: {
      kind: 'permission.context',
      protocolVersion: 2,
      sessionId: SID,
      context: { mode: 'auto' },
    } as unknown as ServerFrame,
  })
  expect(selectContextBreakdown(state, SID)).toBeNull()
})

test('permission.context with identical mode retains the cached snapshot', () => {
  let state = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: {
      kind: 'permission.context',
      protocolVersion: 2,
      sessionId: SID,
      context: { mode: 'ask' },
    } as unknown as ServerFrame,
  })

  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: frame(BREAKDOWN),
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)

  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: {
      kind: 'permission.context',
      protocolVersion: 2,
      sessionId: SID,
      context: { mode: 'ask' },
    } as unknown as ServerFrame,
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)
})

test('valid Plan-mode runtime-model differences between breakdown and run-controls are accepted', () => {
  let state = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: {
      kind: 'run-controls.snapshot',
      protocolVersion: 2,
      sessionId: SID,
      runControls: {
        model: { current: 'claude-3-5-haiku', selected: 'claude-3-5-haiku', contextWindow: 200_000 },
      },
    } as unknown as ServerFrame,
  })

  const planBreakdown: ContextBreakdownSnapshot = {
    ...BREAKDOWN,
    model: 'claude-3-5-sonnet',
  }
  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: frame(planBreakdown),
  })

  expect(selectContextBreakdown(state, SID)).toEqual(planBreakdown)
})

test('successful editFromMessage session-action.result drops the cached snapshot', () => {
  let state = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: frame(BREAKDOWN),
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)

  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: {
      kind: 'session-action.result',
      protocolVersion: 2,
      sessionId: SID,
      verb: 'editFromMessage',
      ok: true,
    } as unknown as ServerFrame,
  })
  expect(selectContextBreakdown(state, SID)).toBeNull()
})

test('failed editFromMessage session-action.result retains the cached snapshot', () => {
  let state = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: frame(BREAKDOWN),
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)

  state = reduceContextBreakdownState(state, {
    type: 'frame',
    frame: {
      kind: 'session-action.result',
      protocolVersion: 2,
      sessionId: SID,
      verb: 'editFromMessage',
      ok: false,
    } as unknown as ServerFrame,
  })
  expect(selectContextBreakdown(state, SID)).toEqual(BREAKDOWN)
})
