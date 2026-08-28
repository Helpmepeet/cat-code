import { describe, expect, test } from 'bun:test'
import type { SDKResultMessage } from '../entrypoints/sdk/coreTypes.generated.js'
import { formatHeadlessTextResult } from './headlessTextResult.js'

function result(
  subtype: SDKResultMessage['subtype'],
  extra: Partial<SDKResultMessage> = {},
): SDKResultMessage {
  return { type: 'result', subtype, ...extra } as SDKResultMessage
}

const LIMITS = { maxTurns: 12, maxBudgetUsd: 5 }

describe('formatHeadlessTextResult', () => {
  // The regression: 0da3dac4 added `interrupted` and `error_auth_required` to
  // the result subtype union but not to the -p text switch, which had no
  // default. Both printed nothing, so an interrupted run was silent AND
  // exited 0. These two cases fail without the fix.
  test('interrupted produces output instead of silence', () => {
    expect(formatHeadlessTextResult(result('interrupted'), LIMITS)).toBe(
      'Interrupted\n',
    )
  })

  test('error_auth_required produces output instead of silence', () => {
    expect(formatHeadlessTextResult(result('error_auth_required'), LIMITS)).toBe(
      'Error: Authentication required\n',
    )
  })

  test('every subtype renders something', () => {
    const subtypes: SDKResultMessage['subtype'][] = [
      'success',
      'interrupted',
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
      'error_auth_required',
    ]
    for (const subtype of subtypes) {
      const text = formatHeadlessTextResult(
        result(subtype, { result: 'answer' }),
        LIMITS,
      )
      expect(text.length).toBeGreaterThan(0)
    }
  })

  // `subtype` is optional in the generated type, so this branch is reachable
  // at runtime today, not only after a future union edit. The compile-time
  // tripwire cannot see it, and no gate compiles the tripwire anyway.
  test('an unrecognized subtype is loud, not silent', () => {
    const text = formatHeadlessTextResult(
      result(undefined as never, { result: 'answer' }),
      LIMITS,
    )
    expect(text).toBe('Error: Unrecognized result subtype (undefined)\n')
  })

  // Guards the pre-existing cases against the extraction that moved them out
  // of runHeadless. These pass either way; they exist to catch a bad move.
  test('existing subtypes are unchanged by the extraction', () => {
    expect(
      formatHeadlessTextResult(result('success', { result: 'answer' }), LIMITS),
    ).toBe('answer\n')
    expect(
      formatHeadlessTextResult(
        result('success', { result: 'answer\n' }),
        LIMITS,
      ),
    ).toBe('answer\n')
    expect(
      formatHeadlessTextResult(result('error_during_execution'), LIMITS),
    ).toBe('Execution error')
    expect(formatHeadlessTextResult(result('error_max_turns'), LIMITS)).toBe(
      'Error: Reached max turns (12)',
    )
    expect(
      formatHeadlessTextResult(result('error_max_budget_usd'), LIMITS),
    ).toBe('Error: Exceeded USD budget (5)')
    expect(
      formatHeadlessTextResult(
        result('error_max_structured_output_retries'),
        LIMITS,
      ),
    ).toBe(
      'Error: Failed to provide valid structured output after maximum retries',
    )
  })
})
