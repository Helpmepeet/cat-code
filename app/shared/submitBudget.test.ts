import { describe, expect, test } from 'bun:test'
import { MAX_SUBMIT_IMAGE_BYTES, MAX_SUBMIT_TEXT_BYTES } from '../../src/app-runtime/appSubmitLimits.js'
import { MAX_FRAME_BYTES, MAX_SUBMIT_FRAME_BYTES, MAX_QUEUED_PROMPT_BYTES } from './limits.js'
import { isImageSubmitPrompt, submitPromptSerializedBytes, validateSubmitPromptBudget } from './submitBudget.js'

const image = (data = 'AAAA') => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })
const text = (value: string) => ({ type: 'text', text: value })

describe('submit budgets', () => {
  test('preserves two MiB-scale images and the independent full text budget', () => {
    const prompt = [image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES)), image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES)), text('\u0000'.repeat(MAX_SUBMIT_TEXT_BYTES))]
    expect(validateSubmitPromptBudget(prompt)).toBeNull()
    expect(isImageSubmitPrompt(prompt)).toBe(true)
    expect(submitPromptSerializedBytes(prompt) + 64 * 1024).toBeLessThan(MAX_SUBMIT_FRAME_BYTES)
    expect(MAX_FRAME_BYTES).toBe(128 * 1024)
    expect(MAX_QUEUED_PROMPT_BYTES).toBe(24 * 1024 * 1024)
  })

  test('allows five images with accompanying text', () => {
    const prompt = [...Array.from({ length: 5 }, () => image()), text('Describe these.')]
    expect(validateSubmitPromptBudget(prompt)).toBeNull()
  })

  test('rejects invalid shapes, encodings, counts and independent budgets at both boundaries', () => {
    const invalid: unknown[] = [
      [image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES + 4))],
      [image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES)), image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES)), image()],
      Array.from({ length: 6 }, () => image()),
      '界'.repeat(MAX_SUBMIT_TEXT_BYTES / 3 + 1),
      [image(), text('界'.repeat(MAX_SUBMIT_TEXT_BYTES / 3)), text('x')],
      [image(), text('x'.repeat(MAX_SUBMIT_TEXT_BYTES + 1))],
      [text('text only')],
      [image('not base64!')], [image('AA=A')], [image('A===')], [image('AAA')], [image('')],
      [{ ...image(), extra: 'x'.repeat(1024 * 1024) }],
      [{ type: 'image', source: { ...image().source, extra: 'x'.repeat(1024 * 1024) } }],
      [{ type: 'image', source: { ...image().source, media_type: 'x'.repeat(1024 * 1024) } }],
      [image(), { ...text('x'), extra: true }],
      [image(), { type: 'audio', data: 'AAAA' }], null, {}, [], '',
    ]
    for (const prompt of invalid) {
      expect(validateSubmitPromptBudget(prompt)).not.toBeNull()
    }
  })

  test('accepts standard padding without recursion on long malformed data', () => {
    for (const data of ['AAAA', 'AA==', 'AAA=']) expect(validateSubmitPromptBudget([image(data)])).toBeNull()
    expect(validateSubmitPromptBudget([image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES - 1) + '!')])).not.toBeNull()
  })

  test('measures serialized UTF-8 and handles unserializable unknown input', () => {
    expect(submitPromptSerializedBytes('界')).toBe(5)
    expect(submitPromptSerializedBytes('\u0000')).toBe(8)
    expect(submitPromptSerializedBytes(undefined)).toBe(Infinity)
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expect(submitPromptSerializedBytes(cyclic)).toBe(Infinity)
    expect(isImageSubmitPrompt('hello')).toBe(false)
    expect(isImageSubmitPrompt([null, text('hello')])).toBe(false)
  })
})
