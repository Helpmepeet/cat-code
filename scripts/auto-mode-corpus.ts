#!/usr/bin/env bun
/** Freeze durable exact classifier captures by path and content hash. */
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { getAutoModeCaptureDir } from '../src/utils/envUtils.js'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return value
}

const ROOT = flag('--root') ?? getAutoModeCaptureDir()
const OUT = flag('--out') ?? 'fixtures/auto-mode-corpus.json'
const VERIFY = args.includes('--verify')

type Capture = { path: string; sha256: string }
type CorpusCase = { id: string; request: Capture; response: Capture }
type Corpus = { schema: 2; purpose: string; captureRoot: string; cases: CorpusCase[] }

function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else yield path
  }
}

function capturePath(root: string, path: string): Capture {
  return { path: relative(root, path), sha256: digest(path) }
}

function verifyCapture(root: string, capture: Capture): void {
  const path = join(root, capture.path)
  if (digest(path) !== capture.sha256) {
    throw new Error(`capture digest mismatch: ${capture.path}`)
  }
}

function verifyCorpus(root: string, corpus: Corpus): void {
  for (const entry of corpus.cases) {
    verifyCapture(root, entry.request)
    verifyCapture(root, entry.response)
  }
}

if (VERIFY) {
  const corpus = JSON.parse(readFileSync(OUT, 'utf-8')) as Corpus
  verifyCorpus(ROOT, corpus)
  console.log(`verified ${corpus.cases.length} capture pairs`)
  process.exit(0)
}

const requests = [...walk(ROOT)].filter(path => path.endsWith('.req.json')).sort()
const cases = requests.map(request => {
  const response = request.replace(/\.req\.json$/, '.res.json')
  // readFileSync is intentional: a missing response is a failed corpus build,
  // never a silently reduced replay set.
  readFileSync(response)
  return {
    id: relative(ROOT, request).replace(/\.req\.json$/, ''),
    request: capturePath(ROOT, request),
    response: capturePath(ROOT, response),
  }
})
if (cases.length === 0) throw new Error(`no classifier captures found under ${ROOT}`)

const corpus: Corpus = {
  schema: 2,
  purpose: 'Frozen replay corpus referencing exact local classifier request/response captures by path and SHA-256.',
  captureRoot: ROOT,
  cases,
}
const text = `${JSON.stringify(corpus, null, 2)}\n`
const sha256 = createHash('sha256').update(text).digest('hex')
const shaPath = OUT.replace(/\.json$/, '.sha256')
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(`${OUT}.tmp-${process.pid}`, text)
writeFileSync(`${shaPath}.tmp-${process.pid}`, `${sha256}  ${OUT.split('/').pop()}\n`)
renameSync(`${OUT}.tmp-${process.pid}`, OUT)
renameSync(`${shaPath}.tmp-${process.pid}`, shaPath)
console.log(`wrote ${OUT} with ${cases.length} capture pairs`)
