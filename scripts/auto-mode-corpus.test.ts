/**
 * The corpus is a gate input, so its value comes entirely from being frozen and
 * reproducible. A builder that silently drifts, or that quietly drops cases,
 * turns the replay gate back into the unfalsifiable thing the review rejected.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'auto-mode-corpus.ts')
const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const DENIED = (reason: string) =>
  `Permission for this action has been denied. Reason: ${reason}. To allow this…`
const UNAVAILABLE =
  'The auto mode classifier request using gpt-5.6-sol is temporarily unavailable, so auto mode cannot determine the safety of Bash right now.'

function entry(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`
}
function toolUse(id: string, name: string, input: unknown) {
  return entry({
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  })
}
function toolResult(id: string, content: string, isError = false) {
  return entry({
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content, is_error: isError },
      ],
    },
  })
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'corpus-'))
  dirs.push(root)
  const project = join(root, '-Users-pt-cat-code')
  mkdirSync(project, { recursive: true })

  // Session that started in auto mode: one block, one allow, one outage, one error.
  writeFileSync(
    join(project, 'auto.jsonl'),
    entry({ permissionMode: 'auto', timestamp: '2026-08-09T00:00:00Z' }) +
      toolUse('t1', 'Bash', { command: 'kill 4242' }) +
      toolResult('t1', DENIED('ownership of PID 4242 is not established')) +
      toolUse('t2', 'Bash', { command: 'bun test app/' }) +
      toolResult('t2', 'ok, 485 pass') +
      toolUse('t3', 'Bash', { command: 'bun run typecheck' }) +
      toolResult('t3', UNAVAILABLE) +
      toolUse('t4', 'Read', { file_path: '/etc/hosts' }) +
      toolResult('t4', 'boom', true),
  )
  // Session that never ran auto mode: its completed calls are not allow cases.
  writeFileSync(
    join(project, 'plain.jsonl'),
    toolUse('p1', 'Bash', { command: 'echo hi' }) + toolResult('p1', 'hi'),
  )
  return root
}

function run(root: string, out: string): { code: number; out: string } {
  const p = Bun.spawnSync(['bun', 'run', SCRIPT, '--root', root, '--out', out])
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}

function build(): { body: any; stdout: string; file: string } {
  const root = fixture()
  const out = join(root, 'corpus.json')
  const { code, out: stdout } = run(root, out)
  expect(code).toBe(0)
  return { body: JSON.parse(readFileSync(out, 'utf-8')), stdout, file: out }
}

test('extracts block cases with the reason that caused them', () => {
  const { body } = build()
  const blocks = body.cases.filter((c: any) => c.kind === 'block')
  expect(blocks).toHaveLength(1)
  expect(blocks[0].action).toBe('kill 4242')
  expect(blocks[0].reason).toContain('ownership of PID 4242')
})

test('counts a completed call as an allow only in an auto-mode session', () => {
  const { body } = build()
  const allows = body.cases.filter((c: any) => c.kind === 'allow')
  // `bun test app/` qualifies. `echo hi` is from a session that never ran auto
  // mode, so it proves nothing about the classifier.
  expect(allows.map((c: any) => c.action)).toEqual(['bun test app/'])
})

test('excludes outage denials, which carry no verdict to replay against', () => {
  const { body } = build()
  expect(
    body.cases.some((c: any) => c.action === 'bun run typecheck'),
  ).toBe(false)
})

test('excludes failed calls, which are not evidence of permission', () => {
  const { body } = build()
  expect(body.cases.some((c: any) => c.action === '/etc/hosts')).toBe(false)
})

test('is reproducible: same input, identical bytes', () => {
  const root = fixture()
  const a = join(root, 'a.json')
  const b = join(root, 'b.json')
  run(root, a)
  run(root, b)
  expect(readFileSync(a, 'utf-8')).toBe(readFileSync(b, 'utf-8'))
})

test('records a hash that actually verifies the file it names', () => {
  const { body: _body, file } = build()
  const recorded = readFileSync(file.replace(/\.json$/, '.sha256'), 'utf-8')
    .trim()
    .split(/\s+/)[0]!
  const actual = new Bun.CryptoHasher('sha256')
    .update(readFileSync(file))
    .digest('hex')
  // Hashing the JSON while writing JSON+newline silently breaks verification.
  expect(actual).toBe(recorded)
})

test('reports what the allow cap dropped instead of truncating silently', () => {
  const { stdout } = build()
  expect(stdout).toContain('available')
  expect(stdout).toMatch(/dropped by the per-tool cap/)
})

test('carries the caveat that allow cases are not per-call verdicts', () => {
  const { body } = build()
  expect(body.allowCaseCaveat).toContain('not that the classifier passed')
})

test('a torn line does not abort the transcript', () => {
  const root = fixture()
  writeFileSync(
    join(root, '-Users-pt-cat-code', 'torn.jsonl'),
    '{"message":{"content":[{"type":"tool_use"\n',
  )
  const out = join(root, 'torn-out.json')
  expect(run(root, out).code).toBe(0)
  expect(JSON.parse(readFileSync(out, 'utf-8')).cases.length).toBeGreaterThan(0)
})

test('rejects missing roots without replacing the existing corpus', () => {
  const root = fixture()
  const out = join(root, 'existing.json')
  const sha = out.replace(/\.json$/, '.sha256')
  writeFileSync(out, 'original corpus')
  writeFileSync(sha, 'original checksum')

  const result = run(join(root, 'missing'), out)

  expect(result.code).not.toBe(0)
  expect(readFileSync(out, 'utf-8')).toBe('original corpus')
  expect(readFileSync(sha, 'utf-8')).toBe('original checksum')
})

test('rejects missing and invalid allow caps before writing output', () => {
  const root = fixture()
  const out = join(root, 'corpus.json')
  for (const args of [
    ['--max-allow'],
    ['--max-allow', '0'],
    ['--max-allow', '-1'],
    ['--max-allow', '1.5'],
    ['--max-allow', 'NaN'],
  ]) {
    const p = Bun.spawnSync([
      'bun',
      'run',
      SCRIPT,
      '--root',
      root,
      '--out',
      out,
      ...args,
    ])
    expect(p.exitCode).not.toBe(0)
  }
  expect(() => readFileSync(out, 'utf-8')).toThrow()
})
