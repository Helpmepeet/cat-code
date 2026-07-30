import { expect, test } from 'bun:test'
import { selectTokenWarning } from './tokenWarning.js'
import type { ContextUsage } from './contextUsage.js'

/**
 * P4-33 — the composer's auto-compact warning derivation.
 *
 * Both thresholds arrive from the sidecar, so these are ILLUSTRATIVE values
 * picked for readable arithmetic, not a claim about any particular model. What
 * they pin is the RELATIONSHIP the engine defines
 * (`src/services/compact/autoCompact.ts:246-286`): the warning threshold sits
 * `WARNING_THRESHOLD_BUFFER_TOKENS` (20k) below the threshold, the comparison is
 * `>=`, and `percentLeft` runs against the threshold rather than the window.
 *
 * Deliberately NOT derived here from a window: the real buffer is model-dependent
 * (`getAutoCompactBufferTokens`, `autoCompact.ts:204` — 17,400 for a 200k model
 * with the output-token cap off, 18,360 with it on, never the flat 13k the
 * prototype hard-codes), which is the whole reason the numbers ship from the
 * engine instead of being recomputed in the renderer.
 */
const THRESHOLD = 187_000
const WARNING_THRESHOLD = 167_000

function usage(usedTokens: number): ContextUsage {
  return {
    usedTokens,
    contextWindow: 200_000,
    percentUsed: Math.round((usedTokens / 200_000) * 100),
  }
}

function autoCompact(over: { enabled?: boolean } = {}) {
  return {
    enabled: over.enabled ?? true,
    threshold: THRESHOLD,
    warningThreshold: WARNING_THRESHOLD,
  }
}

test('renders nothing below the warning threshold', () => {
  expect(selectTokenWarning(usage(WARNING_THRESHOLD - 1), autoCompact())).toBeNull()
  expect(selectTokenWarning(usage(0), autoCompact())).toBeNull()
})

test('appears exactly AT the warning threshold, matching the engine >= gate', () => {
  // `isAboveWarningThreshold = tokenUsage >= warningThreshold` (autoCompact.ts:269).
  // An exclusive comparison here would hide the glyph for a whole turn.
  expect(selectTokenWarning(usage(WARNING_THRESHOLD), autoCompact())).not.toBeNull()
})

test('percentLeft is measured against the COMPACT threshold, not the raw window', () => {
  // At the warning threshold, 20k of the 187k threshold remains → 11%. Measured
  // against the 200k window it would read 17%, and would never reach 0%.
  expect(selectTokenWarning(usage(WARNING_THRESHOLD), autoCompact())?.percentLeft).toBe(11)
})

test('percentLeft hits 0 at the compact point and clamps past it', () => {
  expect(selectTokenWarning(usage(THRESHOLD), autoCompact())?.percentLeft).toBe(0)
  // Past the threshold the engine clamps at 0 rather than going negative
  // (`Math.max(0, …)`, autoCompact.ts:261).
  expect(selectTokenWarning(usage(THRESHOLD + 50_000), autoCompact())?.percentLeft).toBe(0)
})

test('carries the auto-compact setting through, since it picks the wording', () => {
  expect(
    selectTokenWarning(usage(THRESHOLD), autoCompact({ enabled: false }))?.autoCompactEnabled,
  ).toBe(false)
  expect(
    selectTokenWarning(usage(THRESHOLD), autoCompact({ enabled: true }))?.autoCompactEnabled,
  ).toBe(true)
})

test('stays hidden when the engine could not resolve its thresholds', () => {
  // Null thresholds mean the sidecar's resolve failed or no model is known yet.
  // Silence is the honest state: we cannot say how close compaction is.
  const unresolved = { enabled: true, threshold: null, warningThreshold: null }
  expect(selectTokenWarning(usage(999_999), unresolved)).toBeNull()
})

test('stays hidden with no usage or no snapshot at all', () => {
  expect(selectTokenWarning(null, autoCompact())).toBeNull()
  expect(selectTokenWarning(usage(THRESHOLD), null)).toBeNull()
  expect(selectTokenWarning(usage(THRESHOLD), undefined)).toBeNull()
})

test('clears itself once a turn compacts the context back down', () => {
  // The glyph is a live readout, not a notification: the same selector that
  // showed it returns null again after compaction drops usedTokens.
  expect(selectTokenWarning(usage(THRESHOLD), autoCompact())).not.toBeNull()
  expect(selectTokenWarning(usage(40_000), autoCompact())).toBeNull()
})
