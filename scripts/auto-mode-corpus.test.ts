import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
