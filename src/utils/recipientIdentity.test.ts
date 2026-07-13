import { describe, expect, test } from 'bun:test'
import {
  canonicalizeNewTeammateName,
  parseLocalRecipient,
  recipientNameKey,
} from './recipientIdentity.js'

describe('recipientIdentity', () => {
  test('canonicalizes valid new teammate names once', () => {
    expect(canonicalizeNewTeammateName('  Researcher_2  ')).toBe('researcher_2')
  })

  test.each(['*', 'team-lead', 'foo.bar', 'foo@bar', 'bridge:peer', 'uds:peer', '/peer', 'two words', 'con', 'NUL', 'com1', 'lpt9', 'a'.repeat(65)])(
    'rejects reserved or lossy teammate name %s',
    input => {
      expect(() => canonicalizeNewTeammateName(input)).toThrow()
    },
  )

  test('uses a case-insensitive collision key', () => {
    expect(recipientNameKey(' Ada ')).toBe('ada')
  })

  test('keeps explicit local addressing distinct from bare addressing', () => {
    expect(parseLocalRecipient('@Ada')).toEqual({ explicit: true, target: 'Ada' })
    expect(parseLocalRecipient('ada')).toEqual({ explicit: false, target: 'ada' })
    expect(() => parseLocalRecipient('@')).toThrow()
    expect(() => parseLocalRecipient('@@alice')).toThrow()
  })
})
