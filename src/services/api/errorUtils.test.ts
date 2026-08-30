import { describe, expect, test } from 'bun:test'

import {
  CODEX_PARTIAL_STREAM_ERROR_NAME,
  CodexPartialStreamReplaySkippedError,
  extractConnectionErrorDetails,
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

function coded(message: string, code: string): Error {
  const error = new Error(message)
  ;(error as Error & { code?: string }).code = code
  return error
}

function named(name: string): Error {
  const error = new Error(name)
  error.name = name
  return error
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
    // Same chain, the other walker: the uncapped name gate and the bounded
    // payload walk both have to survive a cycle.
    expect(extractConnectionErrorDetails(a)).toBeNull()
  })

  test('a name-only marker blocks replay but authorizes nothing', () => {
    const nameOnly = new Error('legacy')
    nameOnly.name = CODEX_PARTIAL_STREAM_ERROR_NAME
    expect(isCodexPartialStreamReplaySkippedError(nameOnly)).toBe(true)
    expect(findCodexPartialStreamFailure(nameOnly)).toBeNull()
  })

  test('the bounded walk counts errors inspected, not links traversed', () => {
    // Both walkers share one bound, so this pins where it falls: the error
    // handed in is the first of five, leaving four wrappers of headroom.
    const atLimit = wrap(4, coded('root', 'ECONNRESET'))
    expect(extractConnectionErrorDetails(atLimit)?.code).toBe('ECONNRESET')
    expect(
      findErrorInChainByName(wrap(4, named('Verdict')), new Set(['Verdict'])),
    ).not.toBeNull()

    const pastLimit = wrap(5, coded('root', 'ECONNRESET'))
    expect(extractConnectionErrorDetails(pastLimit)).toBeNull()
    expect(
      findErrorInChainByName(wrap(5, named('Verdict')), new Set(['Verdict'])),
    ).toBeNull()
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

describe('extractConnectionErrorDetails', () => {
  test('reports the wrapped code and whether it is a TLS failure', () => {
    expect(
      extractConnectionErrorDetails(wrap(2, coded('handshake', 'CERT_HAS_EXPIRED'))),
    ).toEqual({
      code: 'CERT_HAS_EXPIRED',
      message: 'handshake',
      isSSLError: true,
    })
    expect(extractConnectionErrorDetails(coded('reset', 'ECONNRESET'))).toEqual({
      code: 'ECONNRESET',
      message: 'reset',
      isSSLError: false,
    })
  })

  test('a code on a non-Error object is not a connection error', () => {
    // A code is only trusted on a real error: a deserialized transcript shape
    // or an SDK response body can carry a `code` field that means something
    // else entirely, and the walk must not read it as a transport failure.
    expect(
      extractConnectionErrorDetails({
        code: 'CERT_HAS_EXPIRED',
        message: 'not an error',
      }),
    ).toBeNull()

    const wrapper = new Error('outer')
    wrapper.cause = { code: 'ECONNRESET', message: 'not an error' }
    expect(extractConnectionErrorDetails(wrapper)).toBeNull()
  })

  test('returns null for values with no chain to walk', () => {
    expect(extractConnectionErrorDetails(null)).toBeNull()
    expect(extractConnectionErrorDetails(undefined)).toBeNull()
    expect(extractConnectionErrorDetails('ECONNRESET')).toBeNull()
    expect(extractConnectionErrorDetails(new Error('no code'))).toBeNull()
  })
})
