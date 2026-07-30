import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearSystemPromptSections,
  DANGEROUS_uncachedSystemPromptSection,
  NO_SECTION_INPUTS,
  resolveSystemPromptSections,
  systemPromptSection,
  _forTest,
} from './systemPromptSections.js'

const { encodeKeyInput } = _forTest

afterEach(() => {
  clearSystemPromptSections()
})

describe('section cache keying', () => {
  test('two argument sets under one section name produce two entries', async () => {
    let computes = 0
    const build = (model: string) =>
      resolveSystemPromptSections([
        systemPromptSection('env_info_simple', { model }, () => {
          computes++
          return `provider for ${model}`
        }),
      ])

    expect(await build('claude-opus-5')).toEqual([
      'provider for claude-opus-5',
    ])
    expect(await build('gpt-5.6-terra')).toEqual(['provider for gpt-5.6-terra'])
    expect(computes).toBe(2)
  })

  test('the same argument set is served from cache', async () => {
    let computes = 0
    const build = () =>
      resolveSystemPromptSections([
        systemPromptSection('frc', { model: 'claude-opus-5' }, () => {
          computes++
          return 'frc text'
        }),
      ])

    await build()
    await build()
    expect(computes).toBe(1)
  })

  test('a section declaring no inputs stays shared across builds', async () => {
    let computes = 0
    const build = () =>
      resolveSystemPromptSections([
        systemPromptSection('language', NO_SECTION_INPUTS, () => {
          computes++
          return '# Language'
        }),
      ])

    await build()
    await build()
    expect(computes).toBe(1)
  })

  test('a cached null result is not recomputed', async () => {
    let computes = 0
    const build = () =>
      resolveSystemPromptSections([
        systemPromptSection('ant_model_override', NO_SECTION_INPUTS, () => {
          computes++
          return null
        }),
      ])

    expect(await build()).toEqual([null])
    expect(await build()).toEqual([null])
    expect(computes).toBe(1)
  })

  test('an uncached section still recomputes on every build', async () => {
    let computes = 0
    const build = () =>
      resolveSystemPromptSections([
        DANGEROUS_uncachedSystemPromptSection(
          'mcp_instructions',
          () => {
            computes++
            return `instructions ${computes}`
          },
          'MCP servers connect/disconnect between turns',
        ),
      ])

    expect(await build()).toEqual(['instructions 1'])
    expect(await build()).toEqual(['instructions 2'])
  })

  test('clearing drops keyed entries', async () => {
    let computes = 0
    const build = () =>
      resolveSystemPromptSections([
        systemPromptSection('memory', NO_SECTION_INPUTS, () => {
          computes++
          return 'memory'
        }),
      ])

    await build()
    clearSystemPromptSections()
    await build()
    expect(computes).toBe(2)
  })
})

describe('key encoding', () => {
  test('distinct input trees never encode alike', () => {
    const encodings = [
      encodeKeyInput({ a: 'b' }),
      encodeKeyInput({ ab: '' }),
      encodeKeyInput({ a: 'b', c: '' }),
      encodeKeyInput(['a', 'b']),
      encodeKeyInput(['ab']),
      encodeKeyInput(['a:b']),
      encodeKeyInput(null),
      encodeKeyInput(undefined),
      encodeKeyInput([]),
      encodeKeyInput(''),
      encodeKeyInput(0),
      encodeKeyInput(false),
    ]
    expect(new Set(encodings).size).toBe(encodings.length)
  })

  test('field order does not change the encoding', () => {
    expect(encodeKeyInput({ gpt: true, model: 'x' })).toBe(
      encodeKeyInput({ model: 'x', gpt: true }),
    )
  })

  test('an absent optional field encodes like an explicit undefined', () => {
    expect(encodeKeyInput({ model: 'x' })).toBe(
      encodeKeyInput({ model: 'x', additionalWorkingDirectories: undefined }),
    )
  })
})
