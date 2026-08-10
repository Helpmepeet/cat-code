import type { Anthropic } from '@anthropic-ai/sdk'
import type { BetaMessageParam as MessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
// @aws-sdk/client-bedrock-runtime is imported dynamically in countTokensWithBedrock()
// to defer ~279KB of AWS SDK code until a Bedrock call is actually made
import type { CountTokensCommandInput } from '@aws-sdk/client-bedrock-runtime'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { VERTEX_COUNT_TOKENS_ALLOWED_BETAS } from '../constants/betas.js'
import { logForDebugging } from '../utils/debug.js'
import type { Attachment } from '../utils/attachments.js'
import { getModelBetas } from '../utils/betas.js'
import { getVertexRegionForModel, isEnvTruthy } from '../utils/envUtils.js'
import { logError } from '../utils/log.js'
import { normalizeAttachmentForAPI } from '../utils/messages.js'
import {
  createBedrockRuntimeClient,
  getInferenceProfileBackingModel,
  isFoundationModel,
} from '../utils/model/bedrock.js'
import {
  getDefaultSonnetModel,
  getMainLoopModel,
  getSmallFastModel,
  normalizeModelStringForAPI,
} from '../utils/model/model.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isToolReferenceBlock } from '../utils/toolSearch.js'
import { getAPIMetadata, getExtraBodyParams } from './api/claude.js'
import { getAnthropicClient } from './api/client.js'
import { EMPTY_USAGE } from './api/emptyUsage.js'
import { withTokenCountVCR } from './vcr.js'

// Minimal values for token counting with thinking enabled
// API constraint: max_tokens must be greater than thinking.budget_tokens
const TOKEN_COUNT_THINKING_BUDGET = 1024
const TOKEN_COUNT_MAX_TOKENS = 2048

/**
 * Check if messages contain thinking blocks
 */
function hasThinkingBlocks(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): boolean {
  if (getAPIProvider() === 'openai') {
    return false
  }
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          (block.type === 'thinking' || block.type === 'redacted_thinking')
        ) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Strip tool search-specific fields from messages before sending for token counting.
 * This removes 'caller' from tool_use blocks and 'tool_reference' from tool_result content.
 * These fields are only valid with the tool search beta and will cause errors otherwise.
 *
 * Note: We use 'as unknown as' casts because the SDK types don't include tool search beta fields,
 * but at runtime these fields may exist from API responses when tool search was enabled.
 */
function stripToolSearchFieldsFromMessages(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): Anthropic.Beta.Messages.BetaMessageParam[] {
  return messages.map(message => {
    if (!Array.isArray(message.content)) {
      return message
    }

    const normalizedContent = message.content.map(block => {
      // Strip 'caller' from tool_use blocks (assistant messages)
      if (block.type === 'tool_use') {
        // Destructure to exclude any extra fields like 'caller'
        const toolUse =
          block as Anthropic.Beta.Messages.BetaToolUseBlockParam & {
            caller?: unknown
          }
        return {
          type: 'tool_use' as const,
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        }
      }

      // Strip tool_reference blocks from tool_result content (user messages)
      if (block.type === 'tool_result') {
        const toolResult =
          block as Anthropic.Beta.Messages.BetaToolResultBlockParam
        if (Array.isArray(toolResult.content)) {
          const filteredContent = (toolResult.content as unknown[]).filter(
            c => !isToolReferenceBlock(c),
          ) as typeof toolResult.content

          if (filteredContent.length === 0) {
            return {
              ...toolResult,
              content: [{ type: 'text' as const, text: '[tool references]' }],
            }
          }
          if (filteredContent.length !== toolResult.content.length) {
            return {
              ...toolResult,
              content: filteredContent,
            }
          }
        }
      }

      return block
    })

    return {
      ...message,
      content: normalizedContent,
    }
  })
}

export async function countTokensWithAPI(
  content: string,
): Promise<number | null> {
  // Special case for empty content - API doesn't accept empty messages
  if (!content) {
    return 0
  }

  const message: Anthropic.Beta.Messages.BetaMessageParam = {
    role: 'user',
    content: content,
  }

  return countMessagesTokensWithAPI([message], [])
}

export async function countMessagesTokensWithAPI(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  return withTokenCountVCR(messages, tools, async () => {
    try {
      const model = getMainLoopModel()
      const betas = getModelBetas(model)
      const containsThinking = hasThinkingBlocks(messages)

      if (getAPIProvider() === 'bedrock') {
        // @anthropic-sdk/bedrock-sdk doesn't support countTokens currently
        return countTokensWithBedrock({
          model: normalizeModelStringForAPI(model),
          messages,
          tools,
          betas,
          containsThinking,
        })
      }

      const anthropic = await getAnthropicClient({
        maxRetries: 1,
        model,
        source: 'count_tokens',
      })

      const filteredBetas =
        getAPIProvider() === 'vertex'
          ? betas.filter(b => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b))
          : betas

      const response = await anthropic.beta.messages.countTokens({
        model: normalizeModelStringForAPI(model),
        messages:
          // When we pass tools and no messages, we need to pass a dummy message
          // to get an accurate tool token count.
          messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
        tools,
        ...(filteredBetas.length > 0 && { betas: filteredBetas }),
        // Enable thinking if messages contain thinking blocks
        ...(containsThinking && {
          thinking: {
            type: 'enabled',
            budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
          },
        }),
      })

      if (typeof response.input_tokens !== 'number') {
        // Vertex client throws
        // Bedrock client succeeds with { Output: { __type: 'com.amazon.coral.service#UnknownOperationException' }, Version: '1.0' }
        return null
      }

      return response.input_tokens
    } catch (error) {
      logError(error)
      return null
    }
  })
}

export function roughTokenCountEstimation(
  content: string,
  bytesPerToken: number = 4,
): number {
  return Math.round(content.length / bytesPerToken)
}

/**
 * Chars-per-token ratios for the message/block estimators below.
 *
 * Calibrated 2026-08-10 by measuring real payloads with o200k_base as a
 * labeled proxy.  Claude's tokenizer is generally no more byte-efficient on
 * code and JSON, so these are lower bounds on the correction, not upper ones.
 *
 *   English prose            5.07-6.11 chars/token
 *   Russian/Cyrillic prose   4.36-4.45   <- safe at the default 4, no detector
 *   TypeScript source        3.89-4.32
 *   grep output (path:line:) 3.47-4.21
 *   dense JSON               3.07-3.64
 *   JSONL logs               2.86
 *   minified JS              3.05
 *   UUID/hash-rich output    1.64-1.84
 *   base64 (blobs, JWTs)     1.45-1.93
 *   Japanese prose           1.29
 *   Chinese prose            1.37-1.38
 *   Korean prose             1.77
 *
 * The historical flat 4 measured accurate for code and conservative for prose,
 * so it stays the default.  It under-counts structured tool output by 1.15x
 * to 1.4x, which is why tool results carry their own ratio: an underestimate
 * here lets the context fill past the point where auto-compact should have
 * fired.  Lowering the default instead would over-compact prose and code.
 *
 * Cyrillic is the reason the CJK detector below keys on script ranges rather
 * than on "non-ASCII": Russian prose measured 4.36-4.45, i.e. already safe at
 * the default, and treating it as dense would over-count it ~3x.
 */
const PROSE_CHARS_PER_TOKEN = 4

/**
 * Tool results carry the dense structured output (grep hits, JSON, JSONL).
 * 3 covers the measured 2.86-3.47 band conservatively without punishing the
 * prose and code that also arrive as tool results.
 */
const STRUCTURED_CHARS_PER_TOKEN = 3

/** Identifier-saturated output (UUIDs, git SHAs) measured 1.64-1.84. */
const IDENTIFIER_DENSE_CHARS_PER_TOKEN = 2

/**
 * base64 payloads (data URIs, JWTs, `base64` output, embedded file dumps)
 * measured 1.45-1.93 chars/token, so the structured ratio of 3 under-counts
 * them by ~2x.  1.5 sits at the dense end of that band: the worst measured
 * under-count is 1.03x (random-byte base64 at 1.45), while base64 of
 * source-like input at 1.9 is overestimated 1.27x, the safe direction.
 */
const BASE64_CHARS_PER_TOKEN = 1.5

/**
 * Chinese/Japanese/Korean text measured 1.29 (Japanese) to 1.77 (Korean)
 * chars/token, so the prose ratio of 4 under-counts it up to 3.1x — the
 * largest error in this estimator.  1.5 centres the measured band: worst-case
 * under-count 1.18x (a hypothetical 1.27 corpus), worst-case over-count 1.18x
 * (Korean at 1.77).
 */
const CJK_CHARS_PER_TOKEN = 1.5

/**
 * Fraction of hex-digit-or-dash characters above which a tool result is
 * treated as identifier-saturated.
 *
 * Measured over 18,740 real tool_result payloads from local session
 * transcripts: median 0.271, p90 0.342, p99 0.570.  Prose, TypeScript source
 * and grep output all cluster at 0.20-0.25 (English 'a'-'f' plus digits put a
 * floor around 0.25), so the threshold sits well clear of them.  Every
 * observed payload above it was genuinely identifier-saturated: git SHA
 * listings, UUID filename tables, timestamped debug logs.  It fires on ~0.48%
 * of results, and a false positive only costs a slight overestimate.
 */
const IDENTIFIER_DENSITY_THRESHOLD = 0.65

/**
 * Fraction of CJK-script characters above which content is treated as
 * CJK-dominant.
 *
 * Content mixing Chinese with English measures 4.20 chars/token at 10% CJK,
 * 2.88 at 30%, 2.19 at 50% and 1.37 at 100%.  0.30 is where the true ratio
 * (2.88) is close to twice {@link CJK_CHARS_PER_TOKEN}, so a payload that
 * barely fires is overestimated 1.9x (the safe direction) while one that
 * barely misses is underestimated 1.33x — inside the 1.15-1.4x band the flat
 * default already accepts for structured output.  Real CJK prose scores
 * 0.73-0.98, far above it; a TypeScript file with Chinese comments scores
 * 0.13, far below.  Across 89,361 real tool_result payloads the highest score
 * seen anywhere was 0.056, so it never fires on this corpus.
 */
const CJK_DENSITY_THRESHOLD = 0.3

/**
 * base64 signature thresholds, measured against real base64 (random bytes,
 * base64 of text, MIME-wrapped at 76 columns, JWTs, data URIs) and against
 * English prose, TypeScript, grep output, dense JSON, minified JS and hex
 * identifier listings.
 *
 * - alphabet: base64 scores 0.95-1.00; the densest non-base64 control (grep
 *   output) scores 0.88.  This also caps whitespace at 0.05 implicitly.
 * - upper/lower: base64 is ~0.4 each because the encoding is case-mixed.
 *   This is what excludes hex listings (all one case, so one side is 0) and
 *   lowercase file-path listings.
 * - slash: base64 is ~1/64 slashes; path listings are ~0.06-0.10, which is
 *   how those are rejected.
 * - run: base64 has one unbroken alphabet run per line (newlines do not break
 *   it, so 76-column wrapping still passes); path and identifier listings
 *   break every 40-100 chars on a dot or a separator.
 *
 * Fires on 1.07% of 89,361 real tool_result payloads; 20 evenly spaced hits
 * were decoded and every one was genuine base64 (encoded source dumps, source
 * map data URIs, base64url signatures), measuring 1.50-1.93 chars/token.
 */
const BASE64_ALPHABET_THRESHOLD = 0.95
const BASE64_CASE_THRESHOLD = 0.15
const BASE64_SLASH_THRESHOLD = 0.05
const BASE64_RUN_THRESHOLD = 200

/**
 * Bounded sampling window.  Three of these (head, middle, tail) are scored
 * and the highest score wins, so a dense body is still detected behind a
 * prose preamble longer than a single window — the blind spot a single
 * leading sample had.  Content at or below three windows is scored whole.
 */
const DENSITY_WINDOW_CHARS = 2048

/**
 * Highest score `scoreWindow` gives any of the head/middle/tail windows.
 * Deterministic and bounded: it reads at most 3 * {@link
 * DENSITY_WINDOW_CHARS} characters regardless of content length.
 */
function maxWindowScore(
  content: string,
  scoreWindow: (content: string, start: number, end: number) => number,
): number {
  const { length } = content
  if (length === 0) {
    return 0
  }
  if (length <= DENSITY_WINDOW_CHARS * 3) {
    return scoreWindow(content, 0, length)
  }
  const middle = Math.floor((length - DENSITY_WINDOW_CHARS) / 2)
  return Math.max(
    scoreWindow(content, 0, DENSITY_WINDOW_CHARS),
    scoreWindow(content, middle, middle + DENSITY_WINDOW_CHARS),
    scoreWindow(content, length - DENSITY_WINDOW_CHARS, length),
  )
}

/**
 * Number of non-matching characters after which a window can no longer reach
 * `threshold`.  Bailing out then and reporting 0 is safe for every caller
 * here: the score is only ever compared against its own threshold (directly
 * or through {@link maxWindowScore}'s max), and a window that trips this
 * budget was going to score below that threshold anyway.
 */
function missBudget(start: number, end: number, threshold: number): number {
  return (end - start) * (1 - threshold)
}

/** Fraction of hex digits and dashes, the UUID/hash signature. */
function hexDensity(content: string, start: number, end: number): number {
  let identifierChars = 0
  let otherChars = 0
  const budget = missBudget(start, end, IDENTIFIER_DENSITY_THRESHOLD)
  for (let i = start; i < end; i++) {
    const code = content.charCodeAt(i)
    if (
      (code >= 48 && code <= 57) || // 0-9
      (code >= 97 && code <= 102) || // a-f
      (code >= 65 && code <= 70) || // A-F
      code === 45 // -
    ) {
      identifierChars++
    } else {
      otherChars++
      if (otherChars > budget) {
        return 0
      }
    }
  }
  return identifierChars / (end - start)
}

/** True when `content` looks like UUID/hash-dense output. */
function isIdentifierDense(content: string): boolean {
  return maxWindowScore(content, hexDensity) >= IDENTIFIER_DENSITY_THRESHOLD
}

/**
 * Han, kana and Hangul, plus the punctuation and fullwidth forms that appear
 * inline in CJK text.  Deliberately excludes every other non-ASCII script:
 * Cyrillic measured 4.36-4.45 chars/token and must keep the default ratio.
 */
function isCjkCharCode(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0x3000 && code <= 0x303f) || // CJK symbols and punctuation
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ideographs Ext A
    (code >= 0xff00 && code <= 0xff9f) || // Fullwidth forms + halfwidth kana
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x2eff) || // CJK radicals
    (code >= 0x3100 && code <= 0x312f) || // Bopomofo
    (code >= 0xd840 && code <= 0xd87f) || // Ext B-F lead surrogates
    (code >= 0xf900 && code <= 0xfaff) // CJK compatibility ideographs
  )
}

/** Fraction of CJK-script characters. */
function cjkDensity(content: string, start: number, end: number): number {
  let cjkChars = 0
  let otherChars = 0
  const budget = missBudget(start, end, CJK_DENSITY_THRESHOLD)
  for (let i = start; i < end; i++) {
    if (isCjkCharCode(content.charCodeAt(i))) {
      cjkChars++
    } else {
      otherChars++
      if (otherChars > budget) {
        return 0
      }
    }
  }
  return cjkChars / (end - start)
}

/** True when `content` is CJK-dominant. */
function isCjkDense(content: string): boolean {
  return maxWindowScore(content, cjkDensity) >= CJK_DENSITY_THRESHOLD
}

/**
 * 1 when the window matches every base64 criterion, 0 otherwise.  Scored as a
 * number so it can share {@link maxWindowScore} with the density detectors.
 */
function base64Score(content: string, start: number, end: number): number {
  let alphabetChars = 0
  let upperChars = 0
  let lowerChars = 0
  let slashChars = 0
  let run = 0
  let longestRun = 0
  let nonAlphabetChars = 0
  // Once this many non-alphabet characters have been seen the window can no
  // longer reach BASE64_ALPHABET_THRESHOLD, so the rest of it cannot change
  // the answer.  Prose, source and JSON hit it within the first few dozen
  // characters, which is what keeps this detector off the hot path.
  const nonAlphabetBudget = missBudget(start, end, BASE64_ALPHABET_THRESHOLD)
  for (let i = start; i < end; i++) {
    const code = content.charCodeAt(i)
    const isUpper = code >= 65 && code <= 90
    const isLower = code >= 97 && code <= 122
    const isBase64Char =
      isUpper ||
      isLower ||
      (code >= 48 && code <= 57) || // 0-9
      code === 43 || // +
      code === 47 || // /
      code === 61 || // =
      code === 45 || // - (base64url)
      code === 95 || // _ (base64url)
      code === 46 // . (JWT segment separator)
    if (isUpper) upperChars++
    if (isLower) lowerChars++
    if (code === 47) slashChars++
    if (isBase64Char) {
      alphabetChars++
    } else {
      nonAlphabetChars++
      if (nonAlphabetChars > nonAlphabetBudget) {
        return 0
      }
    }
    if (code === 10 || code === 13) {
      // Line wrapping does not break a run: `base64` wraps at 76 columns.
    } else if (isBase64Char && code !== 46) {
      run++
      if (run > longestRun) longestRun = run
    } else {
      run = 0
    }
  }
  const length = end - start
  const matches =
    alphabetChars / length >= BASE64_ALPHABET_THRESHOLD &&
    upperChars / length >= BASE64_CASE_THRESHOLD &&
    lowerChars / length >= BASE64_CASE_THRESHOLD &&
    slashChars / length <= BASE64_SLASH_THRESHOLD &&
    longestRun >= BASE64_RUN_THRESHOLD
  return matches ? 1 : 0
}

/** True when `content` is a base64 blob (data URI, JWT, encoded dump). */
function isBase64Blob(content: string): boolean {
  return maxWindowScore(content, base64Score) === 1
}

/**
 * Ratio for text-shaped payloads: `fallback` unless the text is CJK-dominant,
 * which beats every other ratio here because CJK is the densest content this
 * estimator sees.
 */
function charsPerTokenForText(text: string, fallback: number): number {
  return isCjkDense(text) ? CJK_CHARS_PER_TOKEN : fallback
}

/**
 * Ratio for a tool_result's string content.  Array content does not come
 * here: it recurses at the flat structured ratio, where each nested text
 * block is still CJK-checked on its own.
 */
function charsPerTokenForToolResult(content: string): number {
  if (isCjkDense(content)) {
    return CJK_CHARS_PER_TOKEN
  }
  if (isBase64Blob(content)) {
    return BASE64_CHARS_PER_TOKEN
  }
  if (isIdentifierDense(content)) {
    return IDENTIFIER_DENSE_CHARS_PER_TOKEN
  }
  return STRUCTURED_CHARS_PER_TOKEN
}

/**
 * Returns an estimated bytes-per-token ratio for a given file extension.
 * Dense JSON has many single-character tokens (`{`, `}`, `:`, `,`, `"`)
 * which makes the real ratio closer to 2 rather than the default 4.
 */
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}

/**
 * Like {@link roughTokenCountEstimation} but uses a more accurate
 * bytes-per-token ratio when the file type is known.
 *
 * This matters when the API-based token count is unavailable (e.g. on
 * Bedrock) and we fall back to the rough estimate — an underestimate can
 * let an oversized tool result slip into the conversation.
 */
export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(
    content,
    bytesPerTokenForFileType(fileExtension),
  )
}

/**
 * Estimates token count for a Message object by extracting and analyzing its text content.
 * This provides a more reliable estimate than getTokenUsage for messages that may have been compacted.
 * Uses Haiku for token counting (Haiku 4.5 supports thinking blocks), except:
 * - Vertex global region: uses Sonnet (Haiku not available)
 * - Bedrock with thinking blocks: uses Sonnet (Haiku 3.5 doesn't support thinking)
 */
export async function countTokensViaHaikuFallback(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  // Check if messages contain thinking blocks
  const containsThinking = hasThinkingBlocks(messages)

  // If we're on Vertex and using global region, always use Sonnet since Haiku is not available there.
  const isVertexGlobalEndpoint =
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) &&
    getVertexRegionForModel(getSmallFastModel()) === 'global'
  // If we're on Bedrock with thinking blocks, use Sonnet since Haiku 3.5 doesn't support thinking
  const isBedrockWithThinking =
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) && containsThinking
  // If we're on Vertex with thinking blocks, use Sonnet since Haiku 3.5 doesn't support thinking
  const isVertexWithThinking =
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) && containsThinking
  // Otherwise always use Haiku - Haiku 4.5 supports thinking blocks.
  // WARNING: if you change this to use a non-Haiku model, this request will fail in 1P unless it uses getCLISyspromptPrefix.
  // Note: We don't need Sonnet for tool_reference blocks because we strip them via
  // stripToolSearchFieldsFromMessages() before sending.
  // Use getSmallFastModel() to respect ANTHROPIC_SMALL_FAST_MODEL env var for Bedrock users
  // with global inference profiles (see issue #10883).
  const model =
    isVertexGlobalEndpoint || isBedrockWithThinking || isVertexWithThinking
      ? getDefaultSonnetModel()
      : getSmallFastModel()
  const anthropic = await getAnthropicClient({
    maxRetries: 1,
    model,
    source: 'count_tokens',
  })

  // Strip tool search-specific fields (caller, tool_reference) before sending
  // These fields are only valid with the tool search beta header
  const normalizedMessages = stripToolSearchFieldsFromMessages(messages)

  const messagesToSend: MessageParam[] =
    normalizedMessages.length > 0
      ? (normalizedMessages as MessageParam[])
      : [{ role: 'user', content: 'count' }]

  const betas = getModelBetas(model)
  // Filter betas for Vertex - some betas (like web-search) cause 400 errors
  // on certain Vertex endpoints. See issue #10789.
  const filteredBetas =
    getAPIProvider() === 'vertex'
      ? betas.filter(b => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b))
      : betas

  // biome-ignore lint/plugin: token counting needs specialized parameters (thinking, betas) that sideQuery doesn't support
  const response = await anthropic.beta.messages.create({
    model: normalizeModelStringForAPI(model),
    max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
    messages: messagesToSend,
    tools: tools.length > 0 ? tools : undefined,
    ...(filteredBetas.length > 0 && { betas: filteredBetas }),
    metadata: getAPIMetadata(),
    ...getExtraBodyParams(),
    // Enable thinking if messages contain thinking blocks
    ...(containsThinking && {
      thinking: {
        type: 'enabled',
        budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
      },
    }),
  })

  const usage = response.usage ?? EMPTY_USAGE
  if (!response.usage) {
    logForDebugging(
      `[token-estimation] missing_usage model=${normalizeModelStringForAPI(model)}`,
      { level: 'warn' },
    )
  }
  const inputTokens = usage.input_tokens
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0
  const cacheReadTokens = usage.cache_read_input_tokens || 0

  return inputTokens + cacheCreationTokens + cacheReadTokens
}

export function roughTokenCountEstimationForMessages(
  messages: readonly {
    type: string
    message?: { content?: unknown }
    attachment?: Attachment
  }[],
): number {
  let totalTokens = 0
  for (const message of messages) {
    totalTokens += roughTokenCountEstimationForMessage(message)
  }
  return totalTokens
}

export function roughTokenCountEstimationForMessage(message: {
  type: string
  message?: { content?: unknown }
  attachment?: Attachment
}): number {
  if (
    (message.type === 'assistant' || message.type === 'user') &&
    message.message?.content
  ) {
    return roughTokenCountEstimationForContent(
      message.message?.content as
        | string
        | Array<Anthropic.ContentBlock>
        | Array<Anthropic.ContentBlockParam>
        | undefined,
    )
  }

  if (message.type === 'attachment' && message.attachment) {
    const userMessages = normalizeAttachmentForAPI(message.attachment)
    let total = 0
    for (const userMsg of userMessages) {
      total += roughTokenCountEstimationForContent(userMsg.message.content)
    }
    return total
  }

  return 0
}

/**
 * @param charsPerToken ratio for the prose-like payloads in this content.
 *   Defaults to {@link PROSE_CHARS_PER_TOKEN}; tool_result recursion passes
 *   {@link STRUCTURED_CHARS_PER_TOKEN} so that text blocks nested inside a
 *   tool_result are counted as the structured output they are, not as prose.
 */
export function roughTokenCountEstimationForContent(
  content:
    | string
    | Array<Anthropic.ContentBlock>
    | Array<Anthropic.ContentBlockParam>
    | undefined,
  charsPerToken: number = PROSE_CHARS_PER_TOKEN,
): number {
  if (!content) {
    return 0
  }
  if (typeof content === 'string') {
    return roughTokenCountEstimation(
      content,
      charsPerTokenForText(content, charsPerToken),
    )
  }
  let totalTokens = 0
  for (const block of content) {
    totalTokens += roughTokenCountEstimationForBlock(block, charsPerToken)
  }
  return totalTokens
}

function roughTokenCountEstimationForBlock(
  block: string | Anthropic.ContentBlock | Anthropic.ContentBlockParam,
  charsPerToken: number = PROSE_CHARS_PER_TOKEN,
): number {
  if (typeof block === 'string') {
    return roughTokenCountEstimation(
      block,
      charsPerTokenForText(block, charsPerToken),
    )
  }
  if (block.type === 'text') {
    return roughTokenCountEstimation(
      block.text,
      charsPerTokenForText(block.text, charsPerToken),
    )
  }
  if (block.type === 'image' || block.type === 'document') {
    // https://platform.claude.com/docs/en/build-with-claude/vision#calculate-image-costs
    // tokens = (width px * height px)/750
    // Images are resized to max 2000x2000 (5333 tokens). Use a conservative
    // estimate that matches microCompact's IMAGE_MAX_TOKEN_SIZE to avoid
    // underestimating and triggering auto-compact too late.
    //
    // document: base64 PDF in source.data.  Must NOT reach the
    // jsonStringify catch-all — a 1MB PDF is ~1.33M base64 chars →
    // ~325k estimated tokens, vs the ~2000 the API actually charges.
    // Same constant as microCompact's calculateToolResultTokens.
    return 2000
  }
  if (block.type === 'tool_result') {
    // Structured output: measured 2.9-3.5 chars/token, vs the 4.2+ of the
    // prose and code elsewhere in a message.  String content additionally
    // escalates when it is CJK, base64 or identifier-saturated.  For array
    // content the structured ratio is threaded into the recursion instead, so
    // text blocks nested in a tool_result get it too.
    const { content } = block
    if (typeof content === 'string') {
      return roughTokenCountEstimation(
        content,
        charsPerTokenForToolResult(content),
      )
    }
    return roughTokenCountEstimationForContent(
      content,
      STRUCTURED_CHARS_PER_TOKEN,
    )
  }
  if (block.type === 'tool_use') {
    // input is the JSON the model generated — arbitrarily large (bash
    // commands, Edit diffs, file contents).  Stringify once for the
    // char count; the API re-serializes anyway so this is what it sees.
    // Measured 4.2-4.4 chars/token: these are code and prose arguments, so
    // they keep the default ratio rather than the tool_result one.  A Write
    // or Edit carrying CJK file content is the exception and escalates.
    const serialized = block.name + jsonStringify(block.input ?? {})
    return roughTokenCountEstimation(
      serialized,
      charsPerTokenForText(serialized, PROSE_CHARS_PER_TOKEN),
    )
  }
  if (block.type === 'thinking') {
    return roughTokenCountEstimation(block.thinking, PROSE_CHARS_PER_TOKEN)
  }
  if (block.type === 'redacted_thinking') {
    return roughTokenCountEstimation(block.data, PROSE_CHARS_PER_TOKEN)
  }
  // server_tool_use, web_search_tool_result, mcp_tool_use, etc. —
  // text-like payloads (tool inputs, search results, no base64).
  // Stringify-length tracks the serialized form the API sees; the
  // key/bracket overhead is single-digit percent on real blocks.
  // Serialized JSON measured ~3.07 chars/token, so these take the structured
  // ratio rather than the prose default.
  return roughTokenCountEstimation(
    jsonStringify(block),
    STRUCTURED_CHARS_PER_TOKEN,
  )
}

async function countTokensWithBedrock({
  model,
  messages,
  tools,
  betas,
  containsThinking,
}: {
  model: string
  messages: Anthropic.Beta.Messages.BetaMessageParam[]
  tools: Anthropic.Beta.Messages.BetaToolUnion[]
  betas: string[]
  containsThinking: boolean
}): Promise<number | null> {
  try {
    const client = await createBedrockRuntimeClient()
    // Bedrock CountTokens requires a model ID, not an inference profile / ARN
    const modelId = isFoundationModel(model)
      ? model
      : await getInferenceProfileBackingModel(model)
    if (!modelId) {
      return null
    }

    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      // When we pass tools and no messages, we need to pass a dummy message
      // to get an accurate tool token count.
      messages:
        messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
      max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
      ...(tools.length > 0 && { tools }),
      ...(betas.length > 0 && { anthropic_beta: betas }),
      ...(containsThinking && {
        thinking: {
          type: 'enabled',
          budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
        },
      }),
    }

    const { CountTokensCommand } = await import(
      '@aws-sdk/client-bedrock-runtime'
    )
    const input: CountTokensCommandInput = {
      modelId,
      input: {
        invokeModel: {
          body: new TextEncoder().encode(jsonStringify(requestBody)),
        },
      },
    }
    const response = await client.send(new CountTokensCommand(input))
    const tokenCount = response.inputTokens ?? null
    return tokenCount
  } catch (error) {
    logError(error)
    return null
  }
}
