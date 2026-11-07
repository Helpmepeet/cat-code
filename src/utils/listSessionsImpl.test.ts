import { expect, test } from 'bun:test'
import { parseSessionInfoFromLite } from './listSessionsImpl.js'
import type { LiteSessionFile } from './sessionStoragePortable.js'

const prompt = JSON.stringify({
  type: 'user',
  isSidechain: false,
  cwd: '/work/shop',
  message: { role: 'user', content: 'Help deploy the shop app' },
})
const search = JSON.stringify({
  type: 'user',
  toolUseResult: {
    summary: 'You can run a Gin server on Vercel. '.repeat(100),
    customTitle: 'Tool title',
    aiTitle: 'Tool AI title',
    lastPrompt: 'Tool prompt',
    nested: { type: 'summary', summary: 'Nested tool summary' },
  },
})
const lite = (head: string, tail = head): LiteSessionFile => ({
  head, tail, mtime: 1, size: Buffer.byteLength(head) + Buffer.byteLength(tail),
})

test('SDK session labels fall back to the human prompt, never a search summary', () => {
  const info = parseSessionInfoFromLite('session', lite(`${prompt}\n${search}\n`))
  expect(info?.summary).toBe('Help deploy the shop app')
  expect(info?.customTitle).toBeUndefined()
  expect(parseSessionInfoFromLite('session', lite(search))).toBeNull()
})

test.each([
  ['recorded summary', [{ type: 'summary', summary: 'Deployment options' }], 'Deployment options'],
  ['last prompt', [
    { type: 'last-prompt', lastPrompt: 'What hosting is free?' },
    { type: 'summary', summary: 'Deployment options' },
  ], 'What hosting is free?'],
  ['AI title', [{ type: 'ai-title', aiTitle: 'Shop hosting' }], 'Shop hosting'],
  ['latest custom title', [
    { type: 'custom-title', customTitle: 'Old title' },
    { type: 'custom-title', customTitle: 'New title' },
    { type: 'ai-title', aiTitle: 'Later AI title' },
  ], 'New title'],
] as const)('SDK preserves %s precedence despite later tool payloads', (_name, records, expected) => {
  const tail = [...records.map(entry => JSON.stringify(entry)), search].join('\n')
  expect(parseSessionInfoFromLite('session', lite(prompt, tail))?.summary).toBe(expected)
})

test('a user title retained in the head outranks an AI title in the tail', () => {
  const head = `${prompt}\n${JSON.stringify({ type: 'custom-title', customTitle: 'User title' })}\n`
  const tail = `${JSON.stringify({ type: 'ai-title', aiTitle: 'AI title' })}\n${search}\n`
  expect(parseSessionInfoFromLite('session', lite(head, tail))?.customTitle).toBe('User title')
})
