import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APPLY_PATCH_MODEL_EVAL_CASES,
  APPLY_PATCH_MODEL_EVAL_POLICY,
} from './manifest.js'
import { _forTest } from './run.js'

describe('apply_patch model evaluation manifest', () => {
  test('freezes 13 cases, three repeats, and two contracts', () => {
    expect(APPLY_PATCH_MODEL_EVAL_CASES).toHaveLength(13)
    expect(new Set(APPLY_PATCH_MODEL_EVAL_CASES.map(item => item.id)).size).toBe(13)
    expect(APPLY_PATCH_MODEL_EVAL_POLICY.expectedRuns).toBe(78)
  })

  test('all cases require at least one byte change without changing the path set', () => {
    for (const caseDef of APPLY_PATCH_MODEL_EVAL_CASES) {
      expect(Object.keys(caseDef.initialFiles).sort()).toEqual(
        Object.keys(caseDef.expectedFiles).sort(),
      )
      expect(caseDef.initialFiles).not.toEqual(caseDef.expectedFiles)
    }
  })

  test('the hint collision case contains both a whole-line witness and a longer containing line', () => {
    const caseDef = APPLY_PATCH_MODEL_EVAL_CASES.find(
      item => item.id === 'hint-substring-collision',
    )!
    const lines = caseDef.initialFiles['src/hints.ts']!.split('\n').map(line => line.trim())
    const hint = 'export function foo(): string {'
    expect(lines.filter(line => line === hint)).toHaveLength(1)
    expect(lines.filter(line => line !== hint && line.includes(hint))).toHaveLength(1)
  })
})

describe('apply_patch model evaluation runner', () => {
  test('selects only Read and canonical apply_patch', () => {
    const args = _forTest.buildRunArgs('/tmp/cli', 'edit it', 0.18)
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,apply_patch')
    expect(args).toContain('--no-session-persistence')
    expect(args).toContain('--bare')
  })

  test('parses canonical and legacy attempts, rejection, cost, and result', () => {
    const stdout = [
      JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'a', name: 'apply_patch', input: 'patch-a' }] } }),
      JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true }] } }),
      JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'b', name: 'Apply_patch', input: 'patch-b' }] } }),
      JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0.125 }),
    ].join('\n')
    const parsed = _forTest.parseStream(stdout)
    expect(parsed.attempts).toEqual([
      { id: 'a', name: 'apply_patch', input: 'patch-a', rejected: true },
      { id: 'b', name: 'Apply_patch', input: 'patch-b', rejected: null },
    ])
    expect(parsed.costUsd).toBe(0.125)
    expect(parsed.resultText).toBe('done')
  })

  test('scores exact bytes and unexpected files', () => {
    const root = mkdtempSync(join(tmpdir(), 'apply-patch-model-eval-test-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), 'new\n')
    expect(_forTest.scoreFixture(root, { 'src/a.ts': 'new\n' }).taskCorrect).toBe(true)
    writeFileSync(join(root, 'extra.txt'), 'surprise\n')
    const result = _forTest.scoreFixture(root, { 'src/a.ts': 'new\n' })
    expect(result.taskCorrect).toBe(false)
    expect(result.unexpectedPaths).toEqual(['extra.txt'])
    rmSync(root, { recursive: true, force: true })
  })
})
