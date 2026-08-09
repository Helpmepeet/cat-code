/**
 * Extraction tests for the auto-mode denial surface.
 *
 * The regression that motivates the first test is real and shipped: the original
 * scan globbed `*/  /**  /*.jsonl` plus `*/  /*.jsonl`, and because Python's
 * recursive glob already matches top-level files, every session transcript was
 * scanned twice while subagent transcripts were scanned once. Denials in a
 * parent transcript were double-counted, and a command denied once in a parent
 * transcript appeared as a repeat. That inflated the published analysis until
 * revision 4. Any rewrite of the walk must keep counting each file once.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'auto-mode-denials.ts')
const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** One assistant tool_use plus its denied tool_result, as a transcript pair. */
function denialPair(id: string, command: string, body: string, ts: string): string {
  const use = {
    timestamp: ts,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  }
  const result = {
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: body }],
    },
  }
  return `${JSON.stringify(use)}\n${JSON.stringify(result)}\n`
}

const DENIED = (reason: string) =>
  `Permission for this action has been denied. Reason: ${reason}. To allow this type of action in the future…`
const UNAVAILABLE =
  'The auto mode classifier request using gpt-5.6-sol is temporarily unavailable, so auto mode cannot determine the safety of Bash right now.'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'denials-'))
  dirs.push(root)
  const project = join(root, '-Users-pt-cat-code')
  const subagents = join(project, 'sess-1', 'subagents')
  mkdirSync(subagents, { recursive: true })
  const now = new Date().toISOString()
  // A denial in the PARENT transcript — the shape the old glob counted twice.
  writeFileSync(
    join(project, 'sess-1.jsonl'),
    denialPair('t1', 'rm /tmp/probe.log', DENIED('deletes a file outside the project'), now),
  )
  // Two denials of the SAME command in one subagent: a genuine repeat.
  writeFileSync(
    join(subagents, 'agent-a1.jsonl'),
    denialPair('t2', 'kill 4242', DENIED('ownership of PID 4242 is not established'), now) +
      denialPair('t3', 'kill 4242', DENIED('ownership of PID 4242 is not established'), now) +
      denialPair('t4', 'bun test app/', UNAVAILABLE, now),
  )
  return root
}

function run(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(['bun', 'run', SCRIPT, ...args])
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}

test('counts each transcript once — a denial in a parent transcript is not double-counted', () => {
  const { code, out } = run(['--root', fixture(), '--json'])
  expect(code).toBe(0)
  const rows = JSON.parse(out) as { kind: string; command: string }[]
  // 3 decisions (1 parent + 2 subagent) + 1 outage. The old double-scan reported 5.
  expect(rows).toHaveLength(4)
  expect(rows.filter(r => r.command === 'rm /tmp/probe.log')).toHaveLength(1)
})

test('separates a classifier decision from a denial issued with no verdict', () => {
  const rows = JSON.parse(run(['--root', fixture(), '--json']).out) as {
    kind: string
    reason: string
  }[]
  expect(rows.filter(r => r.kind === 'decision')).toHaveLength(3)
  const outage = rows.filter(r => r.kind === 'outage')
  expect(outage).toHaveLength(1)
  expect(outage[0]!.reason).toBe('classifier unavailable')
})

test('joins each denial to the command that caused it via tool_use_id', () => {
  const rows = JSON.parse(run(['--root', fixture(), '--json']).out) as {
    command: string
    reason: string
  }[]
  const killed = rows.find(r => r.command === 'kill 4242')
  expect(killed?.reason).toBe('ownership of PID 4242 is not established')
  expect(rows.every(r => r.command !== '(command not retained)')).toBe(true)
})

test('reports a repeated command once, with its repeat count', () => {
  const { out } = run(['--root', fixture()])
  expect(out).toContain('1 command(s) denied more than once')
  expect(out).toContain('x2  kill 4242')
})

test('--kind filters to one denial kind', () => {
  const rows = JSON.parse(run(['--root', fixture(), '--json', '--kind', 'outage']).out)
  expect(rows).toHaveLength(1)
})

test('a torn JSONL line does not abort the scan', () => {
  const root = fixture()
  writeFileSync(
    join(root, '-Users-pt-cat-code', 'torn.jsonl'),
    '{"message":{"content":[{"type":"tool_use"\n',
  )
  const { code, out } = run(['--root', root, '--json'])
  expect(code).toBe(0)
  expect(JSON.parse(out)).toHaveLength(4)
})
