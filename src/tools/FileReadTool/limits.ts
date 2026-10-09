/**
 * Read tool output limits.  Three caps apply to text reads:
 *
 *   | limit             | default | checks                    | cost          | on overflow     |
 *   |-------------------|---------|---------------------------|---------------|-----------------|
 *   | MAX_LINES_TO_READ | 2000    | lines selected            | none          | marks partial   |
 *   | maxSizeBytes      | 256 KB  | TOTAL FILE SIZE (not out) | 1 stat        | throws pre-read |
 *   | text tokens       | context | rendered output tokens    | API if needed | trims text      |
 *
 * The line cap applies only when the caller passes no explicit limit, and it
 * relieves maxTokens only.  It cannot relieve maxSizeBytes, which gates on
 * total file size rather than on the selected slice (see the mismatch note
 * below), so a default read of a 300 KB file still throws pre-read.
 * maxSizeBytes likewise applies only to no-limit reads, so an explicit range
 * still reads a file of any size. getTextReadBudget owns the finite text token
 * ceiling; non-text formats retain DEFAULT_MAX_OUTPUT_TOKENS.
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
import {
  DEFAULT_TEXT_READ_MAX_OUTPUT_TOKENS,
  resolveReadMaxTokensOverride,
} from './textReadBudget.js'
export const DEFAULT_MAX_OUTPUT_TOKENS = DEFAULT_TEXT_READ_MAX_OUTPUT_TOKENS

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
 * DEFAULT_MAX_OUTPUT_TOKENS. Non-text reads retain this default. Text reads use
 * getTextReadBudget with the effective model context; maxTokensOverride
 * distinguishes an explicit configured limit from the legacy default.
 *
 * Defensive: each field is individually validated; invalid values fall
 * through to the hardcoded defaults (no route to cap=0).
 */
export const getDefaultFileReadingLimits = memoize((): FileReadingLimits & {
  maxTokensOverride?: number
} => {
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

  const maxTokensOverride = resolveReadMaxTokensOverride(
    process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS,
    override?.maxTokens,
  )
  const maxTokens = maxTokensOverride ?? DEFAULT_MAX_OUTPUT_TOKENS

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
    ...(maxTokensOverride !== undefined ? { maxTokensOverride } : {}),
    includeMaxSizeInPrompt,
    targetedRangeNudge,
  }
})
