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
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { getAutoModeCaptureDir } from '../src/utils/envUtils.js'

type Arguments = {
  root?: string
  out?: string
  verify: boolean
}

function parseArguments(args: string[]): Arguments {
  const parsed: Arguments = { verify: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--verify') {
      if (parsed.verify) throw new Error('--verify may only be specified once')
      parsed.verify = true
      continue
    }
    if (argument !== '--root' && argument !== '--out') {
      throw new Error(`unknown argument: ${argument}`)
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`)
    }
    const key = argument.slice(2) as 'root' | 'out'
    if (parsed[key] !== undefined) throw new Error(`${argument} may only be specified once`)
    parsed[key] = value
    index += 1
  }
  return parsed
}

const args = parseArguments(process.argv.slice(2))
const ROOT = args.root ?? getAutoModeCaptureDir()
const OUT = args.out ?? 'fixtures/auto-mode-corpus.json'
const VERIFY = args.verify

type Capture = { path: string; sha256: string }
type CorpusCase = { id: string; request: Capture; response: Capture }
type Corpus = { schema: 2; purpose: string; captureRoot: string; cases: CorpusCase[] }

const MANIFEST_SUFFIX = '.json'
const CHECKSUM_SUFFIX = '.sha256'
const REQUEST_SUFFIX = '.req.json'
const RESPONSE_SUFFIX = '.res.json'
const SHA256 = /^[a-f0-9]{64}$/

function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function checksumPath(out: string): string {
  if (!out.endsWith(MANIFEST_SUFFIX)) {
    throw new Error(`corpus manifest must end with ${MANIFEST_SUFFIX}: ${out}`)
  }
  return `${out.slice(0, -MANIFEST_SUFFIX.length)}${CHECKSUM_SUFFIX}`
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateCapture(value: unknown, kind: 'request' | 'response', id: string): Capture {
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.sha256 !== 'string') {
    throw new Error(`invalid ${kind} capture for case ${id}`)
  }
  const suffix = kind === 'request' ? REQUEST_SUFFIX : RESPONSE_SUFFIX
  if (!value.path.endsWith(suffix)) {
    throw new Error(`${kind} capture has invalid suffix for case ${id}: ${value.path}`)
  }
  if (!SHA256.test(value.sha256)) {
    throw new Error(`invalid ${kind} capture digest for case ${id}`)
  }
  return { path: value.path, sha256: value.sha256 }
}

function validateCapturePath(root: string, capture: Capture): string {
  if (isAbsolute(capture.path)) {
    throw new Error(`capture path must be relative: ${capture.path}`)
  }
  const path = resolve(root, capture.path)
  if (path !== resolve(root) && !path.startsWith(`${resolve(root)}/`)) {
    throw new Error(`capture path escapes root: ${capture.path}`)
  }
  return path
}

function verifyCapture(root: string, capture: Capture): void {
  const path = validateCapturePath(root, capture)
  if (digest(path) !== capture.sha256) {
    throw new Error(`capture digest mismatch: ${capture.path}`)
  }
}

function validateCorpus(value: unknown): Corpus {
  if (!isRecord(value) || value.schema !== 2 || typeof value.purpose !== 'string' || value.purpose.length === 0
    || typeof value.captureRoot !== 'string' || value.captureRoot.length === 0 || !Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error('invalid corpus manifest')
  }
  const ids = new Set<string>()
  const cases: CorpusCase[] = value.cases.map(entry => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new Error('invalid corpus case')
    }
    if (ids.has(entry.id)) throw new Error(`duplicate corpus case id: ${entry.id}`)
    ids.add(entry.id)
    const request = validateCapture(entry.request, 'request', entry.id)
    const response = validateCapture(entry.response, 'response', entry.id)
    if (request.path.slice(0, -REQUEST_SUFFIX.length) !== entry.id
      || response.path.slice(0, -RESPONSE_SUFFIX.length) !== entry.id) {
      throw new Error(`capture paths do not match case id: ${entry.id}`)
    }
    return { id: entry.id, request, response }
  })
  return { schema: 2, purpose: value.purpose, captureRoot: value.captureRoot, cases }
}

function verifyChecksum(out: string, text: string): void {
  const checksum = readFileSync(checksumPath(out), 'utf-8')
  const match = /^([a-f0-9]{64})  ([^\r\n/]+)\n?$/.exec(checksum)
  if (match === null || match[2] !== out.split('/').pop()) {
    throw new Error(`invalid corpus checksum manifest: ${checksumPath(out)}`)
  }
  const actual = createHash('sha256').update(text).digest('hex')
  if (actual !== match[1]) throw new Error(`corpus checksum mismatch: ${out}`)
}

function verifyCorpus(root: string, value: unknown): Corpus {
  const corpus = validateCorpus(value)
  for (const entry of corpus.cases) {
    verifyCapture(root, entry.request)
    verifyCapture(root, entry.response)
  }
  return corpus
}

if (VERIFY) {
  checksumPath(OUT)
  const text = readFileSync(OUT, 'utf-8')
  verifyChecksum(OUT, text)
  const corpus = JSON.parse(text) as unknown
  console.log(`verified ${verifyCorpus(ROOT, corpus).cases.length} capture pairs`)
  process.exit(0)
}

checksumPath(OUT)
const requests = [...walk(ROOT)].filter(path => path.endsWith(REQUEST_SUFFIX)).sort()
const cases = requests.map(request => {
  const response = request.replace(/\.req\.json$/, RESPONSE_SUFFIX)
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
const shaPath = checksumPath(OUT)
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(`${OUT}.tmp-${process.pid}`, text)
writeFileSync(`${shaPath}.tmp-${process.pid}`, `${sha256}  ${OUT.split('/').pop()}\n`)
renameSync(`${OUT}.tmp-${process.pid}`, OUT)
renameSync(`${shaPath}.tmp-${process.pid}`, shaPath)
console.log(`wrote ${OUT} with ${cases.length} capture pairs`)
