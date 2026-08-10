import type { Anthropic } from '@anthropic-ai/sdk'
import { describe, expect, test } from 'bun:test'
import { jsonStringify } from '../utils/slowOperations.js'
import {
  roughTokenCountEstimationForContent,
  roughTokenCountEstimationForMessages,
} from './tokenEstimation.js'

/**
 * Shape-aware chars/token ratios (2026-08-10 calibration audit, o200k_base
 * proxy).  These tests pin which block shapes get which ratio; they are the
 * regression guard against a future edit collapsing them back to a flat 4.
 */

/** Grep-style output: no identifier density, exercises the structured ratio. */
const STRUCTURED_SEED =
  'src/services/compact/autoCompact.ts:42:  const threshold = getThreshold(model)\n'

/** UUID list: hex-and-dash saturated, trips the identifier escalator. */
const IDENTIFIER_SEED = '9f2c1b04-7a3e-4d51-b8c6-0e5a2f7d9134\n'

/** Chinese prose: measured 1.37-1.38 chars/token, density 0.98. */
const CJK_SEED =
  '令牌估算器根据内容形态选择每令牌字符数，中日韩文本的信息密度远高于拉丁文本，必须单独处理。'

/**
 * Cyrillic control: measured 4.36 chars/token, i.e. already safe at the
 * default.  It is the reason the detector keys on script ranges rather than
 * on "non-ASCII".
 */
const CYRILLIC_SEED =
  'Точность подсчёта токенов напрямую влияет на стратегию управления контекстным окном. '

/**
 * base64: alphabet-saturated, case-mixed, one unbroken run.  Built from a
 * fixed seed so the test is deterministic.
 */
const BASE64_TEXT_SEED =
  'Zm9vYmFyQmF6UXV4MDEyMzQ1Njc4OUFiQ2REZUZnSGlKa0xtTm9QcVJzVHVWd1h5WjA5ODc2NTQzMjEr'

/** Builds a string of exactly `length` chars so expectations stay explicit. */
function padded(seed: string, length: number): string {
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length)
}

const LEN = 1200
const STRUCTURED_TEXT = padded(STRUCTURED_SEED, LEN)
const IDENTIFIER_TEXT = padded(IDENTIFIER_SEED, LEN)
const CJK_TEXT = padded(CJK_SEED, LEN)
const CYRILLIC_TEXT = padded(CYRILLIC_SEED, LEN)
const BASE64_TEXT = padded(BASE64_TEXT_SEED, LEN)

/**
 * Source with Chinese comments: ~0.11 CJK, uniformly spread so every sampling
 * window sees the same density.  Measured 3.06 chars/token, close enough to
 * the default that escalating it would over-count ~2x.
 */
const CJK_COMMENTED_CODE = padded(
  `${STRUCTURED_SEED.trimEnd()} // 采样窗口\n`,
  LEN,
)

function toolResult(
  content: Anthropic.ToolResultBlockParam['content'],
): Anthropic.ContentBlockParam {
  return { type: 'tool_result', tool_use_id: 'toolu_01', content }
}

describe('roughTokenCountEstimationForContent ratios', () => {
  test('text block stays at 4 chars/token', () => {
    expect(
      roughTokenCountEstimationForContent([
        { type: 'text', text: STRUCTURED_TEXT },
      ]),
    ).toBe(LEN / 4)
  })

  test('tool_result string content uses 3 chars/token', () => {
    expect(
      roughTokenCountEstimationForContent([toolResult(STRUCTURED_TEXT)]),
    ).toBe(LEN / 3)
  })

  test('text nested in a tool_result array gets the tool_result ratio, not the prose ratio', () => {
    // The discriminating case: the identical string counted as a top-level
    // text block is 300, but as tool output it is 400.
    expect(
      roughTokenCountEstimationForContent([
        toolResult([{ type: 'text', text: STRUCTURED_TEXT }]),
      ]),
    ).toBe(LEN / 3)
  })

  test('identifier-dense tool_result string escalates to 2 chars/token', () => {
    expect(
      roughTokenCountEstimationForContent([toolResult(IDENTIFIER_TEXT)]),
    ).toBe(LEN / 2)
  })

  test('a tool_result string below the density threshold is not escalated', () => {
    // Grep output measures ~0.23 hex-and-dash density against a 0.65
    // threshold, so ordinary code and prose output must stay at 3.
    expect(
      roughTokenCountEstimationForContent([toolResult(STRUCTURED_TEXT)]),
    ).not.toBe(LEN / 2)
  })

  test('a dense head escalates the whole result, prose tail included', () => {
    // Documented tradeoff: the head window is one of three, and any window
    // matching escalates, so a result that opens with ids is treated as
    // identifier-dense even when a prose tail follows.
    const headDense = padded(IDENTIFIER_SEED, 4096) + padded(STRUCTURED_SEED, 4096)
    expect(roughTokenCountEstimationForContent([toolResult(headDense)])).toBe(
      Math.round(headDense.length / 2),
    )
  })

  test('a prose header longer than one window no longer hides the dense body', () => {
    // The regression this replaces: with a single leading sample, 5.3KB of
    // prose in front of 47KB of hashes scored as prose and the result was
    // counted at 3 instead of 2.  The middle and tail windows now see it.
    const headProse =
      padded(STRUCTURED_SEED, 5300) + padded(IDENTIFIER_SEED, 47000)
    expect(roughTokenCountEstimationForContent([toolResult(headProse)])).toBe(
      Math.round(headProse.length / 2),
    )
  })

  test('a dense body in the tail alone is enough to escalate', () => {
    const tailDense =
      padded(STRUCTURED_SEED, 20000) + padded(BASE64_TEXT_SEED, 20000)
    expect(roughTokenCountEstimationForContent([toolResult(tailDense)])).toBe(
      Math.round(tailDense.length / 1.5),
    )
  })

  test('sampling stays bounded: a dense region between the windows is missed', () => {
    // The cost of bounded sampling, pinned so it is a decision and not a
    // surprise: 2KB of ids wedged between the head and middle windows is not
    // seen, and the result stays at the structured ratio.
    const hidden =
      padded(STRUCTURED_SEED, 3000) +
      padded(IDENTIFIER_SEED, 2000) +
      padded(STRUCTURED_SEED, 9000)
    expect(roughTokenCountEstimationForContent([toolResult(hidden)])).toBe(
      Math.round(hidden.length / 3),
    )
  })

  test('the escalator applies to string content only, not to array items', () => {
    // Array-shaped tool results recurse at the flat structured ratio.
    expect(
      roughTokenCountEstimationForContent([
        toolResult([{ type: 'text', text: IDENTIFIER_TEXT }]),
      ]),
    ).toBe(LEN / 3)
  })

  test('tool_use input stays at 4 chars/token', () => {
    const block: Anthropic.ContentBlockParam = {
      type: 'tool_use',
      id: 'toolu_02',
      name: 'Bash',
      input: { command: STRUCTURED_TEXT },
    }
    expect(roughTokenCountEstimationForContent([block])).toBe(
      Math.round(('Bash' + jsonStringify(block.input)).length / 4),
    )
  })

  test('thinking blocks stay at 4 chars/token', () => {
    expect(
      roughTokenCountEstimationForContent([
        { type: 'thinking', thinking: STRUCTURED_TEXT, signature: 'sig' },
      ]),
    ).toBe(LEN / 4)
  })

  test('the server-tool catch-all uses 3 chars/token', () => {
    const block = {
      type: 'server_tool_use',
      id: 'srvtoolu_01',
      name: 'web_search',
      input: { query: STRUCTURED_TEXT },
    } as unknown as Anthropic.ContentBlockParam
    const serialized = jsonStringify(block)
    expect(roughTokenCountEstimationForContent([block])).toBe(
      Math.round(serialized.length / 3),
    )
    // Guard the direction: the catch-all must not fall back to the old flat 4.
    expect(roughTokenCountEstimationForContent([block])).toBeGreaterThan(
      Math.round(serialized.length / 4),
    )
  })
})

describe('CJK escalation', () => {
  test('a CJK text block escalates to 1.5 chars/token', () => {
    // Measured 1.37 chars/token, so the prose default under-counts it 3.1x.
    expect(
      roughTokenCountEstimationForContent([{ type: 'text', text: CJK_TEXT }]),
    ).toBe(Math.round(LEN / 1.5))
  })

  test('Cyrillic text stays at the prose ratio', () => {
    // The control that forces the detector to key on script ranges instead of
    // on "non-ASCII": Russian measured 4.36 chars/token, already safe at 4.
    expect(
      roughTokenCountEstimationForContent([
        { type: 'text', text: CYRILLIC_TEXT },
      ]),
    ).toBe(Math.round(LEN / 4))
  })

  test('English structured text stays at the prose ratio', () => {
    expect(
      roughTokenCountEstimationForContent([
        { type: 'text', text: STRUCTURED_TEXT },
      ]),
    ).toBe(LEN / 4)
  })

  test('source with CJK comments stays below the threshold', () => {
    // ~0.11 CJK against a 0.30 threshold.  Measured 3.06 chars/token: it is
    // under-counted at 4, but escalating it to 1.5 would over-count it 2x.
    expect(
      roughTokenCountEstimationForContent([
        { type: 'text', text: CJK_COMMENTED_CODE },
      ]),
    ).toBe(Math.round(LEN / 4))
  })

  test('CJK beats the tool_result ratio, which also under-counts it 2.4x', () => {
    expect(
      roughTokenCountEstimationForContent([toolResult(CJK_TEXT)]),
    ).toBe(Math.round(LEN / 1.5))
  })

  test('CJK nested in a tool_result array escalates too', () => {
    // The array branch does not reach the string escalators, so this proves
    // the per-text-block check is what carries it.
    expect(
      roughTokenCountEstimationForContent([
        toolResult([{ type: 'text', text: CJK_TEXT }]),
      ]),
    ).toBe(Math.round(LEN / 1.5))
  })

  test('a tool_use carrying CJK file content escalates', () => {
    // A Write call with a Chinese document was pinned at 4 regardless of size.
    const block: Anthropic.ContentBlockParam = {
      type: 'tool_use',
      id: 'toolu_03',
      name: 'Write',
      input: { file_path: '/tmp/doc.md', content: CJK_TEXT },
    }
    const serialized = 'Write' + jsonStringify(block.input)
    expect(roughTokenCountEstimationForContent([block])).toBe(
      Math.round(serialized.length / 1.5),
    )
  })

  test('thinking blocks keep the prose ratio even when they are CJK', () => {
    // Deliberate carve-out: thinking is model output and is usage-anchored in
    // practice, so it is not re-estimated from characters.
    expect(
      roughTokenCountEstimationForContent([
        { type: 'thinking', thinking: CJK_TEXT, signature: 'sig' },
      ]),
    ).toBe(LEN / 4)
  })
})

describe('base64 escalation', () => {
  test('a base64 tool_result string escalates to 1.5 chars/token', () => {
    // Measured 1.45-1.93 chars/token; the hex escalator misses it because
    // g-z, + and / are not hex digits.
    expect(
      roughTokenCountEstimationForContent([toolResult(BASE64_TEXT)]),
    ).toBe(Math.round(LEN / 1.5))
  })

  test('a data: URI escalates', () => {
    const dataUri = `data:image/png;base64,${padded(BASE64_TEXT_SEED, 4000)}`
    expect(roughTokenCountEstimationForContent([toolResult(dataUri)])).toBe(
      Math.round(dataUri.length / 1.5),
    )
  })

  test('it does not fire on English prose or source output', () => {
    expect(
      roughTokenCountEstimationForContent([toolResult(STRUCTURED_TEXT)]),
    ).toBe(LEN / 3)
  })

  test('it does not fire on hex identifiers, which keep their own ratio', () => {
    // Hex is all one case, so the case-mixing requirement rejects it and the
    // identifier escalator still owns this class at 2.
    expect(
      roughTokenCountEstimationForContent([toolResult(IDENTIFIER_TEXT)]),
    ).toBe(LEN / 2)
  })

  test('it does not fire on a file-path listing', () => {
    // The sweep's largest false-positive class before the slash and run
    // checks were added: CamelCase paths are alphabet-saturated too.
    const paths = padded(
      'Sources/MenuBarLLMApp/Models/RunnerProtocol.swift\n',
      LEN,
    )
    expect(roughTokenCountEstimationForContent([toolResult(paths)])).toBe(
      Math.round(LEN / 3),
    )
  })

  test('it does not fire on dense JSON', () => {
    const json = padded(
      '{"id":42,"name":"item-42","path":"src/services/module42/index.ts"},',
      LEN,
    )
    expect(roughTokenCountEstimationForContent([toolResult(json)])).toBe(
      Math.round(LEN / 3),
    )
  })
})

describe('roughTokenCountEstimationForMessages', () => {
  test('carries the tool_result ratio through the message walk', () => {
    // The real consumer path (src/utils/tokens.ts) counts whole messages, so
    // prove the ratio survives the message -> content -> block walk.
    const tokens = roughTokenCountEstimationForMessages([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: STRUCTURED_TEXT }] },
      },
      {
        type: 'user',
        message: { content: [toolResult(STRUCTURED_TEXT)] },
      },
    ])
    expect(tokens).toBe(LEN / 4 + LEN / 3)
  })
})
