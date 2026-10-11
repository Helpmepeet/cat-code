import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { files, investigation } from './fixtures.js'
import { grade } from './grade.js'
import { budgetAllows, reservation } from './policy.js'
import { cost, usage, exposure, verification, run } from './run.js'
import { collect, loadResults } from './collect.js'

// Authoring gate: protect independent grading/admission/evidence contracts.
// These fail if success trusts text instead of artifacts, budgets admit one
// extra call, failed attempts disappear, or preserved tracking gets mislabeled
// as compaction exposure. Existing candidate unit tests cannot detect these
// evaluator failures. No production seam is added.
test('completion cannot come from a claim or working implementation with omitted verification/documentation', () => {
  const root = mkdtempSync('/private/tmp/tre-grade-')
  try {
    for (const [p, body] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), body) }
    const checks = { decimal: true, fractional: true, finalRounding: true, empty: true, comma: true, quote: true, newline: true, order: true }
    const incomplete = grade(root, 'ordinary', checks, false)
    expect(incomplete.complete).toBe(false)
    expect(incomplete.omissions).toContain('required successful bun check.ts')
    expect(incomplete.omissions).toContain('escaping documentation')
    writeFileSync(join(root, 'README.md'), 'Round final totals to cents. Quote fields and escape quotes.')
    expect(grade(root, 'ordinary', checks, true).complete).toBe(true)
    writeFileSync(join(root, 'archive/ledger.csv'), 'corrupted')
    expect(grade(root, 'ordinary', checks, true)).toMatchObject({ complete: false, incorrect: ['archive/ledger.csv'] })
    writeFileSync(join(root, 'REVIEW.md'), 'Floating point rounding defects; escaping and quoting defects.')
    mkdirSync(join(root, 'investigation'))
    for (let i = 0; i < 24; i++) writeFileSync(join(root, 'investigation', `batch-${i}.txt`), investigation(i))
    writeFileSync(join(root, 'unexpected.txt'), 'stale mutation')
    expect(grade(root, 'redirect', null, false).incorrect).toContain('unexpected.txt')
    writeFileSync(join(root, 'investigation/batch-0.txt'), 'stale mutation')
    expect(grade(root, 'redirect', null, false).incorrect).toContain('investigation/batch-0.txt')
    expect(grade(root, 'redirect', null, false).incorrect).toContain('archive/ledger.csv')
    expect(grade(root, 'redirect', null, true).incorrect).toContain('cancelled verification executed')
    const canary = join(root, 'private-canary.csv')
    writeFileSync(canary, files['archive/ledger.csv'])
    rmSync(join(root, 'archive/ledger.csv')); symlinkSync(canary, join(root, 'archive/ledger.csv'))
    expect(grade(root, 'ordinary', checks, true).incorrect).toContain('archive/ledger.csv')
  } finally { rmSync(root, { recursive: true }) }
})
test('admission reserves failed attempts and refuses a request before crossing count/input/dollar caps', async () => {
  // Refuse before opening even a manifest or authorization/key file.
  await expect(run('/nonexistent-eval', true, '/must-not-read-key')).rejects.toThrow('Live execution blocked')
  const next = reservation({ model: 'claude-sonnet-5-5', max_tokens: 4096 }, { model: 'claude-sonnet-5-5', inputUsdPerMillion: 5, cacheReadUsdPerMillion: 1, cacheWrite5mUsdPerMillion: 6, cacheWrite1hUsdPerMillion: 8, outputUsdPerMillion: 25, checkedAt: 'fixture', source: 'fixture, not a real price' })
  expect(budgetAllows({ requests: 0, input: 0, usd: 0 }, next)).toBe(true)
  expect(budgetAllows({ requests: 12, input: 0, usd: 0 }, next)).toBe(false)
  expect(budgetAllows({ requests: 1, input: 999999, usd: 0 }, next)).toBe(false)
  expect(budgetAllows({ requests: 1, input: 0, usd: 4 }, next)).toBe(false)
  expect(() => reservation({ model: 'other', max_tokens: 4096 })).toThrow()
  expect(() => reservation({ model: 'claude-sonnet-5-5', max_tokens: 4097 })).toThrow()
})
test('attempt accounting keeps retries and unknown usage; exposure rejects retained tracking', () => {
  const records = [
    { kind: 'request', attempt: 1 },
    { kind: 'response', attempt: 1, status: 500, text: 'failed' },
    { kind: 'request', attempt: 2 },
    { kind: 'response', attempt: 2, status: 200, text: 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":90,"cache_creation_input_tokens":5}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":8}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n' },
    { kind: 'request', attempt: 3 },
  ]
  expect(usage(records)).toEqual({ input: 100, cached: 90, created: 5, output: 8, unknownAttempts: 2, attempts: 3 })
  expect(usage([{ kind: 'request', attempt: 1 }, { kind: 'response', attempt: 1, status: 200, text: 'data: {"type":"message_start","message":{"usage":{}}}\ndata: {"type":"message_delta","usage":{}}\nevent: message_stop\n' }]).unknownAttempts).toBe(1)
  const request = { kind: 'request', phase: 'work', body: { tools: [{ name: 'Bash' }], messages: [{ type: 'tool_use', id: 'old-tracking' }] } }
  expect(exposure([request], { trackingIds: ['old-tracking'] }, true).valid).toBe(false)
  request.body.messages = [{ type: 'text', id: 'summary' }]
  expect(exposure([request], { trackingIds: ['old-tracking'] }, true).valid).toBe(true)
})
test('required verification must pair a successful actual tool result with an executable check command', () => {
  const event = (type: string, content: any[]) => ({ event: { type: 'message', message: { type, message: { content } } } })
  const call = event('assistant', [{ type: 'tool_use', name: 'Bash', id: 'check', input: { command: 'bun check.ts' } }])
  const result = event('user', [{ type: 'tool_result', tool_use_id: 'check', content: 'Invoice checks passed' }])
  expect(verification([call, event('assistant', [{ type: 'text', text: 'Invoice checks passed' }])]).succeeded).toBe(false)
  expect(verification([call, result])).toEqual({ attempted: true, succeeded: true })
  result.event.message.message.content[0].is_error = true
  expect(verification([call, result]).succeeded).toBe(false)
})
test('billing distinguishes cache tiers, refuses unknown usage, and charges unsuccessful work to cost per completion', () => {
  const prices = { model: 'claude-sonnet-5-5', inputUsdPerMillion: 5, cacheReadUsdPerMillion: 1, cacheWrite5mUsdPerMillion: 6, cacheWrite1hUsdPerMillion: 8, outputUsdPerMillion: 25, source: 'offline fixture, not actual prices', checkedAt: '2026-10-11' }
  const request = { kind: 'request', attempt: 1 }
  const response = { kind: 'response', attempt: 1, status: 200, text: 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":90,"cache_creation_input_tokens":5,"cache_creation":{"ephemeral_5m_input_tokens":5,"ephemeral_1h_input_tokens":0}}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":8}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n' }
  expect(cost([request, response], prices)).toBeCloseTo(0.00082, 9)
  expect(cost([request], prices)).toBeNull()
  response.text = response.text.replace('"ephemeral_5m_input_tokens":5', '"ephemeral_5m_input_tokens":0')
  expect(cost([request, response], prices)).toBeNull()
  const row = { caseId: 'ordinary', arm: 'off', cohort: 'ordinary', valid: true, complete: true, repeat: 1, elapsedMs: 10, costUsdEstimate: 1, omissions: [], incorrect: [], usage: { unknownAttempts: 0 } }
  const report = collect({ live: true, manifestSha256: 'fixture', results: [row, { ...row, repeat: 2, complete: false, elapsedMs: 20, costUsdEstimate: 0.5 }] })
  expect(report.cohorts.ordinary.arms.off.costPerVerifiedCompletion).toBe(1.5)
  expect(report.cohorts.ordinary.arms.off.msPerVerifiedCompletion).toBe(30)
  const root = mkdtempSync('/private/tmp/tre-interrupted-')
  try {
    writeFileSync(join(root, 'results.json'), JSON.stringify({ live: true, manifestSha256: 'fixture', prices, results: [] }))
    mkdirSync(join(root, 'attempt'))
    writeFileSync(join(root, 'attempt/attempt.json'), JSON.stringify({ caseId: 'ordinary', repeat: 1, arm: 'off', cohort: 'ordinary' }))
    writeFileSync(join(root, 'attempt/requests.jsonl'), JSON.stringify(request) + '\n{"incomplete')
    const interrupted = collect(loadResults(root)).cohorts.ordinary.arms.off
    expect(interrupted.attempts).toBe(1)
    expect(interrupted.usage[0].unknownAttempts).toBe(1)
    expect(interrupted.costUsdEstimate).toBeNull()
    expect(interrupted.msPerVerifiedCompletion).toBeNull()
  } finally { rmSync(root, { recursive: true }) }
})
