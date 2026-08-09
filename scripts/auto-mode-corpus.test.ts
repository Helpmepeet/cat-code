import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'auto-mode-corpus.ts')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture(): { root: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'captures-'))
  dirs.push(root)
  writeFileSync(join(root, '1.req.json'), '{"messages":["exact action"]}')
  writeFileSync(join(root, '1.res.json'), '{"content":["exact verdict"]}')
  return { root, out: join(root, 'corpus.json') }
}
function run(root: string, out: string, ...extra: string[]) {
  return Bun.spawnSync(['bun', 'run', SCRIPT, '--root', root, '--out', out, ...extra])
}

function checksumPath(out: string): string {
  return `${out.slice(0, -'.json'.length)}.sha256`
}

function writeChecksum(out: string, text: string): void {
  writeFileSync(
    checksumPath(out),
    `${createHash('sha256').update(text).digest('hex')}  ${out.split('/').pop()}\n`,
  )
}

function writeManifest(out: string, corpus: unknown): void {
  const text = `${JSON.stringify(corpus, null, 2)}\n`
  writeFileSync(out, text)
  writeChecksum(out, text)
}

test('freezes exact capture references by relative path and content hash', () => {
  const { root, out } = fixture()
  expect(run(root, out).exitCode).toBe(0)
  const corpus = JSON.parse(readFileSync(out, 'utf-8'))
  expect(corpus.schema).toBe(2)
  expect(corpus.cases).toEqual([{ id: '1', request: { path: '1.req.json', sha256: expect.any(String) }, response: { path: '1.res.json', sha256: expect.any(String) } }])
  expect(run(root, out, '--verify').exitCode).toBe(0)
})

test('fails loudly when a referenced capture is missing without invalidating the corpus hash', () => {
  const { root, out } = fixture()
  expect(run(root, out).exitCode).toBe(0)
  const before = readFileSync(out, 'utf-8')
  rmSync(join(root, '1.res.json'))
  expect(run(root, out, '--verify').exitCode).not.toBe(0)
  expect(readFileSync(out, 'utf-8')).toBe(before)
})

test('rejects incomplete capture pairs before writing output', () => {
  const { root, out } = fixture()
  rmSync(join(root, '1.res.json'))
  expect(run(root, out).exitCode).not.toBe(0)
  expect(() => readFileSync(out)).toThrow()
})

test('rejects unknown arguments without altering existing corpus artifacts', () => {
  const { root, out } = fixture()
  expect(run(root, out).exitCode).toBe(0)
  const beforeCorpus = readFileSync(out, 'utf-8')
  const beforeChecksum = readFileSync(checksumPath(out), 'utf-8')

  expect(run(root, out, '--verfiy').exitCode).not.toBe(0)

  expect(readFileSync(out, 'utf-8')).toBe(beforeCorpus)
  expect(readFileSync(checksumPath(out), 'utf-8')).toBe(beforeChecksum)
})

test('rejects invalid corpus manifests even when their checksums are valid', () => {
  const { root, out } = fixture()
  expect(run(root, out).exitCode).toBe(0)
  const valid = JSON.parse(readFileSync(out, 'utf-8'))
  const invalidManifests = [
    { ...valid, schema: 1 },
    { ...valid, cases: [] },
    { ...valid, cases: [valid.cases[0], valid.cases[0]] },
    { ...valid, cases: [{ id: '1', request: valid.cases[0].request }] },
    { ...valid, cases: [{ ...valid.cases[0], request: { ...valid.cases[0].request, path: '1.txt' } }] },
  ]

  for (const manifest of invalidManifests) {
    writeManifest(out, manifest)
    expect(run(root, out, '--verify').exitCode).not.toBe(0)
  }
})

test('rejects malformed or tampered manifests and capture content', () => {
  const { root, out } = fixture()
  expect(run(root, out).exitCode).toBe(0)
  const malformed = '{not json}\n'
  writeFileSync(out, malformed)
  writeChecksum(out, malformed)
  expect(run(root, out, '--verify').exitCode).not.toBe(0)

  expect(run(root, out).exitCode).toBe(0)
  writeFileSync(out, `${readFileSync(out, 'utf-8')}\n`)
  expect(run(root, out, '--verify').exitCode).not.toBe(0)

  expect(run(root, out).exitCode).toBe(0)
  writeFileSync(join(root, '1.res.json'), '{"content":["tampered verdict"]}')
  expect(run(root, out, '--verify').exitCode).not.toBe(0)
})

test('requires a JSON corpus manifest suffix in both modes', () => {
  const { root, out } = fixture()
  const wrongSuffix = out.replace(/\.json$/, '.txt')

  expect(run(root, wrongSuffix).exitCode).not.toBe(0)
  expect(existsSync(wrongSuffix)).toBe(false)
  expect(run(root, wrongSuffix, '--verify').exitCode).not.toBe(0)
})
