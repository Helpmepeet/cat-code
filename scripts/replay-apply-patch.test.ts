import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  aggregateReplay,
  extractReplayEnvelopes,
  parseReplayArguments,
  parseReplayJsonl,
  replayEnvelope,
  type ExtractedReplayEnvelope,
} from './replay-apply-patch.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const update = (body: string) => `*** Begin Patch\n*** Update File: src/example.ts\n@@\n${body}\n*** End Patch`
const context = (text: string) => ` ${text}`
const deletion = (text: string) => `-${text}`
const addition = (text: string) => `+${text}`

function fixtureEnvelope(input: unknown, sourceByPath: Record<string, string | null> = {}): ExtractedReplayEnvelope {
  return { id: 'fixture', toolName: 'apply_patch', input, sourceByPath: new Map(Object.entries(sourceByPath)) }
}

describe('offline apply_patch replay helpers', () => {
  test('extracts canonical and legacy tool calls without requiring a live session', () => {
    const records = [
      { message: { content: [{ type: 'tool_use', name: 'apply_patch', input: update(context('target')) }] } },
      { message: { content: [{ type: 'tool_use', name: 'Apply_patch', input: update(context('target')) }] } },
      { message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x' } }] } },
    ]
    expect(extractReplayEnvelopes(records).map(row => row.toolName)).toEqual(['apply_patch', 'Apply_patch'])
  })

  test('requires complete source snapshots, while preserving unknown reasons', () => {
    const result = replayEnvelope(fixtureEnvelope(update(context('target'))))
    expect(result.envelope).toBe('complete')
    expect(result.reconstructable).toBe(false)
    expect(result.unknownReasons).toEqual([{ code: 'missing-source-snapshot', detail: 'src/example.ts' }])
    expect(result.decisions.find(row => row.policy === 'complete-exact')?.status).toBe('unknown')
  })

  test('compares historical first-forward, per-hunk, and complete-plan behavior', () => {
    const patch = update(deletion('target'))
    const source = 'target\nheader\ntarget\n'
    const result = replayEnvelope(fixtureEnvelope(patch, { 'src/example.ts': source }), {
      policies: ['current-per-hunk', 'historical-first-forward', 'complete-exact'],
    })
    expect(result.reconstructable).toBe(true)
    expect(result.decisions.map(row => row.status)).toEqual(['rejected', 'accepted', 'rejected'])
    expect(result.decisions[0]!.reasons[0]!.code).toBe('PATCH_ANCHOR_AMBIGUOUS')
    expect(result.decisions[2]!.reasons[0]!.code).toBe('PATCH_ANCHOR_AMBIGUOUS')
  })

  test('lets the planner use a later hunk as a complete-plan constraint', () => {
    const patch = `${update([deletion('target')].join('\n')).replace('*** End Patch', '@@\n' + context('header') + '\n*** End Patch')}`
    const result = replayEnvelope(fixtureEnvelope(patch, { 'src/example.ts': 'target\nheader\ntarget\n' }), {
      policies: ['complete-exact', 'current-per-hunk'],
    })
    expect(result.decisions.find(row => row.policy === 'complete-exact')?.status).toBe('accepted')
    expect(result.decisions.find(row => row.policy === 'current-per-hunk')?.status).toBe('rejected')
  })

  test('does not accept a planner result until the complete candidate output applies', () => {
    const result = replayEnvelope(
      fixtureEnvelope(update(context('target')), {
        'src/example.ts': 'target\n',
      }),
      {
        policies: ['complete-exact'],
        planner: () => ({
          ok: true,
          plan: {
            path: 'src/example.ts',
            hunks: [],
            output: {
              lineCount: 1,
              hasFinalNewline: true,
              outputEofAffected: false,
            },
          },
          usage: {
            sourcePositionsScanned: 0,
            candidatesRetained: 0,
            hintComparisons: 0,
            dpTransitions: 0,
            predecessorsStored: 0,
            approximateComparisons: 0,
          },
        }),
      },
    )

    expect(result.decisions[0]?.status).toBe('rejected')
    expect(result.decisions[0]?.reasons[0]?.code).toBe(
      'candidate-application-failed',
    )
  })

  test('checks candidate output bytes when a fixture provides an expected snapshot', () => {
    const patch = update(`${deletion('old')}\n${addition('new')}`)
    const matching = {
      ...fixtureEnvelope(patch, { 'src/example.ts': 'old' }),
      expectedByPath: new Map([['src/example.ts', 'new\n']]),
    }
    const mismatching = {
      ...matching,
      expectedByPath: new Map([['src/example.ts', 'new']]),
    }

    expect(replayEnvelope(matching, {
      policies: ['complete-exact'],
    }).decisions[0]?.status).toBe('accepted')
    const mismatch = replayEnvelope(mismatching, {
      policies: ['complete-exact'],
    }).decisions[0]
    expect(mismatch?.status).toBe('rejected')
    expect(mismatch?.reasons[0]?.code).toBe('expected-output-mismatch')
  })

  test('compares serialized CRLF bytes rather than normalized planner text', () => {
    const envelope = {
      ...fixtureEnvelope(update(`${deletion('old')}\n${addition('new')}`), {
        'src/example.ts': 'old\r\n',
      }),
      expectedByPath: new Map([['src/example.ts', 'new\r\n']]),
    }

    expect(replayEnvelope(envelope, {
      policies: ['complete-exact'],
    }).decisions[0]?.status).toBe('accepted')
  })

  test('measures substring hints separately from proposed whole-line hints', () => {
    const patch = update('@@ function foo\n' + context('target'))
    const result = replayEnvelope(fixtureEnvelope(patch, { 'src/example.ts': 'function foobar()\ntarget\n' }), {
      policies: ['hint-substring', 'hint-whole-line'],
    })
    expect(result.decisions.find(row => row.policy === 'hint-substring')?.status).toBe('accepted')
    expect(result.decisions.find(row => row.policy === 'hint-whole-line')?.status).toBe('rejected')
  })

  test('labels structured newline directives as output-only evidence', () => {
    const input = {
      ops: [{
        type: 'update', path: 'src/example.ts', hunks: [{
          scopeHints: [], lines: [context('old'), deletion('old')].map((line, index) => index === 0 ? { kind: 'context', text: 'old' } : { kind: 'delete', text: 'old' }),
          isEndOfFile: true,
          noNewlineAtEndOfFile: true,
        }],
      }],
    }
    const result = replayEnvelope(fixtureEnvelope(input, { 'src/example.ts': 'old' }), { policies: ['newline-semantics'] })
    expect(result.decisions[0]?.reasons).toContainEqual(expect.objectContaining({ code: 'legacy-output-only' }))
  })

  test('caps case details and reason output', () => {
    const cases = Array.from({ length: 4 }, (_, i) => fixtureEnvelope(update(context('target')).replace('src/example.ts', `src/${i}.ts`), { [`src/${i}.ts`]: 'target\n' }))
    const report = aggregateReplay(cases, { maxCases: 2, maxReasons: 1, policies: ['complete-exact'] })
    expect(report.cases).toHaveLength(2)
    expect(report.omittedCases).toBe(2)
    expect(report.denominators).toEqual({ full: 4, complete: 4, reconstructable: 4, unknown: 0 })
    expect(report.byPolicy['complete-exact']).toEqual({ accepted: 4, rejected: 0, unknown: 0 })
  })

  test('rejects a complete envelope when operations touch the same normalized path', () => {
    const input = {
      ops: [
        { type: 'delete', path: 'src/example.ts' },
        { type: 'add', path: 'src/nested/../example.ts', content: 'replacement\n' },
      ],
    }
    const result = replayEnvelope(fixtureEnvelope(input, { 'src/example.ts': 'old\n' }), {
      policies: ['complete-exact', 'current-per-hunk'],
    })
    expect(result.decisions.map(decision => decision.status)).toEqual(['rejected', 'rejected'])
    expect(result.reconstructable).toBe(true)
    expect(result.unknownReasons).toEqual([])
    expect(result.decisions[0]!.reasons).toEqual([expect.objectContaining({ code: 'operation-path-conflict' })])
  })

  test('fails closed before comparison work when an explicit replay input limit is exceeded', () => {
    const result = replayEnvelope(fixtureEnvelope(update(context('target')), {
      'src/example.ts': 'first\ntarget\n',
    }), {
      policies: ['complete-exact', 'complete-tolerant'],
      maxSourceLinesPerFile: 1,
    })
    expect(result.decisions.map(decision => decision.status)).toEqual(['unknown', 'unknown'])
    expect(result.unknownReasons).toEqual([expect.objectContaining({ code: 'replay-input-limit' })])
  })
})

describe('replay CLI input boundaries', () => {
  test('accepts explicit transcript and manifest flags only', () => {
    expect(parseReplayArguments(['--manifest', 'fixtures.json', '--transcript', 'session.jsonl', '--json']).json).toBe(true)
    expect(() => parseReplayArguments([])).toThrow('explicit')
  })

  test('parses malformed JSONL as an unknown envelope without reading any other path', () => {
    const root = mkdtempSync(join('/tmp', 'replay-apply-patch-'))
    roots.push(root)
    const path = join(root, 'session.jsonl')
    writeFileSync(path, '{not json}\n')
    const rows = parseReplayJsonl('{not json}\n')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.input).toBeUndefined()
    expect(rows[0]?.id).toBe('transcript-0-malformed')
  })
})
