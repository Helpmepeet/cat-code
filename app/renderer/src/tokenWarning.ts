import type { RunControlsSnapshot } from '../../shared/protocol.js'
import type { ContextUsage } from './contextUsage.js'

/**
 * The composer rail's "approaching auto-compact" state (the prototype's
 * `TokenWarning`, `~/catcode_prototype/cat-app/Surfaces.jsx:415`, rendered in the
 * rail at `:779` between the separator and the context donut).
 *
 * Derived at READ time from two facts already on the wire: the live context
 * usage (`contextUsage.ts`) and the engine-resolved auto-compact thresholds
 * (`RunControlsSnapshot.autoCompact`). Nothing is stored, and the warning
 * clears itself once a turn compacts and `usedTokens` drops back under the
 * warning threshold — it is a live readout, not a notification.
 *
 * SOURCE — this mirrors the engine's `calculateTokenWarningState`
 * (`src/services/compact/autoCompact.ts:246-286`) rather than reimplementing it:
 *
 *  - visible exactly when `tokenUsage >= warningThreshold` (`autoCompact.ts:269`),
 *  - `percentLeft = max(0, round(((threshold - tokenUsage) / threshold) * 100))`
 *    (`autoCompact.ts:261-264`), measured against the COMPACT threshold, so it
 *    reaches 0% where compaction fires rather than where the window ends.
 *
 * Both thresholds arrive from the sidecar because neither is derivable here: the
 * denominator is `getEffectiveContextWindowSize` (`autoCompact.ts:40`), which
 * differs from the gauge's `contextWindow`, and the auto-compact buffer is
 * model-dependent (`getAutoCompactBufferTokens`, `autoCompact.ts:204`) rather
 * than the flat 13k the prototype hard-codes. A null threshold (resolution
 * failed, or no model yet) hides the glyph: silence beats a percentage that
 * disagrees with the engine that actually compacts.
 */
export type TokenWarning = {
  /** 0–100, clamped. Headroom left before auto-compact fires. */
  percentLeft: number
  /**
   * Whether auto-compact will run on its own. Drives WHICH sentence shows: the
   * engine words the two cases differently (`TokenWarning.tsx:166` vs `:169`),
   * because with auto-compact off the user has to run `/compact` themselves.
   */
  autoCompactEnabled: boolean
}

export function selectTokenWarning(
  usage: ContextUsage | null,
  autoCompact: RunControlsSnapshot['autoCompact'] | null | undefined,
): TokenWarning | null {
  if (!usage || !autoCompact) return null
  const { threshold, warningThreshold } = autoCompact
  if (threshold == null || warningThreshold == null) return null
  if (usage.usedTokens < warningThreshold) return null
  return {
    percentLeft: Math.max(
      0,
      Math.min(100, Math.round(((threshold - usage.usedTokens) / threshold) * 100)),
    ),
    autoCompactEnabled: autoCompact.enabled,
  }
}
