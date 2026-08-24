/**
 * Read tool output limits.  Three caps apply to text reads:
 *
 *   | limit             | default | checks                    | cost          | on overflow     |
 *   |-------------------|---------|---------------------------|---------------|-----------------|
 *   | MAX_LINES_TO_READ | 2000    | lines selected            | none          | marks partial   |
 *   | maxSizeBytes      | 256 KB  | TOTAL FILE SIZE (not out) | 1 stat        | throws pre-read |
 *   | maxTokens         | 25000   | actual output tokens      | API roundtrip | throws post-read|
 *
 * The line cap applies only when the caller passes no explicit limit, and it
 * relieves maxTokens only.  It cannot relieve maxSizeBytes, which gates on
 * total file size rather than on the selected slice (see the mismatch note
 * below), so a default read of a 300 KB file still throws pre-read.
 * maxSizeBytes likewise applies only to no-limit reads, so an explicit range
 * still reads a file of any size.
 *
 * Known mismatch: maxSizeBytes gates on total file size, not the slice.
 * Tested truncating instead of throwing for explicit-limit reads that
 * exceed the byte cap (#21841, Mar 2026).  Reverted: tool error rate
 * dropped but mean tokens rose — the throw path yields a ~100-byte error
 * tool-result while truncation yields ~25K tokens of content at the cap.
 */
import memoize from 'lodash-es/memoize.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { MAX_OUTPUT_SIZE } from 'src/utils/file.js'
export const DEFAULT_MAX_OUTPUT_TOKENS = 25000

// Prefer a compact prefix on overflow, leaving room in the model context for
// the surrounding request. DEFAULT_MAX_OUTPUT_TOKENS remains the hard ceiling.
export const DEFAULT_PREFIX_TARGET_TOKENS = 8000

/**
 * Env var override for max output tokens. Returns undefined when unset/invalid
 * so the caller can fall through to the next precedence tier.
 */
function getEnvMaxTokens(): number | undefined {
  const override = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS
  if (override) {
    const parsed = parseInt(override, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return undefined
}

export type FileReadingLimits = {
  maxTokens: number
  maxSizeBytes: number
  includeMaxSizeInPrompt?: boolean
  targetedRangeNudge?: boolean
}

/**
 * Default limits for Read tool when the ToolUseContext doesn't supply an
 * override. Memoized so the GrowthBook value is fixed at first call — avoids
 * the cap changing mid-session as the flag refreshes in the background.
 *
 * Precedence for the requested maxTokens: env var > GrowthBook >
 * DEFAULT_MAX_OUTPUT_TOKENS. FileReadTool treats DEFAULT_MAX_OUTPUT_TOKENS as
 * the absolute ceiling, so these overrides can lower the live limit but cannot
 * raise it.
 *
 * Defensive: each field is individually validated; invalid values fall
 * through to the hardcoded defaults (no route to cap=0).
 */
export const getDefaultFileReadingLimits = memoize((): FileReadingLimits => {
  const override =
    getFeatureValue_CACHED_MAY_BE_STALE<Partial<FileReadingLimits> | null>(
      'tengu_amber_wren',
      {},
    )

  const maxSizeBytes =
    typeof override?.maxSizeBytes === 'number' &&
    Number.isFinite(override.maxSizeBytes) &&
    override.maxSizeBytes > 0
      ? override.maxSizeBytes
      : MAX_OUTPUT_SIZE

  const envMaxTokens = getEnvMaxTokens()
  const maxTokens =
    envMaxTokens ??
    (typeof override?.maxTokens === 'number' &&
    Number.isFinite(override.maxTokens) &&
    override.maxTokens > 0
      ? override.maxTokens
      : DEFAULT_MAX_OUTPUT_TOKENS)

  const includeMaxSizeInPrompt =
    typeof override?.includeMaxSizeInPrompt === 'boolean'
      ? override.includeMaxSizeInPrompt
      : undefined

  // Defaults true: GrowthBook is inert in this fork (is1PEventLoggingEnabled
  // returns false, so getFeatureValue always yields the default), and the
  // upstream flag resolved this arm to true. Without it the prompt tells the
  // model to read whole files, which is what trips maxTokens.
  const targetedRangeNudge =
    typeof override?.targetedRangeNudge === 'boolean'
      ? override.targetedRangeNudge
      : true

  return {
    maxSizeBytes,
    maxTokens,
    includeMaxSizeInPrompt,
    targetedRangeNudge,
  }
})
