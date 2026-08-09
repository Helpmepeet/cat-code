/**
 * The property under test is a safety property, not a formatting one: nothing
 * about the category may reach the block decision. The failure it guards is an
 * unrecognized category becoming a validation failure and then, under "an
 * unnameable block is not a block", a silent ALLOW.
 *
 * Ids are checked against the real vendored inventory and cross-checked against
 * `claude auto-mode defaults`, so a re-sync that changes the rule set fails here
 * rather than silently shrinking the set of nameable categories.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  extractAutoModeRuleEntries,
  extractAutoModeRuleIds,
  hasAutoModeCategory,
  isAutoModeVerdictCategoryValid,
  normalizeAutoModeCategory,
  readRawAutoModeCategory,
  resolveAutoModeCategory,
} from './autoModeCategories.js'

const UPSTREAM_DIR = join(
  import.meta.dir,
  'yolo-classifier-prompts',
  'upstream',
)
const PERMISSIONS = readFileSync(join(UPSTREAM_DIR, 'permissions.txt'), 'utf-8')
const RULES = JSON.parse(
  readFileSync(join(UPSTREAM_DIR, 'rules.json'), 'utf-8'),
) as { soft_deny: string[]; hard_deny: string[]; allow: string[] }

const IDS = extractAutoModeRuleIds(PERMISSIONS)

describe('extractAutoModeRuleIds', () => {
  test('finds one id per block rule in the vendored inventory', () => {
    expect(IDS.size).toBe(RULES.hard_deny.length + RULES.soft_deny.length)
    expect(IDS.size).toBe(66)
  })

  test('agrees with the CLI rule dump, name for name', () => {
    const fromCli = [...RULES.hard_deny, ...RULES.soft_deny].map(rule =>
      normalizeAutoModeCategory(rule.split(/[:[]/)[0]!),
    )
    expect([...fromCli].sort()).toEqual([...IDS].sort())
  })

  test('includes the unconditional rule and a representative soft rule', () => {
    expect(IDS.has('data_exfiltration')).toBe(true)
    expect(IDS.has('git_destructive')).toBe(true)
  })

  test('returns an empty set for an empty template rather than throwing', () => {
    expect(extractAutoModeRuleIds('').size).toBe(0)
  })
})

describe('extractAutoModeRuleEntries', () => {
  // `claude auto-mode defaults` reports these counts to the operator. Counting
  // a rule's nested sub-bullets as separate rules made the single hard-deny
  // rule report as four, which is the CLI misdescribing the safety posture.
  test('reports one entry per rule, matching the CLI dump exactly', () => {
    const hard = extractAutoModeRuleEntries(
      PERMISSIONS,
      'user_hard_deny_rules_to_replace',
    )
    const soft = extractAutoModeRuleEntries(
      PERMISSIONS,
      'user_soft_deny_rules_to_replace',
    )
    expect(hard).toHaveLength(RULES.hard_deny.length)
    expect(hard).toHaveLength(1)
    expect(soft).toHaveLength(RULES.soft_deny.length)
  })

  test('keeps a rule body whole, sub-bullets included', () => {
    const [dataExfil] = extractAutoModeRuleEntries(
      PERMISSIONS,
      'user_hard_deny_rules_to_replace',
    )
    expect(dataExfil!.startsWith('Data Exfiltration:')).toBe(true)
    // The three nested clauses belong to this rule, not beside it.
    expect(dataExfil).toContain('What is being sent?')
    expect(dataExfil).toContain('Trace the full destination path.')
  })

  test('returns nothing for an absent tag rather than throwing', () => {
    expect(extractAutoModeRuleEntries(PERMISSIONS, 'no_such_tag')).toEqual([])
    expect(extractAutoModeRuleEntries('', 'user_hard_deny_rules_to_replace')).toEqual(
      [],
    )
  })
})

describe('readRawAutoModeCategory (second parse layer)', () => {
  test('reads the category without validating it', () => {
    expect(
      readRawAutoModeCategory({
        category: { kind: 'built_in', id: 'data_exfiltration' },
      }),
    ).toEqual({ kind: 'built_in', id: 'data_exfiltration' })
  })

  test('returns undefined when category is absent', () => {
    for (const input of [
      {},
      null,
      undefined,
      'not an object',
    ]) {
      expect(readRawAutoModeCategory(input)).toBeUndefined()
    }
  })
})

describe('hasAutoModeCategory', () => {
  test('distinguishes an omitted category from malformed category data', () => {
    expect(hasAutoModeCategory({ shouldBlock: false })).toBe(false)
    expect(hasAutoModeCategory({ category: null })).toBe(true)
  })
})

describe('isAutoModeVerdictCategoryValid', () => {
  test('rejects category data on allow verdicts', () => {
    expect(
      isAutoModeVerdictCategoryValid(false, {
        category: { kind: 'built_in', id: 'data_exfiltration' },
      }),
    ).toBe(false)
    expect(isAutoModeVerdictCategoryValid(false, {})).toBe(true)
    expect(
      isAutoModeVerdictCategoryValid(true, {
        category: { kind: 'built_in', id: 'data_exfiltration' },
      }),
    ).toBe(true)
  })
})

describe('normalizeAutoModeCategory', () => {
  test('lowercases and collapses punctuation to single underscores', () => {
    expect(normalizeAutoModeCategory('Data Exfiltration')).toBe(
      'data_exfiltration',
    )
    expect(normalizeAutoModeCategory('DNS / Domain / Cert Changes')).toBe(
      'dns_domain_cert_changes',
    )
    expect(normalizeAutoModeCategory('  Secret-Store Writes  ')).toBe(
      'secret_store_writes',
    )
  })
})

describe('resolveAutoModeCategory', () => {
  test('resolves a known built-in category', () => {
    const r = resolveAutoModeCategory(
      { kind: 'built_in', id: 'data_exfiltration' },
      IDS,
    )
    expect(r).toEqual({
      category: { kind: 'built_in', id: 'data_exfiltration' },
    })
  })

  test('drops malformed and unrecognized categories', () => {
    const r = resolveAutoModeCategory(
      { kind: 'built_in', id: 'not_a_rule' },
      IDS,
    )
    expect(r.category).toBeUndefined()
  })

  test('handles an absent or invalid category', () => {
    for (const raw of [undefined, '', '   ', { kind: 'configured', index: 0 }]) {
      const r = resolveAutoModeCategory(raw, IDS)
      expect(r.category).toBeUndefined()
    }
  })

  test('is total: no input throws, and none can express rejection', () => {
    const hostile = [
      '',
      '   ',
      '!!!',
      { kind: 'built_in', id: '$defaults' },
      { kind: 'built_in', id: 'a'.repeat(5000) },
      { kind: 'built_in', id: '../../etc/passwd' },
      { kind: 'configured', source: 'permissions.deny', index: 0 },
    ]
    for (const raw of hostile) {
      const r = resolveAutoModeCategory(raw, IDS)
      expect(r.category === undefined || IDS.has(r.category.id)).toBe(true)
      expect(Object.keys(r)).toEqual(['category'])
    }
  })

  test('an empty id set recognizes nothing and still resolves cleanly', () => {
    const r = resolveAutoModeCategory('Data Exfiltration', new Set())
    expect(r.category).toBeUndefined()
  })
})
