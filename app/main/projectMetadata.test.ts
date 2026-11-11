import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readProjectMetadata } from './projectMetadata.js'
import type { ProjectMetadata } from '../shared/projectMetadata.js'

let root: string
let directory: string
let path: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'project-metadata-')))
  directory = join(root, '.cat-code')
  path = join(directory, 'project.json')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function raw(value: string | Buffer) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(path, value)
}
function json(value: unknown) { raw(JSON.stringify(value)) }
function rejected() {
  const result = readProjectMetadata(root)
  expect(result.aliases).toEqual([])
  expect(result.description).toBe('')
  expect(result.metadataWarning).toBe('Project metadata could not be read. Check .cat-code/project.json.')
}

describe('optional project metadata', () => {
  test('missing directory or file has no warning', () => {
    expect(readProjectMetadata(root)).toEqual({ aliases: [], description: '' })
    mkdirSync(directory)
    expect(readProjectMetadata(root)).toEqual({ aliases: [], description: '' })
  })
  test('partial and unknown fields are permitted', () => {
    const cases: [unknown, ProjectMetadata][] = [
      [{}, { aliases: [], description: '' }],
      [{ aliases: ['work'], other: { preserved: true } }, { aliases: ['work'], description: '' }],
      [{ description: 'Workspace' }, { aliases: [], description: 'Workspace' }],
    ]
    for (const [input, expected] of cases) {
      json(input)
      expect(readProjectMetadata(root)).toEqual(expected)
    }
  })
  test('normalizes Unicode and whitespace, deduplicating display aliases', () => {
    json({ aliases: ['  Cafe\u0301\t Project ', 'CAFÉ Project', '猫 😺'], description: '  Cafe\u0301\n\t workspace  ' })
    expect(readProjectMetadata(root)).toEqual({ aliases: ['Café Project', '猫 😺'], description: 'Café workspace' })
  })
  test('codepoint limits allow astral characters and boundary values', () => {
    json({ aliases: Array.from({ length: 12 }, (_, i) => `${i}`), description: '😺'.repeat(320) })
    expect(readProjectMetadata(root).metadataWarning).toBeUndefined()
    json({ aliases: ['😺'.repeat(80)] })
    expect(readProjectMetadata(root).aliases).toEqual(['😺'.repeat(80)])
  })
  test('rejects malformed JSON and nonobject payloads', () => {
    for (const value of ['{', 'null', '[]', '"private content"', '42']) { raw(value); rejected() }
  })
  test('rejects unsupported fields, limits and non-whitespace controls atomically', () => {
    for (const value of [
      { aliases: null }, { aliases: 'work' }, { aliases: [1] }, { description: null },
      { description: [] }, { aliases: Array(13).fill('duplicate') },
      { aliases: ['😺'.repeat(81)] }, { description: '😺'.repeat(321) },
      { aliases: [''] }, { aliases: [' \t '] }, { aliases: ['bad\u0000alias'] }, { description: 'bad\u007ftext' },
      { aliases: ['valid'], description: 'bad\u0085text' }, { description: '\ud800' },
    ]) { json(value); rejected() }
  })
  test('strict UTF-8 decoding and byte size bound', () => {
    raw(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])); rejected()
    raw('{}' + ' '.repeat(8190))
    expect(readProjectMetadata(root)).toEqual({ aliases: [], description: '' })
    raw('{}' + ' '.repeat(8191)); rejected()
    json({ description: '猫'.repeat(320) })
    expect(readProjectMetadata(root).description).toBe('猫'.repeat(320))
  })
  test('rejects file symlinks, even inside the root or dangling', () => {
    mkdirSync(directory)
    const target = join(root, 'target.json')
    writeFileSync(target, '{}')
    symlinkSync(target, path); rejected()
    rmSync(path)
    symlinkSync(join(root, 'missing'), path); rejected()
  })
  test('rejects directory symlinks outside the root', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'metadata-outside-')))
    try {
      writeFileSync(join(outside, 'project.json'), '{}')
      symlinkSync(outside, directory); rejected()
    } finally { rmSync(outside, { recursive: true, force: true }) }
  })
  test('rejects directory symlinks inside the root', () => {
    const target = join(root, 'metadata')
    mkdirSync(target)
    writeFileSync(join(target, 'project.json'), '{}')
    symlinkSync(target, directory)
    rejected()
  })
  test.skipIf(process.getuid?.() === 0)('inaccessible files return only a safe warning', () => {
    json({ aliases: ['private'] })
    chmodSync(path, 0)
    try { rejected() } finally { chmodSync(path, 0o600) }
  })
  test('rejects non-directory parents and non-regular files without blocking', () => {
    writeFileSync(directory, 'not a directory'); rejected()
    rmSync(directory)
    mkdirSync(path, { recursive: true }); rejected()
    rmSync(path, { recursive: true })
    const result = spawnSync('mkfifo', [path])
    expect(result.status).toBe(0)
    rejected()
  })
})
