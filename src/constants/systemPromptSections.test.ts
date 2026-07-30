import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearSystemPromptSections,
  DANGEROUS_uncachedSystemPromptSection,
  NO_SECTION_INPUTS,
  resolveSystemPromptSections,
  type SectionKeyInput,
  systemPromptSection,
  _forTest,
} from './systemPromptSections.js'

const { encodeKeyInput, sectionCacheKey } = _forTest

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

  test('an uncached section leaves nothing a cached section can read back', async () => {
    // Same name, no key inputs on either side, so both land on one key. The
    // volatile section must not seed a value the cached one then serves.
    await resolveSystemPromptSections([
      DANGEROUS_uncachedSystemPromptSection(
        'mcp_instructions',
        () => 'volatile value',
        'MCP servers connect/disconnect between turns',
      ),
    ])

    const [resolved] = await resolveSystemPromptSections([
      systemPromptSection(
        'mcp_instructions',
        NO_SECTION_INPUTS,
        () => 'computed value',
      ),
    ])
    expect(resolved).toBe('computed value')
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

  test('a section name containing the separator still gets its own entry', () => {
    // Without the length prefix, ('a', 'ab#z') and ('a#s4:ab', null) both
    // encode to "a#s4:ab#z" and share one entry.
    expect(sectionCacheKey('a', 'ab#z')).not.toBe(
      sectionCacheKey('a#s4:ab', null),
    )
  })

  test('randomly generated input trees collide only when deeply equal', () => {
    // The hand-picked cases above are a spot check; this is the property. A
    // collision here means one section's text served under another's inputs.
    const rand = (n: number) => Math.floor(Math.random() * n)
    const makeTree = (depth: number): SectionKeyInput => {
      switch (rand(depth > 0 ? 7 : 5)) {
        case 0:
          return ['', 'a', 'ab', 'a:b', 'a#z', '{}', '[]'][rand(7)]!
        case 1:
          return rand(3)
        case 2:
          return rand(2) === 0
        case 3:
          return null
        case 4:
          return undefined
        case 5:
          return Array.from({ length: rand(3) }, () => makeTree(depth - 1))
        default: {
          const fields: { [field: string]: SectionKeyInput } = {}
          for (let i = 0; i < rand(3); i++) {
            fields[['a', 'b', 'ab', 'a:b'][rand(4)]!] = makeTree(depth - 1)
          }
          return fields
        }
      }
    }
    // Canonical form: sorted fields, undefined fields dropped. Two trees that
    // share a canonical form are meant to share an encoding.
    const canonical = (value: SectionKeyInput): string => {
      if (value === null || typeof value !== 'object') {
        return `${typeof value}:${String(value)}`
      }
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
      return `{${Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${canonical(v)}`)
        .join(',')}}`
    }

    const seen = new Map<string, string>()
    for (let i = 0; i < 20000; i++) {
      const tree = makeTree(3)
      const encoded = encodeKeyInput(tree)
      const form = canonical(tree)
      const previous = seen.get(encoded)
      if (previous === undefined) seen.set(encoded, form)
      else expect(previous).toBe(form)
    }
  })

  test('the module source carries no NUL byte', async () => {
    // A literal NUL makes git classify this file binary and makes `rg` skip it
    // during directory traversal, so it vanishes from searches with no warning.
    const source = await Bun.file(
      new URL('./systemPromptSections.ts', import.meta.url).pathname,
    ).bytes()
    expect(source.includes(0)).toBe(false)
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
