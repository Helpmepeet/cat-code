import { describe, expect, test } from 'bun:test'

import {
  CODEX_PARTIAL_STREAM_ERROR_NAME,
  CodexPartialStreamReplaySkippedError,
  findCodexPartialStreamFailure,
  findErrorInChainByName,
  isCodexPartialStreamReplaySkippedError,
  parseCodexPartialStreamFailure,
  type CodexPartialStreamFailureV1,
} from './errorUtils.js'

const VALID: CodexPartialStreamFailureV1 = {
  version: 1,
  code: 'partial_stream_replay_skipped',
  provider: 'openai',
  transport: 'websocket',
  cause: 'closed',
  sealedPartialText: true,
  hadClientToolCall: false,
  openClientToolCalls: 0,
  hadHostedWebSearch: false,
  automaticContinuationEligible: true,
}

function wrap(depth: number, inner: Error): Error {
  let current = inner
  for (let i = 0; i < depth; i++) {
    const outer = new Error(`wrapper ${i}`)
    outer.cause = current
    current = outer
  }
  return current
}

describe('parseCodexPartialStreamFailure', () => {
  test('accepts a complete payload', () => {
    expect(parseCodexPartialStreamFailure({ ...VALID })).toEqual(VALID)
  })

  test('rejects anything it cannot fully account for', () => {
    // Every field is required. A payload missing one is a payload whose
    // provenance cannot be established, and an unrecoverable turn beats a
    // continuation authorized by a guess.
    const rejected: unknown[] = [
      undefined,
      null,
      'partial_stream_replay_skipped',
      42,
      {},
      { code: 'partial_stream_replay_skipped' },
      { ...VALID, version: 2 },
      { ...VALID, provider: 'anthropic' },
      { ...VALID, code: 'something_else' },
      { ...VALID, transport: 'carrier-pigeon' },
      { ...VALID, cause: 'vibes' },
      { ...VALID, sealedPartialText: 'yes' },
      { ...VALID, openClientToolCalls: -1 },
      { ...VALID, openClientToolCalls: 1.5 },
      { ...VALID, automaticContinuationEligible: undefined },
    ]
    for (const candidate of rejected) {
      expect(parseCodexPartialStreamFailure(candidate)).toBeNull()
    }
  })
})

describe('cause-chain recognition', () => {
  test('the name gate is not depth-capped', () => {
    // This gate is what stops a replay of a request whose output the user has
    // already read. A deeper wrap must not silently switch it off.
    const deep = wrap(40, new CodexPartialStreamReplaySkippedError('boom', VALID))
    expect(isCodexPartialStreamReplaySkippedError(deep)).toBe(true)
  })

  test('a cycle terminates instead of hanging', () => {
    const a = new Error('a')
    const b = new Error('b')
    a.cause = b
    b.cause = a
    expect(isCodexPartialStreamReplaySkippedError(a)).toBe(false)
    expect(findCodexPartialStreamFailure(a)).toBeNull()
    expect(findErrorInChainByName(a, new Set(['nope']))).toBeNull()
  })

  test('a name-only marker blocks replay but authorizes nothing', () => {
    const nameOnly = new Error('legacy')
    nameOnly.name = CODEX_PARTIAL_STREAM_ERROR_NAME
    expect(isCodexPartialStreamReplaySkippedError(nameOnly)).toBe(true)
    expect(findCodexPartialStreamFailure(nameOnly)).toBeNull()
  })

  test('finds the payload and a wrapped verdict through the chain', () => {
    const verdict = new Error('Codex account acct_x hit usage cap')
    verdict.name = 'CodexAccountCapError'
    const marker = new CodexPartialStreamReplaySkippedError('interrupted', VALID)
    marker.cause = verdict

    expect(findCodexPartialStreamFailure(marker)).toEqual(VALID)
    expect(
      findErrorInChainByName(marker, new Set(['CodexAccountCapError']))?.name,
    ).toBe('CodexAccountCapError')
  })
})
