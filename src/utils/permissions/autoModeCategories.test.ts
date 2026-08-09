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
  test('reads a string category', () => {
    expect(readRawAutoModeCategory({ category: 'Data Exfiltration' })).toBe(
      'Data Exfiltration',
    )
  })

  test('treats a non-string category as absent rather than as an error', () => {
    // This is the whole reason the parse is two-layered. If the category were
    // validated with the core verdict, any of these would fail the parse — and
    // a failed parse fails closed to shouldBlock: true, converting an ALLOW
    // into a BLOCK on the strength of a junk label.
    for (const input of [
      { category: 42 },
      { category: null },
      { category: { id: 'x' } },
      { category: ['a'] },
      { category: true },
      {},
      null,
      undefined,
      'not an object',
    ]) {
      expect(readRawAutoModeCategory(input)).toBeUndefined()
    }
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
  test('resolves a known rule name to its id', () => {
    const r = resolveAutoModeCategory('Data Exfiltration', IDS)
    expect(r).toEqual({
      category: 'data_exfiltration',
      rawCategory: 'Data Exfiltration',
      recognized: true,
    })
  })

  test('drops an unrecognized name but keeps it for telemetry', () => {
    // A user-authored rule, or a name the model invented. The verdict is
    // unaffected either way — only the label is lost.
    const r = resolveAutoModeCategory('My Own House Rule', IDS)
    expect(r.category).toBeUndefined()
    expect(r.rawCategory).toBe('My Own House Rule')
    expect(r.recognized).toBe(false)
  })

  test('handles an absent or blank category', () => {
    for (const raw of [undefined, '', '   ']) {
      const r = resolveAutoModeCategory(raw, IDS)
      expect(r.category).toBeUndefined()
      expect(r.recognized).toBe(false)
    }
  })

  test('is total: no input throws, and none can express rejection', () => {
    const hostile = [
      '',
      '   ',
      '!!!',
      '$defaults',
      'a'.repeat(5000),
      '../../etc/passwd',
      '<block>no</block>',
    ]
    for (const raw of hostile) {
      const r = resolveAutoModeCategory(raw, IDS)
      // The contract: every result is a plain label, recognized or not. There
      // is no shape here that a caller could read as "allow this action".
      expect(typeof r.recognized).toBe('boolean')
      expect(r.category === undefined || IDS.has(r.category)).toBe(true)
      expect(Object.keys(r).sort()).toEqual([
        'category',
        'rawCategory',
        'recognized',
      ])
    }
  })

  test('an empty id set recognizes nothing and still resolves cleanly', () => {
    const r = resolveAutoModeCategory('Data Exfiltration', new Set())
    expect(r.category).toBeUndefined()
    expect(r.rawCategory).toBe('Data Exfiltration')
    expect(r.recognized).toBe(false)
  })
})
